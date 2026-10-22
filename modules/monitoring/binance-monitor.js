const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const https = require('https');
const WebSocket = require('ws');
const config = require('../../config/config');
const storage = require('../storage');
const { MonitorHealth, describeHttpError } = require('./monitor-health');

const LIST_URL = 'https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query';
const ARTICLE_DETAIL_URL = 'https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query';
const BLOCK_TAGS = new Set(['p', 'li', 'tr', 'td', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'br', 'ul', 'ol', 'table']);
// Delist notices the trader may short (see delistScope).
const TRADED_DELIST_SCOPES = new Set(['SPOT', 'FUTURES']);
const CACHE_KEY_VARIANTS = 1000;
const WS_TOPIC = 'com_announcement_en';
const WS_PING_MS = 25000;           // server closes after 60s without a PING
const WS_RECONNECT_MIN_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
const WS_ROTATE_MS = 23 * 3600e3;   // a connection lives 24h at most: reconnect before
const WS_AUTH_RETRY_MS = 5 * 60000;
// Same wording as scripts/report/export-announcements.js (STOCKS)
const TOKENIZED_STOCKS = /\bbstocks?\b|tokenized (securit|stock)|stock trading/i;

const httpClient = axios.create({
    timeout: 5000,
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 100
    }),
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
    }
});

/**
 * Binance Announcements Monitor
 */

class BinanceMonitor {
    constructor() {
        this.config = config.exchanges.binance;
        this.catalogIds = this.config.catalogIds;
        this.catalogNames = this.config.catalogNames;
        this.blacklist = new Set(['USDT', 'FDUSD', 'TUSD', 'USD', 'BTC', 'ETH', 'BNB']);
        this.health = new MonitorHealth('BINANCE');
        this.wsHealth = new MonitorHealth('BINANCE-WS');
        this.wsConnected = false;
    }

    articleHash(article) {
        return crypto.createHash('md5').update(`BINANCE-${article.catalogId}-${article.id}-${article.code}`).digest('hex');
    }
    
    /**
     * The list API sits behind CloudFront with a ~120s TTL (age climbs to ~119s before a
     * refresh, measured 2026-10-13), so a fixed URL can show a new announcement up to 2 minutes
     * late. Unknown params (`_=ts`) are rejected with HTTP 400, but catalogId accepts leading
     * zeros ("048" = 48) and each spelling is a separate cache key: rotating the number of
     * zeros gives a key nobody else requests (CloudFront Miss → served fresh from origin).
     * 1..CACHE_KEY_VARIANTS zeros: a key is reused only after that many polls, far beyond the TTL.
     */
    _freshListUrl(catalogId) {
        this.cacheKeyCounter = ((this.cacheKeyCounter || 0) % CACHE_KEY_VARIANTS) + 1;
        const zeros = '0'.repeat(this.cacheKeyCounter);
        return `${LIST_URL}?type=1&pageNo=1&pageSize=5&catalogId=${zeros}${catalogId}`;
    }

    async fetchAnnouncements(catalogId) {
        try {
            const response = await httpClient.get(this._freshListUrl(catalogId), {
                headers: {
                    'Cache-Control': 'no-cache, no-store, max-age=0',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                },
                timeout: 2000
            });
            
            if (!response.data?.success) {
                this.health.error(`catalog ${catalogId}`, 'response success=false');
            } else {
                this.health.success();
            }

            if (response.data.success && response.data.data?.catalogs?.length > 0) {
                const catalog = response.data.data.catalogs[0];
                return {
                    name: catalog.catalogName,
                    articles: catalog.articles.map(article => ({
                        id: article.id,
                        code: article.code,
                        title: article.title,
                        releaseDate: article.releaseDate,
                        catalogId: catalogId,
                        exchange: 'BINANCE',
                        url: `https://www.binance.com/en/support/announcement/${article.code}`
                    }))
                };
            }
            
            return { name: this.catalogNames[catalogId] || `Catalog ${catalogId}`, articles: [] };
            
        } catch (error) {
            this.health.error(`catalog ${catalogId}`, describeHttpError(error));
            return { name: this.catalogNames[catalogId] || `Catalog ${catalogId}`, articles: [] };
        }
    }
    
