const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('../../config/config');
const storage = require('../storage');
const { MonitorHealth, describeHttpError } = require('./monitor-health');
const { ProxyPool } = require('./proxy-pool');
const { SeenStore } = require('../storage/seen-store');
const path = require('path');

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
};

const WS_PING_INTERVAL_MS = 30000;
const WS_RECONNECT_MIN_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
const WS_BANNED_RECONNECT_MS = 60000;
const MIN_BURST_INTERVAL_MS = 50;
// Quote markets in Upbit titles, never the listed asset.
const UPBIT_MARKET_CODES = new Set(['KRW', 'BTC', 'USDT']);

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Upbit Announcements Monitor
 *
 * Two sources feed the same pipeline:
 *  - REST polling (hedged over several os/category variants)
 *  - Private WebSocket `announcement` stream (push, needs API key)
 * Both are de-duplicated by notice uuid (and title+first_listed_at as a fallback key),
 * so whichever source sees a notice first wins and the other one is ignored.
 */

class UpbitMonitor {
    constructor() {
        this.config = config.exchanges.upbit;
        // Persisted across restarts (data/seen_upbit.json)
        this.seenStore = new SeenStore(path.join(__dirname, '../../', config.storage.seenUpbitFile));
        this.seenKeys = this.seenStore.set;
        this.restBaselined = false;
        this.pool = new ProxyPool(this.config.proxies, {
            minIntervalMs: this.config.perIpMinIntervalMs,
            backoffMs: this.config.rateLimitBackoffMs,
            headers: REQUEST_HEADERS,
            timeout: 3000
        });
        this.health = new MonitorHealth('UPBIT');
        this.wsHealth = new MonitorHealth('UPBIT-WS');
        this.ws = null;
        this.wsConnected = false;
    }

    // ==================== DEDUP ====================

    _seenKeysOf(notice) {
        const keys = [];
        if (notice.uuid) keys.push(`uuid:${notice.uuid}`);
        if (notice.title && notice.first_listed_at) keys.push(`t:${notice.title}|${notice.first_listed_at}`);
        if (keys.length === 0 && notice.id) keys.push(`id:${notice.id}`);
        return keys;
    }

    _isSeen(notice) {
        return this._seenKeysOf(notice).some(key => this.seenKeys.has(key));
    }

    _markSeen(notice) {
        // store first: seenKeys is normally the store's own Set, and add() only schedules a
        // save for keys it has not seen yet.
        this._seenKeysOf(notice).forEach(key => {
            this.seenStore.add(key);
            this.seenKeys.add(key);
        });
    }

    // Legacy REST hash (kept unchanged so existing storage files still de-dup).
    _restHash(notice) {
        return crypto.createHash('md5').update(`UPBIT-${notice.id}-${notice.listed_at}`).digest('hex');
    }

    // WebSocket messages carry uuid but not the REST numeric id.
    _uuidHash(notice) {
        return notice.uuid ? crypto.createHash('md5').update(`UPBIT-UUID-${notice.uuid}`).digest('hex') : null;
    }

    _isStored(notice) {
        const uuidHash = this._uuidHash(notice);
        if (uuidHash && storage.has(uuidHash, 'UPBIT')) return true;
        return notice.id !== undefined && storage.has(this._restHash(notice), 'UPBIT');
    }

    // ==================== REST ====================

    /**
     * The API sits behind Cloudflare with `cache-control: max-age=1`, and unknown query
     * params (`_`, `nonce`, ...) are ignored in the cache key, so a timestamp cache-bust
     * still gets a HIT up to 1s old. Only real params change the key: rotating
     * os × per_page gives a key nobody requested within the last second → fresh from origin.
     */
    _nextFreshVariant() {
        const oses = ['web', 'android', 'ios'];
        const perPageMin = 3;
        const perPageSpan = 18; // per_page 3..20
        const i = this.variantCounter = ((this.variantCounter || 0) + 1) % (oses.length * perPageSpan);
        return { os: oses[i % oses.length], perPage: perPageMin + Math.floor(i / oses.length) };
    }

