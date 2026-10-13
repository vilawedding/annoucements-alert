const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const config = require('../../config/config');
const storage = require('../storage');
const { MonitorHealth, describeHttpError } = require('./monitor-health');
const { SeenStore } = require('../storage/seen-store');
const path = require('path');

const BUILD_ID_REFRESH_COOLDOWN_MS = 30000;

const httpClient = axios.create({
    timeout: 2500,
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 100
    })
});

class BithumbMonitor {
    constructor() {
        this.config = config.exchanges.bithumb;
        this.apiUrl = this.config.apiUrl;
        // Persisted across restarts (data/seen_bithumb.json)
        this.seenStore = new SeenStore(path.join(__dirname, '../../', config.storage.seenBithumbFile));
        this.seenIds = this.seenStore.set;
        this.lastCloudflareWarningAt = 0;
        this.lastBuildIdRefreshAt = 0;
        this.preferredProfileIndex = 0;
        this.sessionCookie = this.config.cookie || '';
        this.health = new MonitorHealth('BITHUMB');
    }

    /**
     * The feed URL embeds the Next.js buildId (`/_next/data/<buildId>/notice.json`),
     * which changes on every Bithumb deploy and turns the URL into a 404.
     * Re-read the current buildId from the notice page's __NEXT_DATA__ and rebuild the URL.
     */
    async _refreshBuildId(headers) {
        const now = Date.now();
        if (now - this.lastBuildIdRefreshAt < BUILD_ID_REFRESH_COOLDOWN_MS) return false;
        this.lastBuildIdRefreshAt = now;

        try {
            const response = await httpClient.get(this.config.pageUrl, {
                headers: { ...headers, Accept: 'text/html' },
                timeout: 5000
            });
            const match = String(response.data || '').match(/"buildId"\s*:\s*"([^"]+)"/);
            if (!match) {
                this.health.error('buildId', 'buildId not found in notice page');
                return false;
            }

            const nextUrl = this.apiUrl.replace(/\/_next\/data\/[^/]+\//, `/_next/data/${match[1]}/`);
            if (nextUrl === this.apiUrl) return false;

            console.log(`🔄 [BITHUMB] Next.js buildId changed → ${match[1]}`);
            this.apiUrl = nextUrl;
            return true;
        } catch (error) {
            this.health.error('buildId', describeHttpError(error));
            return false;
        }
    }

    _extractCookiePairs(cookieString = '') {
        return String(cookieString)
            .split(';')
            .map(v => v.trim())
            .filter(v => v.includes('='))
            .filter(v => {
                const key = v.split('=')[0].toLowerCase();
                return key !== 'path' && key !== 'domain' && key !== 'expires' && key !== 'max-age' && key !== 'samesite' && key !== 'secure' && key !== 'httponly';
            });
    }

    _mergeCookieHeader(baseCookie = '', setCookieHeaders = []) {
        const cookieMap = {};

        this._extractCookiePairs(baseCookie).forEach(pair => {
            const idx = pair.indexOf('=');
            const key = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            cookieMap[key] = value;
        });

        (setCookieHeaders || []).forEach(raw => {
            const first = String(raw).split(';')[0].trim();
            if (!first.includes('=')) return;
            const idx = first.indexOf('=');
            const key = first.slice(0, idx).trim();
            const value = first.slice(idx + 1).trim();
            cookieMap[key] = value;
        });

        return Object.entries(cookieMap)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }

    _isCloudflareBlocked(err) {
        const status = err?.response?.status;
        const data = String(err?.response?.data || '');
        return status === 403 && (data.includes('Cloudflare') || data.includes('blocked'));
    }

    _warnCloudflareBlocked() {
        const now = Date.now();
        if (now - this.lastCloudflareWarningAt < 60000) {
            return;
        }
        this.lastCloudflareWarningAt = now;
        console.log('⚠️ [BITHUMB] Cloudflare 403 block from server IP. If browser works but bot fails, set BITHUMB_COOKIE (full cookie string) or BITHUMB_CF_CLEARANCE in .env.');
    }

    async fetchNotices() {
        const profiles = [
            {
                // Match the successful Postman request as close as possible
                headers: {
                    'User-Agent': 'PostmanRuntime/7.51.1',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                }
            },
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
                    'Referer': 'https://feed.bithumb.com/',
                    'Origin': 'https://feed.bithumb.com',
                    'X-Nextjs-Data': '1',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            }
        ];

        let lastErr = null;
        let buildIdRefreshed = false;

        // Try the last profile that worked first, so a Cloudflare-blocked profile
        // doesn't add a wasted round trip to every poll.
        const order = profiles.map((_, i) => (this.preferredProfileIndex + i) % profiles.length);