    /**
     * Which market a DELISTING notice is about. Only SPOT ("Binance Will Delist X, Y on <date>")
     * and FUTURES (USDⓈ-M perp settlement) moved price enough to short (backtest 2026-10-14, 5u x10:
     * +2.3..2.7u/trade); MARGIN/loan delists (+0.27u, 19-loss streaks) and the rest are alert-only.
     */
    delistScope(title) {
        const t = String(title || '');
        if (/futures|perpetual/i.test(t)) return 'FUTURES';
        if (/margin|loan/i.test(t)) return 'MARGIN';
        if (/\bwill delist\b/i.test(t) && !/alpha|convert|earn|copy trading|\bbots?\b/i.test(t)) return 'SPOT';
        return 'OTHER';
    }

    /**
     * Which market a LISTING notice is about, in the same order as the backtest export's binanceType().
     * Only SPOT ("Binance Will List X (X)", Seed Tag or not) is longed on the perp (2023-2026, 1s candles,
     * x10 SL 5% 60m: +636u over 35 trades); USDⓈ-M launches stopped moving the price in 2026 (Bybit perp,
     * n=26) and HODLer airdrops / Alpha / Pre-Market / launchpool notices are alert-only.
     */
    listingScope(title) {
        const t = String(title || '');
        if (/hodler airdrops?|launchpool|megadrop|launchpad/i.test(t)) return 'OTHER';
        if (/alpha/i.test(t) && !/will list/i.test(t)) return 'OTHER';
        if (/bstocks|tokenized securit|stock trading/i.test(t)) return 'OTHER';
        if (/^binance futures will (launch|list)|perpetual contract|delivery contract/i.test(t)) return 'FUTURES';
        if (/pre-market/i.test(t)) return 'OTHER';
        if (/\bwill list\b/i.test(t)) return 'SPOT';
        return 'OTHER';
    }

    /**
     * USDⓈ-M perp tokens from "2026-10-05 09:00 (UTC): USDⓈ-M PROMPTUSDT, PUMPBTCUSDT and
     * 1000000BOBUSDT Perpetual Contracts". The contract name is kept whole (1000000BOB, so the
     * order goes to 1000000BOBUSDT, not BOBUSDT); COIN-M contracts (APTUSD) are not USDT and are skipped.
     */
    extractPerpTokens(text) {
        const tokens = new Set();
        for (const m of String(text || '').matchAll(/\b([0-9]*[A-Z][A-Z0-9]*?)USDT\b/g)) {
            if (m[1] !== 'USD') tokens.add(m[1]);
        }
        return Array.from(tokens);
    }

    /**
     * Article body from the CMS detail API. The article page itself now answers HTTP 202 with an empty
     * body (bot challenge, seen 2026-10-21), so "Delist Multiple ... Perpetual Contracts" lost its tokens.
     * The body is a JSON node tree: flattened to text, one line per block element.
     */
    async fetchArticleText(articleCode) {
        const { data } = await httpClient.get(`${ARTICLE_DETAIL_URL}?articleCode=${articleCode}`, { timeout: 5000 });
        return this.bodyToText(data?.data?.body);
    }

