const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('../../config/config');
const { MonitorHealth } = require('./monitor-health');
const binanceMonitor = require('./binance-monitor');
const upbitMonitor = require('./upbit-monitor');
const bithumbMonitor = require('./bithumb-monitor');

const SOURCE = 'CRYPTOLISTING';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Rejected/expired key: retrying fast cannot help, only a renewed key can.
const AUTH_RECONNECT_MS = 5 * 60 * 1000;
// Server PINGs every 15s and sends a heartbeat every 30s: 60s without any frame = dead connection.
const STALE_MS = 60000;
const WATCHDOG_MS = 10000;

// listingType -> Binance catalog, so the Binance monitor categorizes the title as its REST feed would
// (futures_listing titles say "Launch", not "list": dropped like on REST).
const BINANCE_CATALOGS = { spot_listing: 48, futures_listing: 48, spot_delisting: 161, futures_delisting: 161 };
// Intermediate Upbit/Bithumb caution stages are not forwarded by the service at all, only their release.
const KR_TYPES = new Set(['spot_listing', 'spot_delisting', 'caution_released']);

/**
 * cryptolisting.ws announcement socket (https://cryptolisting.ws/docs/book/): an extra low-latency source
 * next to the exchange crawlers. Each message is handed to the monitor of its exchange, so categories,
 * delist scope and _shouldTrade follow exactly the same rules as that exchange's own feed; the first
 * source to deliver a notice wins in index.js (CrossSourceDedup).
 */
class CryptolistingMonitor {
    constructor() {
        this.config = config.cryptolisting;
        this.health = new MonitorHealth(SOURCE);
        this.ws = null;
        this.connected = false;
        this.welcome = null;
        this.lastFrameAt = 0;
    }

    _enabledExchanges() {
        return ['binance', 'upbit', 'bithumb'].filter(name => config.exchanges[name].enabled);
    }

    _url() {
        const url = new URL(this.config.wsUrl);
        url.searchParams.set('cex', this._enabledExchanges().join(','));
        return url.toString();
    }