        for (let k = 0; k < order.length; k++) {
            const profileIndex = order[k];
            const headers = { ...profiles[profileIndex].headers };
            try {
                const cookieHeader = this.sessionCookie
                    || this.config.cookie
                    || (this.config.cfClearance ? `cf_clearance=${this.config.cfClearance}` : '');

                if (cookieHeader) {
                    headers.Cookie = cookieHeader;
                }

                const response = await httpClient.get(this.apiUrl, { headers });

                // Keep latest anti-bot cookies for next polls
                const setCookieHeaders = response?.headers?.['set-cookie'] || [];
                if (setCookieHeaders.length > 0) {
                    this.sessionCookie = this._mergeCookieHeader(headers.Cookie || '', setCookieHeaders);
                }

                const notices = response.data?.pageProps?.noticeList;
                if (!Array.isArray(notices)) {
                    this.health.error('response', 'pageProps.noticeList missing');
                    return [];
                }

                this.preferredProfileIndex = profileIndex;
                this.health.success();
                return notices;
            } catch (err) {
                lastErr = err;
                if (err?.response?.status === 404 && !buildIdRefreshed) {
                    buildIdRefreshed = true;
                    if (await this._refreshBuildId(headers)) {
                        k--; // retry same profile with the new URL
                        continue;
                    }
                }
            }
        }

        if (this._isCloudflareBlocked(lastErr)) {
            this._warnCloudflareBlocked();
        }
        if (lastErr) {
            this.health.error('fetch', describeHttpError(lastErr));
        }
        return [];
    }

    _markSeen(id) {
        // store first: seenIds is normally the store's own Set (see upbit-monitor _markSeen)
        this.seenStore.add(String(id));
        this.seenIds.add(String(id));
    }

    extractToken(title = '') {
        const match = title.match(/\(([A-Z0-9]{2,15})\)/);
        return match ? match[1].toUpperCase() : null;
    }

    categorize(notice) {
        const c1 = String(notice?.categoryName1 || '');
        const title = String(notice?.title || '');

        if (c1.includes('마켓 추가') || title.includes('마켓 추가')) {
            return 'LISTING';
        }
        return 'OTHER';
    }

    processNotice(notice) {
        const listedAtRaw = notice.publicationDateTime || notice.modifyDateTime || '';
        const listedAt = listedAtRaw ? new Date(`${listedAtRaw.replace(' ', 'T')}+09:00`).getTime() : Date.now();
        const hash = crypto.createHash('md5').update(`BITHUMB-${notice.id}-${listedAtRaw}`).digest('hex');

        if (storage.has(hash, 'BITHUMB')) {
            return null;
        }

        const category = this.categorize(notice);
        const token = this.extractToken(notice.title || '');
        const tokens = token ? [token] : [];
        const detectionTime = Date.now();

        const metadata = {
            symbol: token ? `${token}USDT` : '',
            title: notice.title || '',
            link: 'https://www.bithumb.com/customer_support/info_announcement',
            exchange: 'BITHUMB',
            detectedAt: detectionTime,
            orderedAt: null,
            latency: null
        };

        return {
            hash,
            exchange: 'BITHUMB',
            category,
            title: notice.title || '',
            url: metadata.link,
            symbol: metadata.symbol || null,
            releaseDate: listedAt,
            tokens,
            detectedAt: detectionTime,
            metadata,
            _shouldTrade: category === 'LISTING'
        };
    }

    async check() {
        const empty = { processed: 0, sent: 0, announcements: [], announcement: null, latestAnnouncement: null };
        if (!this.config.enabled) {
            return empty;
        }

        const announcements = [];
        let processed = 0;

        try {
            const notices = (await this.fetchNotices()).filter(n => n && n.id);
            if (notices.length === 0) {
                return empty;
            }

            // First successful poll: only the newest notice is a candidate (same as before);
            // older ones are baselined, otherwise an empty storage would re-trade a whole page
            // of old listings on startup.
            if (this.seenIds.size === 0) {
                notices.slice(1).forEach(n => this._markSeen(String(n.id)));
            }

            // Process every unseen notice (not only noticeList[0]): several notices can be
            // published between polls, and the first item may be a pinned one.
            const unseen = notices.filter(n => !this.seenIds.has(String(n.id))).reverse();

            for (const notice of unseen) {
                this._markSeen(String(notice.id));
                processed++;

                const announcement = this.processNotice(notice);
                if (!announcement) continue;

                storage.add(announcement.hash, announcement.metadata, 'BITHUMB');
                announcements.push(announcement);
            }

            if (announcements.length > 0) {
                storage.saveBithumb().catch(() => {});
            }
        } catch (error) {
            this.health.error('check', error.message);
        }

        const latestAnnouncement = announcements[announcements.length - 1] || null;
        return { processed, sent: announcements.length, announcements, announcement: null, latestAnnouncement };
    }

    getHealth() {
        return { ...this.health.toJSON(), apiUrl: this.apiUrl };
    }
}

module.exports = new BithumbMonitor();