    /**
     * Announcement body -> text. Binance sends either HTML / plain text, or (CMS detail API, possibly the
     * WebSocket push too: its docs do not say) a JSON node tree {"node":"root","child":[...]}: flattened
     * with one line per block element, which the futures parser needs (one settlement line per date).
     */
    bodyToText(raw) {
        if (!raw) return '';
        const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (!/^\s*\{\s*"node"/.test(str)) return str;
        let tree;
        try {
            tree = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (_) {
            return str;
        }
        const out = [];
        const walk = (node) => {
            if (!node) return;
            if (node.node === 'text') out.push(node.text || '');
            for (const child of node.child || []) walk(child);
            if (BLOCK_TAGS.has(node.tag)) out.push('\n');
        };
        walk(tree);
        return out.join('');
    }

    async parseDelistDetails(articleCode, scope = 'SPOT') {
        try {
            const text = await this.fetchArticleText(articleCode).catch(error => {
                this.health.error('articleDetail', `${articleCode}: ${describeHttpError(error)}`);
                return '';
            });
            if (text) {
                const tokens = this.tokensFromContent(text, scope);
                if (tokens.length > 0) return tokens;
            }

            const url = `https://www.binance.com/en/support/announcement/${articleCode}`;
            
            const response = await httpClient.get(url, {
                timeout: 15000
            });

            const pageHtml = String(response.data || '');
            let content = '';

            const jsonMatch = pageHtml.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
            if (jsonMatch && jsonMatch[1]) {
                try {
                    const json = JSON.parse(jsonMatch[1]);
                    content =
                        json?.props?.pageProps?.article?.content ||
                        json?.props?.pageProps?.data?.article?.content ||
                        '';
                } catch (_) {}
            }

            if (!content) {
                const $page = cheerio.load(pageHtml);
                const contentSelectors = ['.article-body', '.htmlcontent', 'article'];

                for (const selector of contentSelectors) {
                    content = $page(selector).html() || '';
                    if (content) break;
                }
            }

            return this.tokensFromContent(content, scope);
        } catch (error) {
            this.health.error('delistDetails', `${articleCode}: ${describeHttpError(error)}`);
            return [];
        }
    }

    /** Delisted tokens named in an announcement body (HTML or text): article page or WebSocket push. */
    tokensFromContent(content, scope = 'SPOT') {
        try {
            if (!content) return [];
            const tokens = new Set();

            if (scope === 'FUTURES') {
                // Only the dated settlement lines name the delisted contracts; the rest of the page
                // mentions unrelated symbols (examples, other products).
                const lines = cheerio.load(content.replace(/<\/(p|li|tr|div|h\d)>|<br\s*\/?>/gi, '\n')).text().split('\n');
                return this.extractPerpTokens(lines.filter(l => /perpetual/i.test(l) && /\(UTC\)/.test(l)).join('\n'));
            }

            const $ = cheerio.load(content);
            const textContent = $.text().replace(/\s+/g, ' ');
            
            const slashPairs = [...textContent.matchAll(/([A-Z]{2,10})\s*\/\s*(USDT|BUSD|BTC|ETH|BNB|TUSD|FDUSD)/gi)];
            slashPairs.forEach(m => {
                if (m[1] && m[1].length >= 2) tokens.add(m[1].toUpperCase());
            });
            
            const usdtPairs = textContent.match(/([A-Z]{2,10})USDT/gi) || [];
            usdtPairs.forEach(pair => {
                const token = pair.replace('USDT', '');
                if (token.length >= 2) tokens.add(token.toUpperCase());
            });
            
            return Array.from(tokens);
        } catch (error) {
            this.health.error('delistDetails', `content: ${error.message}`);
            return [];
        }
    }

    /**
     * Only wait for the (slow, up to 15s) article page when delisting auto-trade
     * actually needs the tokens; otherwise resolve them in the background so the
     * poll loop is not blocked and listing detection keeps running.
     */
    _needsDelistTokensForTrade(scope) {
        return config.autoTrade.enabled && config.autoTrade.binanceDelisting && TRADED_DELIST_SCOPES.has(scope);
    }

    _resolveDelistTokensInBackground(code, title, scope) {
        this.parseDelistDetails(code, scope)
            .then(tokens => {
                const validTokens = this.filterValidTokens(tokens);
                console.log(`📩 [BINANCE] DELISTING tokens resolved | ${validTokens.length > 0 ? validTokens.join(',') : 'N/A'} | ${title}`);
            })
            .catch(error => this.health.error('delistDetails', error.message));
    }
    
    extractTokens(title) {
        const tokens = new Set();

        const unifiedPattern = /\(([A-Z]{2,10})\)|([A-Z]{2,10})(USDT|BUSD|BTC|ETH|BNB|TUSD|FDUSD)(?![a-z])|([A-Z]{2,10})\s*\/\s*(USDT|BUSD|BTC|ETH|BNB|TUSD|FDUSD)/gi;
        let match;
        while ((match = unifiedPattern.exec(title)) !== null) {
            const token = match[1] || match[2] || match[4];
            if (token) tokens.add(token.toUpperCase());
        }

        // "Binance Will Delist EPIC, QUICK on 2026-10-28": bare uppercase tickers after "Delist",
        // so the trade does not have to wait for the slow article page.
        const delistList = title.match(/\bdelist\s+(.+?)\s+on\s+\d{4}-\d{2}-\d{2}/i);
        if (delistList) {
            for (const part of delistList[1].split(/\s*(?:,|&|\band\b)\s*/i)) {
                if (/^[A-Z0-9]{2,10}$/.test(part.trim())) tokens.add(part.trim());
            }
        }

        return Array.from(tokens);
    }

    filterValidTokens(tokens) {
        return Array.from(new Set(tokens))
            .map(t => String(t || '').toUpperCase().trim())
            // Multiplier perps are longer: 1000000BABYDOGE
            .filter(t => t.length >= 2 && (t.length <= 10 || (/^\d+[A-Z]/.test(t) && t.length <= 16)))
            .filter(t => !this.blacklist.has(t));
    }

    generateSignals(tokens, category) {
        const side = category === 'DELISTING' ? 'SELL' : 'BUY';
        const signalType = category === 'DELISTING' ? 'DELISTING_SIGNAL' : 'LISTING_SIGNAL';

        return tokens.map(token => ({
            token,
            symbol: `${token}USDT`,
            side,
            type: signalType
        }));
    }
    
    categorize(title, catalogId) {
        const lowerTitle = title.toLowerCase();
        
        if (catalogId === 48) {
            if (lowerTitle.includes('list') || lowerTitle.includes('listing')) {
                return 'LISTING';
            }
            if (lowerTitle.includes('add') && lowerTitle.includes('pairs')) {
                return 'NEW_PAIRS';
            }
            return 'LISTING_RELATED';
        }
        
        if (catalogId === 161) {
            if (lowerTitle.includes('delist') || lowerTitle.includes('removal')) {
                return 'DELISTING';
            }
            return 'DELISTING_RELATED';
        }
        
        return 'OTHER';
    }
    
    async processAnnouncement(article, hash = this.articleHash(article)) {
        const { code, title, releaseDate, url, catalogId } = article;
        
        if (storage.has(hash, 'BINANCE')) {
            return null;
        }
        
        const category = this.categorize(title, catalogId);
        if (!['LISTING', 'NEW_PAIRS', 'DELISTING'].includes(category)) {
            return null;
        }
        // Tokenized stocks / ETFs ("... bStocks Trading Pairs on Binance Spot/Convert"): the tickers are
        // stocks, not alts with a perp to trade; neither alerted nor traded.
        if (TOKENIZED_STOCKS.test(title)) {
            return null;
        }

        const delistScope = category === 'DELISTING' ? this.delistScope(title) : null;
        const listingScope = category === 'LISTING' ? this.listingScope(title) : null;
        // Perp notices name contracts (1000000BOBUSDT): the generic extractor would cut the multiplier.
        const tokens = delistScope === 'FUTURES' ? this.extractPerpTokens(title) : this.extractTokens(title);
        // The announcement WebSocket pushes the full body: read the tokens from it, no page fetch.
        if (tokens.length === 0 && article.body && category === 'DELISTING') {
            tokens.push(...this.tokensFromContent(this.bodyToText(article.body), delistScope === 'FUTURES' ? 'FUTURES' : 'SPOT'));
        }
        // A cryptolisting.ws message has no article page to read, but names its tickers pre-parsed.
        if (tokens.length === 0 && Array.isArray(article.tickers)) {
            tokens.push(...article.tickers);
        }
        let pendingDelistTokens = false;

        if (category === 'DELISTING' && tokens.length === 0 && code && /(delist|removal)/i.test(title)) {
            // Wait for the slow article page only for a delist the trader may short.
            if (this._needsDelistTokensForTrade(delistScope)) {
                const detailedTokens = await this.parseDelistDetails(code, delistScope);
                if (detailedTokens.length > 0) {
                    tokens.push(...detailedTokens);
                }
            } else {
                pendingDelistTokens = true;
                this._resolveDelistTokensInBackground(code, title, delistScope);
            }
        }

        const validTokens = this.filterValidTokens(tokens);
        // A pending delisting is still stored, so the page is not re-fetched on every poll.
        if (validTokens.length === 0 && !pendingDelistTokens) {
            return null;
        }
        
        const formattedDate = new Date(releaseDate).toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            hour12: false
        });
        
        // Prepare metadata for storage with millisecond precision
        const detectionTime = Date.now();
        const primaryToken = validTokens.length > 0 ? validTokens[0] : null;
        const symbols = validTokens.map(token => `${token}USDT`);
        const symbol = primaryToken ? `${primaryToken}USDT` : null;
        const signals = this.generateSignals(validTokens, category);
        
        const metadata = {
            symbol,
            symbols,
            title,
            link: url,
            exchange: 'BINANCE',
            detectedAt: detectionTime,
            orderedAt: null,
            latency: null
        };
        
        return {
            hash,
            exchange: 'BINANCE',
            catalogId,
            category,
            delistScope,
            listingScope,
            title,
            url,
            symbol,
            symbols,
            releaseDate,
            tokens: validTokens,
            signals,
            formattedDate,
            metadata,
            detectedAt: detectionTime,
            // Candidates only; the trader decides per AUTO_TRADE_BINANCE_* flags
            // (DELISTING was never forwarded before, so AUTO_TRADE_BINANCE_DELISTING had no effect).
            _shouldTrade: ['LISTING', 'NEW_PAIRS', 'DELISTING'].includes(category)
        };
    }
    