    /**
     * `egress` = pool entry (IP) to send through; acquired from the pool when omitted.
     * Returns [] without a request when every IP is busy or cooling down.
     */
    async fetchAnnouncementsFromSource(os = 'web', includeCategory = true, timeout = 1200, perPage = 5, egress = this.pool.acquire()) {
        if (!egress) return [];

        const sourceKey = `${egress.id} ${os}${includeCategory ? '/trade' : '/all'}`;
        const startedAt = Date.now();
        try {
            const categoryPart = includeCategory ? '&category=trade' : '';
            const url = `${this.config.apiUrl}?os=${os}&page=1&per_page=${perPage}${categoryPart}`;

            const response = await egress.client.get(url, { timeout });
            if (!response.data?.success) {
                this.pool.reportError(egress, response.status);
                this.health.error(sourceKey, 'response success=false');
                return [];
            }

            this.pool.reportSuccess(egress, Date.now() - startedAt);
            this.health.success();
            const notices = response.data?.data?.notices || [];
            return notices.map(notice => ({
                ...notice,
                exchange: 'UPBIT',
                title: notice.title,
                url: 'https://upbit.com/notice',
                releaseDate: new Date(notice.listed_at).getTime()
            }));
        } catch (error) {
            // 429 = over limit; 418 = temporarily banned after repeated 429s (ban grows on repeat).
            this.pool.reportError(egress, error?.response?.status);
            this.health.error(sourceKey, describeHttpError(error));
            return [];
        }
    }

    /**
     * Each IP may send at most once per perIpMinIntervalMs, so with N IPs the pool
     * sustains one request every perIpMinIntervalMs / N.
     */
    _autoIntervalMs() {
        return Math.max(MIN_BURST_INTERVAL_MS, Math.ceil(this.config.perIpMinIntervalMs / this.pool.size));
    }

    _burstIntervalMs() {
        return this.config.fastPolling.burstIntervalMs || this._autoIntervalMs();
    }

    /**
     * Uniform polling at the pool's sustainable rate by default. Listings are published at
     * random seconds (only 3/34 recent listings were on :00), so the optional burst window
     * around :00 (UPBIT_BURST_PRE_MS / UPBIT_BURST_POST_MS) is disabled unless configured.
     */
    _nextPollDelay(now = Date.now()) {
        const { burstPreMs, burstPostMs, normalIntervalMs, wsFallbackIntervalMs } = this.config.fastPolling;
        const allCooling = this.pool.allCoolingDown(now);

        // Upbit's Cloudflare rate limit is per IP and tight (429 after a handful of requests,
        // penalty lasts minutes). While the push stream is up, REST is only a safety net.
        if (this.wsConnected) {
            return Math.max(wsFallbackIntervalMs, allCooling ? this.config.rateLimitPollMs : 0);
        }

        const msInMinute = now % 60000;
        const inBurst = msInMinute >= 60000 - burstPreMs || msInMinute < burstPostMs;

        let delay = inBurst ? this._burstIntervalMs() : (normalIntervalMs || this._autoIntervalMs());
        if (!inBurst) {
            // Don't sleep past the start of the next burst window.
            delay = Math.min(delay, Math.max(1, 60000 - burstPreMs - msInMinute));
        }
        if (allCooling) {
            delay = Math.max(delay, this.config.rateLimitPollMs);
        }
        return delay;
    }

    /**
     * Speed-first REST polling: one request per tick on a fixed schedule, without waiting
     * for the previous one (detection latency ≈ interval/2 + RTT instead of interval + RTT).
     * Only `category=trade` is polled: listing, "디지털 자산 추가", delisting and warning
     * notices are all in 거래.
     */
    async startFastPolling(onAnnouncement) {
        if (!this.config.enabled) return;

        // Baseline first (waits for all sources) so stale storage can't re-trade old notices.
        while (!this.restBaselined) {
            const result = await this.check();
            result.announcements.forEach(a => onAnnouncement(a));
            if (!this.restBaselined) await new Promise(r => setTimeout(r, 1000));
        }

        const { maxInFlight, requestTimeoutMs } = this.config.fastPolling;
        let inFlight = 0;

        const tick = () => {
            setTimeout(tick, this._nextPollDelay());
            if (inFlight >= maxInFlight) return;

            const egress = this.pool.acquire();
            if (!egress) return; // every IP busy/cooling: skip rather than overspend one IP

            inFlight++;
            const startedAt = Date.now();
            const variant = this._nextFreshVariant();
            this.fetchAnnouncementsFromSource(variant.os, true, requestTimeoutMs, variant.perPage, egress)
                .then((articles) => {
                    const finishedAt = Date.now();
                    const unseen = this._sortOldestFirst(articles.filter(a => !this._isSeen(a)));
                    for (const article of unseen) {
                        const announcement = this.processAnnouncement(article, 'REST');
                        if (!announcement) continue;

                        announcement._apiCallStartedAt = new Date(startedAt);
                        announcement._apiCallFinishedAt = new Date(finishedAt);
                        announcement._apiFetchMs = finishedAt - startedAt;
                        announcement._apiToDetectMs = announcement.detectedAt - startedAt;
                        this._store(announcement);
                        onAnnouncement(announcement);
                    }
                })
                .catch(error => this.health.error('fastPoll', error.message))
                .finally(() => { inFlight--; });
        };

        tick();
    }