    _tickers(msg) {
        return String(msg.ticker || '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
    }

    /**
     * Maps one `announcement` message to the bot's announcement shape (null = not actionable).
     * Async only because the Binance monitor's processAnnouncement is.
     */
    async toAnnouncement(msg) {
        const publisher = String(msg.publisher || '').toLowerCase();
        if (!config.exchanges[publisher]?.enabled) return null;

        const title = String(msg.title || '');
        const type = String(msg.listingType || '');
        const tickers = this._tickers(msg);
        const detectedMs = Math.floor(Number(msg.detectedTimestampUs) / 1000);
        if (!title || !(detectedMs > 0)) return null;
        // The socket has no exchange id: the title identifies the notice.
        const id = crypto.createHash('md5').update(`${SOURCE}-${publisher}-${title}`).digest('hex');

        let announcement = null;
        if (publisher === 'binance') {
            const catalogId = BINANCE_CATALOGS[type];
            if (!catalogId) return null;
            announcement = await binanceMonitor.processAnnouncement({
                id,
                code: null,
                title,
                releaseDate: detectedMs,
                catalogId,
                exchange: 'BINANCE',
                url: 'https://www.binance.com/en/support/announcement',
                tickers
            }, id);
        } else if (publisher === 'upbit') {
            if (!KR_TYPES.has(type)) return null;
            announcement = upbitMonitor.processAnnouncement({
                uuid: `${SOURCE}-${id}`,
                title,
                listed_at: detectedMs,
                first_listed_at: detectedMs
            }, SOURCE);
        } else if (publisher === 'bithumb') {
            if (!KR_TYPES.has(type)) return null;
            announcement = bithumbMonitor.processNotice({ id: `${SOURCE}-${id}`, title });
        }
        if (!announcement) return null;

        // Upbit/Bithumb read the ticker from the title only; the socket names it pre-parsed.
        if (announcement.tokens.length === 0 && tickers.length > 0) {
            announcement.tokens = tickers;
            announcement.symbol = `${tickers[0]}USDT`;
            announcement.metadata.symbol = announcement.symbol;
        }

        // No exchange publish time on the socket: its detection time is the closest (and is what
        // the trader's freshness guard measures against).
        announcement.releaseDate = detectedMs;
        announcement._source = SOURCE;
        announcement._listingType = type;
        announcement._dispatchToRecvMs = Date.now() - Math.floor(Number(msg.dispatchTimestampUs) / 1000);
        if (msg.abnormalDetectionLatency === true && announcement._shouldTrade) {
            // The service flags these as unreliable timing: alert, do not trade on them.
            console.warn(`⚠️ [${SOURCE}] abnormalDetectionLatency, not trading: ${title}`);
            announcement._shouldTrade = false;
        }
        return announcement;
    }

    /**
     * onAnnouncement(announcement): same handler as the crawlers.
     * onNotice(text): key renewal / expiry notices worth a Telegram message.
     * Returns false when disabled or the API key is missing.
     */
    start(onAnnouncement, onNotice = () => {}) {
        if (!this.config.enabled) return false;
        if (!this.config.apiKey) {
            console.log(`ℹ️ [${SOURCE}] CRYPTOLISTING_API_KEY not set, socket disabled`);
            return false;
        }
        if (this._enabledExchanges().length === 0) return false;

        let reconnectDelay = RECONNECT_MIN_MS;
        let authFailed = false;

        const connect = () => {
            authFailed = false;
            const ws = new WebSocket(this._url(), {
                headers: { 'X-API-Key': this.config.apiKey },
                perMessageDeflate: false
            });
            this.ws = ws;

            ws.on('unexpected-response', (req, res) => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    this.health.error(`handshake HTTP ${res.statusCode}`, body.slice(0, 300) || '(empty body)');
                    // 401 missing key, 403 invalid/revoked/expired key
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        authFailed = true;
                        onNotice(`🔑 cryptolisting.ws rejected the API key (HTTP ${res.statusCode}). Socket paused, crawlers keep running. Renew CRYPTOLISTING_API_KEY.`);
                    }
                    ws.terminate();
                });
            });

            ws.on('open', () => {
                this.connected = true;
                this.lastFrameAt = Date.now();
                reconnectDelay = RECONNECT_MIN_MS;
                console.log(`🔌 [${SOURCE}] Connected ${this._url()}`);
            });

            ws.on('ping', () => { this.lastFrameAt = Date.now(); });

            ws.on('message', (data) => {
                this.lastFrameAt = Date.now();
                let msg;
                try {
                    msg = JSON.parse(data.toString('utf8'));
                } catch (error) {
                    this.health.error('parse', error.message);
                    return;
                }
                this._onMessage(msg, onAnnouncement, onNotice);
            });

            ws.on('error', (error) => this.health.error('socket', error.message));

            ws.on('close', (code, reason) => {
                this.connected = false;
                const why = String(reason || '');
                if (why === 'key_expired') {
                    authFailed = true;
                    onNotice('🔑 cryptolisting.ws API key expired. Socket paused, crawlers keep running. Renew CRYPTOLISTING_API_KEY.');
                }
                const delay = authFailed ? AUTH_RECONNECT_MS : reconnectDelay;
                this.health.error('close', `code=${code} reason=${why} reconnectIn=${delay}ms`);
                setTimeout(connect, delay);
                if (!authFailed) reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
            });
        };

        setInterval(() => {
            if (this.connected && Date.now() - this.lastFrameAt > STALE_MS) {
                this.health.error('stale', `no frame for ${Date.now() - this.lastFrameAt}ms, reconnecting`);
                this.ws.terminate();
            }
        }, WATCHDOG_MS).unref();

        connect();
        return true;
    }

    _onMessage(msg, onAnnouncement, onNotice) {
        switch (msg.type) {
            case 'welcome':
                this.welcome = msg;
                this.health.success();
                console.log(`🔌 [${SOURCE}] welcome tier=${msg.tier} allowedCex=${msg.allowedCex} expiresIn=${msg.expiresInSecs == null ? 'never' : `${Math.round(msg.expiresInSecs / 3600)}h`}`);
                return;
            case 'heartbeat':
                this.health.success();
                return;
            case 'renewal_notice':
                console.warn(`🔑 [${SOURCE}] ${msg.title}`);
                onNotice(`🔑 cryptolisting.ws: ${msg.title}`);
                return;
            case 'changelog':
                console.log(`ℹ️ [${SOURCE}] changelog #${msg.id}: ${msg.title}`);
                return;
            case 'test_announcement':
                // Never routed to trading.
                console.log(`🧪 [${SOURCE}] test_announcement ${msg.publisher} ${msg.listingType} ${msg.ticker} | dispatch→recv=${Date.now() - Math.floor(msg.dispatchTimestampUs / 1000)}ms`);
                return;
            case 'error':
                this.health.error(msg.code || 'error', JSON.stringify(msg));
                return;
            case 'announcement':
                break;
            default:
                return;
        }

        this.health.success();
        this.toAnnouncement(msg)
            .then(announcement => {
                if (announcement) onAnnouncement(announcement);
            })
            .catch(error => this.health.error('handler', error.message));
    }

    getHealth() {
        return {
            enabled: this.config.enabled,
            connected: this.connected,
            url: this.config.wsUrl,
            tier: this.welcome?.tier || null,
            lastFrameAt: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
            ...this.health.toJSON()
        };
    }
}

module.exports = new CryptolistingMonitor();