    /**
     * Each catalog is fetched and processed independently, so a new announcement is handled
     * as soon as ITS catalog responds (not after the slower of the two requests).
     * With `onFound`, announcements are streamed to it immediately and not returned.
     */
    async check(onFound) {
        if (!this.config.enabled) {
            return { processed: 0, sent: 0, announcements: [], latestAnnouncement: null };
        }
        
        let processed = 0, sent = 0, latestAnnouncement = null;
        const found = [];

        const handleCatalog = async (catalogId) => {
            try {
                const catalogData = await this.fetchAnnouncements(catalogId);
                const unseenArticles = [];

                for (const article of catalogData.articles) {
                    const hash = this.articleHash(article);

                    // Do NOT stop at first known item. API order/caching can be inconsistent,
                    // and new items may appear after already-known ones.
                    if (storage.has(hash, 'BINANCE')) {
                        continue;
                    }

                    unseenArticles.push({ article, hash });
                }

                if (unseenArticles.length === 0) {
                    return;
                }

                const announcements = await Promise.all(
                    unseenArticles.map(({ article, hash }) => this.processAnnouncement(article, hash))
                );

                processed += unseenArticles.length;

                for (const announcement of announcements) {
                    if (announcement) {
                        sent++;
                        if (!latestAnnouncement) {
                            latestAnnouncement = announcement;
                        }
                        storage.add(announcement.hash, announcement.metadata, 'BINANCE');
                        if (onFound) {
                            onFound(announcement);
                        } else {
                            found.push(announcement);
                        }
                    }
                }

                if (announcements.some(Boolean)) {
                    storage.saveBinance().catch(() => {});
                }
            } catch (error) {
                this.health.error('processCatalog', error.message);
            }
        };

        await Promise.all(this.catalogIds.map(handleCatalog));
        
        return { processed, sent, announcements: found, latestAnnouncement };
    }