    /**
     * Fire all source variants in parallel. Resolve as soon as any source returns
     * at least one unseen notice (fastest wins); otherwise resolve [] when all are done.
     * Notices only seen by slower sources are picked up on the next poll since they
     * stay in the top-N list and remain unseen.
     */
    async fetchFastestNewArticles(waitAll = false) {
        const sources = [
            { os: 'web', includeCategory: true, timeout: 900 },
            { os: 'android', includeCategory: true, timeout: 900 },
            { os: 'ios', includeCategory: true, timeout: 900 },
            { os: 'web', includeCategory: false, timeout: 1200 }
        ];

        return await new Promise((resolve) => {
            let pending = sources.length;
            let resolved = false;
            const collected = [];

            for (const source of sources) {
                this.fetchAnnouncementsFromSource(source.os, source.includeCategory, source.timeout)
                    .then((articles) => {
                        if (resolved) return;
                        const unseen = articles.filter(a => !this._isSeen(a));
                        if (waitAll) {
                            // Same notice comes back from several sources; keep one copy.
                            for (const article of unseen) {
                                const keys = this._seenKeysOf(article);
                                if (!collected.some(c => this._seenKeysOf(c).some(k => keys.includes(k)))) {
                                    collected.push(article);
                                }
                            }
                        } else if (unseen.length > 0) {
                            resolved = true;
                            resolve(unseen);
                        }
                    })
                    .finally(() => {
                        pending -= 1;
                        if (!resolved && pending === 0) {
                            resolved = true;
                            resolve(collected);
                        }
                    });
            }
        });
    }

    _sortOldestFirst(articles) {
        return articles.sort((a, b) => (new Date(a.listed_at).getTime() || 0) - (new Date(b.listed_at).getTime() || 0)
            || (Number(a.id) || 0) - (Number(b.id) || 0));
    }

    /**
     * Tickers from parenthesized groups:
     *   "페이팔유에스디(PYUSD), 제이피와이코인(JPYC) 신규 거래지원 안내"   → [PYUSD, JPYC]
     *   "BTC, USDT 마켓 신규 거래지원 안내 (BICO, BMT, NIL, GWEI) (...)"  → [BICO, BMT, NIL, GWEI]
     * A group counts only if EVERY comma-separated item is a ticker, so market lists
     * "(KRW, BTC, USDT 마켓)" and notes "(BICO, BMT, NIL 거래지원 개시 시점 변경 안내)" are skipped.
     * Market/quote codes are never returned. No bare-uppercase fallback: it picked "BTC"
     * out of "BTC, USDT 마켓 ..." and would have longed BTCUSDT on an altcoin listing.
     */
    extractTokens(title) {
        const tokens = [];
        for (const match of String(title || '').matchAll(/\(([^()]+)\)/g)) {
            const items = match[1].split(',').map(item => item.trim());
            if (items.length === 0 || !items.every(item => /^[A-Z0-9]{2,15}$/.test(item))) continue;
            tokens.push(...items.filter(item => !UPBIT_MARKET_CODES.has(item)));
        }
        return [...new Set(tokens)];
    }

    categorize(title) {
        // Whitespace-insensitive: WS titles may be spaced differently ("신규 거래 지원 안내").
        const compact = String(title || '').replace(/\s+/g, '');

        // "디지털 자산 추가" = new KRW/USDT market for an asset already on Upbit (e.g. GTC 2026-10-12),
        // pumps like a new listing.
        if (compact.includes('신규거래지원안내') || compact.includes('디지털자산추가')) {
            return 'LISTING';
        }
        if (compact.includes('거래지원종료안내')) {
            return 'DELISTING';
        }
        // Investment warning ("거래 유의 종목 지정"; until late 2024 also "유의 종목 지정" without 거래,
        // e.g. 포튜브(FOR) 2024-10-29). Lifting (해제) is GOOD news and an
        // extension (기간 연장) is not a fresh signal — never treat them as WARNING (= short).
        if (compact.includes('유의종목지정')) {
            if (compact.includes('해제')) return 'WARNING_LIFTED';
            if (compact.includes('연장')) return 'WARNING_EXTENDED';
            return 'WARNING';
        }
        // "유의 촉구" (caution urged): backtest showed no edge (2026-10-13) — alert only.
        if (compact.includes('유의촉구')) {
            return 'CAUTION';
        }

        return 'OTHER';
    }