    // ==================== ANNOUNCEMENT WEBSOCKET ====================

    _wsUrl() {
        const query = `random=${crypto.randomBytes(16).toString('hex')}&topic=${WS_TOPIC}&recvWindow=30000&timestamp=${Date.now()}`;
        const signature = crypto.createHmac('sha256', this.config.wsApiSecret).update(query).digest('hex');
        return `${this.config.wsUrl}?${query}&signature=${signature}`;
    }

    /** Push message -> announcement (same processing as a REST article). null = not actionable / seen. */
    async processWsMessage(msg) {
        if (msg?.type !== 'DATA' || msg.topic !== WS_TOPIC) return null;
        const d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const catalogId = Number(d?.catalogId);
        if (!this.catalogIds.includes(catalogId) || !d.title) return null;
        const hash = crypto.createHash('md5').update(`BINANCE-WS-${catalogId}-${d.publishDate}-${d.title}`).digest('hex');
        const announcement = await this.processAnnouncement({
            id: null,
            code: null,
            title: d.title,
            body: d.body || '',
            releaseDate: Number(d.publishDate) || Date.now(),
            catalogId,
            exchange: 'BINANCE',
            url: 'https://www.binance.com/en/support/announcement'
        }, hash);
        if (!announcement) return null;
        announcement._source = 'WS';
        storage.add(announcement.hash, announcement.metadata, 'BINANCE');
        storage.saveBinance().catch(() => {});
        return announcement;
    }