    /**
     * Synchronous on purpose: REST and WS can deliver the same notice concurrently,
     * marking it seen before any await guarantees it is processed only once.
     */
    processAnnouncement(article, source = 'REST') {
        if (this._isSeen(article)) return null;
        this._markSeen(article);

        if (this._isStored(article)) return null;

        const { title, listed_at } = article;
        const category = this.categorize(title);

        if (!['LISTING', 'DELISTING', 'WARNING', 'WARNING_LIFTED', 'WARNING_EXTENDED', 'CAUTION'].includes(category)) {
            return null;
        }

        const hash = article.id !== undefined ? this._restHash(article) : this._uuidHash(article);
        const url = article.url || 'https://upbit.com/notice';

        const tokens = this.extractTokens(title);
        const token = tokens[0] || null;

        // Original publication time: listed_at moves when Upbit edits a notice (KAIA: first
        // 17:06:46, listed_at 18:23:09) and must not make an old notice look fresh.
        const publishedAt = article.first_listed_at || listed_at;
        const releaseDate = typeof publishedAt === 'number' ? publishedAt : new Date(publishedAt).getTime();
        const formattedDate = new Date(publishedAt).toLocaleString('en-US', {
            timeZone: 'Asia/Seoul',
            hour12: false
        }) + ' (KST)';

        // Prepare metadata for storage with millisecond precision
        const detectionTime = Date.now();
        const symbol = token ? `${token}USDT` : null;

        const metadata = {
            symbol,
            title,
            link: url,
            exchange: 'UPBIT',
            detectedAt: detectionTime,
            orderedAt: null,
            latency: null
        };

        return {
            hash,
            exchange: 'UPBIT',
            category,
            title,
            url,
            symbol,
            releaseDate,
            tokens,
            formattedDate,
            metadata,
            detectedAt: detectionTime,
            _source: source,
            _detectionTime: new Date(detectionTime),
            // Candidates only; the trader decides per AUTO_TRADE_UPBIT_* flags.
            _shouldTrade: ['LISTING', 'DELISTING', 'WARNING'].includes(category)
        };
    }

    _store(announcement) {
        storage.add(announcement.hash, announcement.metadata, 'UPBIT');
        storage.saveUpbit().catch(() => {});
    }

    async check() {
        const empty = { processed: 0, sent: 0, announcements: [], announcement: null, latestAnnouncement: null };
        if (!this.config.enabled) {
            return empty;
        }

        const announcements = [];
        let processed = 0;

        try {
            const apiCallStartedAtMs = Date.now();
            let articles = await this.fetchFastestNewArticles(!this.restBaselined);
            const apiCallFinishedAtMs = Date.now();

            if (articles.length === 0) {
                return empty;
            }

            // Oldest first so multiple notices between polls are handled in publish order.
            this._sortOldestFirst(articles);

            // First successful poll: only the newest notice is a candidate (same as before);
            // older ones are baselined, otherwise a stale storage file would re-trade old listings.
            if (!this.restBaselined) {
                this.restBaselined = true;
                articles.slice(0, -1).forEach(a => this._markSeen(a));
                articles = articles.slice(-1);
            }

            for (const article of articles) {
                processed++;
                const announcement = this.processAnnouncement(article, 'REST');
                if (!announcement) continue;

                announcement._apiCallStartedAt = new Date(apiCallStartedAtMs);
                announcement._apiCallFinishedAt = new Date(apiCallFinishedAtMs);
                announcement._apiFetchMs = apiCallFinishedAtMs - apiCallStartedAtMs;
                announcement._apiToDetectMs = announcement.detectedAt - apiCallStartedAtMs;

                this._store(announcement);
                announcements.push(announcement);
            }
        } catch (error) {
            this.health.error('check', error.message);
        }

        const latestAnnouncement = announcements[announcements.length - 1] || null;
        const latestListing = [...announcements].reverse().find(a => a._shouldTrade) || null;
        return { processed, sent: announcements.length, announcements, announcement: latestListing, latestAnnouncement };
    }

    // ==================== WEBSOCKET ====================

    _createJwt() {
        const header = base64url(JSON.stringify({ alg: 'HS512', typ: 'JWT' }));
        const payload = base64url(JSON.stringify({
            access_key: this.config.accessKey,
            nonce: crypto.randomUUID ? crypto.randomUUID() : require('uuid').v4()
        }));
        const signature = crypto
            .createHmac('sha512', this.config.secretKey)
            .update(`${header}.${payload}`)
            .digest('base64')
            .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
        return `${header}.${payload}.${signature}`;
    }

    /**
     * Subscribe to the private `announcement` stream and call onAnnouncement for every
     * new (CREATED) notice that passes categorization. Reconnects with backoff.
     * Returns false when WS is disabled or API keys are missing.
     */
    startWebSocket(onAnnouncement) {
        if (!this.config.enabled || !this.config.wsEnabled) return false;
        if (!this.config.accessKey || !this.config.secretKey) {
            console.log('ℹ️ [UPBIT-WS] UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY not set, WebSocket announcement stream disabled (REST polling only)');
            return false;
        }

        let reconnectDelay = WS_RECONNECT_MIN_MS;
        let pingTimer = null;

        const connect = () => {
            const ws = new WebSocket(this.config.wsUrl, {
                headers: { Authorization: `Bearer ${this._createJwt()}` },
                // Announcements are tiny; skip deflate so each push is not delayed by inflate.
                perMessageDeflate: false
            });
            this.ws = ws;

            // Handshake rejected (401 bad key / IP not registered on the key, 418 banned, ...):
            // log the body, otherwise ws only reports "Unexpected server response: 401".
            ws.on('unexpected-response', (req, res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    this.wsHealth.error(`handshake HTTP ${res.statusCode}`, body.slice(0, 300) || '(empty body)');
                    if (res.statusCode === 418) reconnectDelay = Math.max(reconnectDelay, WS_BANNED_RECONNECT_MS);
                    ws.terminate();
                });
            });

            ws.on('open', () => {
                this.wsConnected = true;
                reconnectDelay = WS_RECONNECT_MIN_MS;
                ws.send(JSON.stringify([
                    { ticket: `announcement-${Date.now()}` },
                    { type: 'announcement', include_body: false },
                    { format: 'DEFAULT' }
                ]));
                pingTimer = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.ping();
                }, WS_PING_INTERVAL_MS);
                console.log('🔌 [UPBIT-WS] Connected, subscribed to announcement stream');
            });

            ws.on('message', (data) => {
                let msg;
                try {
                    msg = JSON.parse(data.toString('utf8'));
                } catch (error) {
                    this.wsHealth.error('parse', error.message);
                    return;
                }

                if (msg.error) {
                    this.wsHealth.error(msg.error.name || 'error', msg.error.message || JSON.stringify(msg.error));
                    return;
                }
                if (msg.type !== 'announcement') return;

                this.wsHealth.success();
                // UPDATED = edit of an existing notice; only new notices are actionable.
                if (msg.event_type !== 'CREATED') return;

                const announcement = this.processAnnouncement({ ...msg, exchange: 'UPBIT' }, 'WS');
                if (!announcement) return;

                announcement._wsTimestamp = msg.timestamp ? new Date(msg.timestamp) : null;
                this._store(announcement);

                try {
                    onAnnouncement(announcement);
                } catch (error) {
                    this.wsHealth.error('handler', error.message);
                }
            });

            ws.on('error', (error) => {
                this.wsHealth.error('socket', error.message);
            });

            ws.on('close', (code, reason) => {
                this.wsConnected = false;
                clearInterval(pingTimer);
                this.wsHealth.error('close', `code=${code} reason=${String(reason || '')} reconnectIn=${reconnectDelay}ms`);
                setTimeout(connect, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_MS);
            });
        };

        connect();
        return true;
    }

    getHealth() {
        return {
            rest: { ...this.health.toJSON(), egress: this.pool.getHealth() },
            ws: this.config.wsEnabled ? { connected: this.wsConnected, ...this.wsHealth.toJSON() } : null
        };
    }
}

module.exports = new UpbitMonitor();