    /**
     * Official announcement stream (wss://api.binance.com/sapi/wss, topic com_announcement_en).
     * Returns false when disabled or the API key is missing. Reconnects with backoff and every 23h.
     */
    startWebSocket(onAnnouncement) {
        if (!this.config.enabled || !this.config.wsEnabled) return false;
        if (!this.config.wsApiKey || !this.config.wsApiSecret) {
            console.log('ℹ️ [BINANCE-WS] BINANCE_ANNOUNCE_API_KEY / _SECRET (or BINANCE_API_KEY / _SECRET) not set, announcement stream disabled (REST polling only)');
            return false;
        }

        let reconnectDelay = WS_RECONNECT_MIN_MS;
        const connect = () => {
            let pingTimer = null;
            let rotateTimer = null;
            let authFailed = false;
            const ws = new WebSocket(this._wsUrl(), {
                headers: { 'X-MBX-APIKEY': this.config.wsApiKey },
                perMessageDeflate: false
            });
            this.ws = ws;

            ws.on('unexpected-response', (req, res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    this.wsHealth.error(`handshake HTTP ${res.statusCode}`, body.slice(0, 300) || '(empty body)');
                    if (res.statusCode === 401 || res.statusCode === 403) authFailed = true;
                    ws.terminate();
                });
            });

            ws.on('open', () => {
                this.wsConnected = true;
                reconnectDelay = WS_RECONNECT_MIN_MS;
                pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, WS_PING_MS);
                rotateTimer = setTimeout(() => ws.close(1000, 'rotate'), WS_ROTATE_MS);
                console.log(`🔌 [BINANCE-WS] Connected (${WS_TOPIC}), waiting for the key check`);
            });

            ws.on('message', (data) => {
                let msg;
                try {
                    msg = JSON.parse(data.toString('utf8'));
                } catch (error) {
                    this.wsHealth.error('parse', error.message);
                    return;
                }
                if (msg.type === 'COMMAND') {
                    // A bad key is reported here ({"data":"Invalid Api-Key ID.","subType":"REGISTER"}),
                    // then the server closes: retry slowly instead of hammering it.
                    if (msg.data === 'SUCCESS') {
                        this.wsHealth.success();
                        console.log(`🔌 [BINANCE-WS] ${msg.subType || 'command'} OK, announcement stream live`);
                    } else {
                        if (msg.subType === 'REGISTER') authFailed = true;
                        this.wsHealth.error(`command ${msg.subType || ''}`, String(msg.data));
                    }
                    return;
                }
                this.wsHealth.success();
                this.processWsMessage(msg)
                    .then(announcement => { if (announcement) onAnnouncement(announcement); })
                    .catch(error => this.wsHealth.error('handler', error.message));
            });

            ws.on('error', (error) => this.wsHealth.error('socket', error.message));

            ws.on('close', (code, reason) => {
                this.wsConnected = false;
                clearInterval(pingTimer);
                clearTimeout(rotateTimer);
                const why = String(reason || '');
                const delay = why === 'rotate' ? 0 : authFailed ? WS_AUTH_RETRY_MS : reconnectDelay;
                if (why !== 'rotate') this.wsHealth.error('close', `code=${code} reason=${why} reconnectIn=${delay}ms`);
                setTimeout(connect, delay);
                if (!authFailed && why !== 'rotate') reconnectDelay = Math.min(reconnectDelay * 2, WS_RECONNECT_MAX_MS);
            });
        };

        connect();
        return true;
    }

    getHealth() {
        return {
            ...this.health.toJSON(),
            ws: this.config.wsEnabled ? { connected: this.wsConnected, ...this.wsHealth.toJSON() } : null
        };
    }
}

module.exports = new BinanceMonitor();
