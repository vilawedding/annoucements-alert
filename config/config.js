require('dotenv').config();
const { loadProxyFile } = require('../modules/monitoring/proxy-list');

/**
 * Centralized configuration for the entire application
 */

function parseBooleanEnv(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === '') return defaultValue;

    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;

    return defaultValue;
}

// Number env that keeps an explicit 0 (parseFloat(x) || default would turn 0 into the default).
function numEnv(name, defaultValue) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) ? value : defaultValue;
}

/**
 * Trailing SL of a strategy in PRICE % (converted to ROI with the trade's leverage):
 * <PREFIX>_TRAIL_ACTIVATE_PCT (0 = off), _TRAIL_STEP_PCT (0 = activate), _TRAIL_GIVEBACK_PCT (0 = ladder only).
 */
function strategyTrail(prefix) {
    return {
        activatePct: numEnv(`${prefix}_TRAIL_ACTIVATE_PCT`, 0),
        stepPct: numEnv(`${prefix}_TRAIL_STEP_PCT`, 0),
        givebackPct: numEnv(`${prefix}_TRAIL_GIVEBACK_PCT`, 0)
    };
}

function parseNumberList(value, defaultValue) {
    const items = String(value || '').split(',').map(v => v.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
    return items.length > 0 ? items : defaultValue;
}

function parseList(value, defaultValue = []) {
    const items = String(value || '').split(',').map(v => v.trim()).filter(Boolean);
    return items.length > 0 ? items : defaultValue;
}

/**
 * Egress list for Upbit REST polling: UPBIT_PROXIES (default "direct" when nothing else
 * is configured) + UPBIT_PROXIES_FILE (one proxy per line) + one socks5h:// entry per VM
 * in UPBIT_SSH_TUNNELS. Tunnel i listens on
 * UPBIT_SSH_TUNNEL_BASE_PORT + i of UPBIT_SSH_TUNNEL_HOST (the tunnels container),
 * matching docker/ssh-tunnels/entrypoint.sh. socks5h = DNS resolved on the VM side.
 */
function buildUpbitProxies() {
    const fromFile = loadProxyFile(process.env.UPBIT_PROXIES_FILE, process.env.UPBIT_PROXY_DEFAULT_SCHEME || 'http');
    // Without an explicit UPBIT_PROXIES, keep polling from this machine too (direct);
    // UPBIT_PROXIES=none = proxies only.
    const base = String(process.env.UPBIT_PROXIES || '').trim() === 'none'
        ? []
        : parseList(process.env.UPBIT_PROXIES, ['direct']);
    const proxies = base.concat(fromFile);
    const tunnels = parseList(process.env.UPBIT_SSH_TUNNELS, []);
    const tunnelHost = process.env.UPBIT_SSH_TUNNEL_HOST || '127.0.0.1';
    const basePort = parseInt(process.env.UPBIT_SSH_TUNNEL_BASE_PORT) || 1081;

    tunnels.forEach((_, i) => proxies.push(`socks5h://${tunnelHost}:${basePort + i}`));

    // One entry per egress endpoint: the rate limit is per IP, so the same host:port listed again
    // (e.g. a provider re-export with other credentials) would only overspend that IP. First wins.
    const seenEndpoints = new Set();
    const unique = proxies.filter(proxy => {
        const endpoint = proxy === 'direct' ? 'direct' : proxy.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/^.*@/, '').toLowerCase();
        if (seenEndpoints.has(endpoint)) return false;
        seenEndpoints.add(endpoint);
        return true;
    });
    const maxProxies = parseInt(process.env.UPBIT_MAX_PROXIES) || 25;
    if (unique.length > maxProxies) {
        console.warn(`⚠️ [CONFIG] ${unique.length} Upbit egress IPs configured, using the first ${maxProxies} (UPBIT_MAX_PROXIES)`);
    }
    return unique.slice(0, maxProxies);
}

function buildBinanceFuturesConfig() {
    const useDemo = parseBooleanEnv(process.env.BINANCE_USE_DEMO, false);
    const useTestnet = useDemo || parseBooleanEnv(process.env.BINANCE_USE_TESTNET, false);

    let mode = 'PRODUCTION';
    let baseUrl = 'https://fapi.binance.com';
    let streamBase = 'wss://fstream.binance.com/market/ws';
    if (useDemo) {
        mode = 'DEMO';
        baseUrl = 'https://demo-fapi.binance.com';
        streamBase = 'wss://demo-fstream.binance.com/ws';
    } else if (useTestnet) {
        mode = 'TESTNET';
        baseUrl = 'https://testnet.binancefuture.com';
        streamBase = 'wss://stream.binancefuture.com/ws';
    }

    return {
        mode,
        apiKey: useDemo ? process.env.BINANCE_DEMO_API_KEY : process.env.BINANCE_API_KEY,
        apiSecret: useDemo ? process.env.BINANCE_DEMO_API_SECRET : process.env.BINANCE_API_SECRET,
        useTestnet,
        useDemo,
        testnetUrl: baseUrl,
        productionUrl: 'https://fapi.binance.com',
        priceStreamUrl: process.env.BINANCE_FUTURES_PRICE_STREAM_URL || `${streamBase}/!miniTicker@arr`,
        markPriceStreamUrl: process.env.BINANCE_FUTURES_MARK_PRICE_STREAM_URL || `${streamBase}/!markPrice@arr@1s`
    };
}

module.exports = {
    // Telegram Configuration
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        // signal = announcements, order = fills/order errors, pnl = closed positions.
        // order/pnl fall back to the signal chat when not set.
        chatId: process.env.TELEGRAM_CHAT_ID || '-1003591132823',
        orderChatId: process.env.TELEGRAM_ORDER_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
        pnlChatId: process.env.TELEGRAM_PNL_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
        // Announcement alerts older than this (minutes) are only logged, not sent
        maxSignalAgeMin: numEnv('TELEGRAM_MAX_SIGNAL_AGE_MIN', 60)
    },
    
    // Exchange Monitoring Configuration
    exchanges: {
        binance: {
            enabled: parseBooleanEnv(process.env.BINANCE_ENABLED, false),
            name: "Binance",
            emoji: "🟡",
            baseUrl: "https://www.binance.com",
            interval: parseInt(process.env.BINANCE_INTERVAL) || 500,
            catalogIds: [48, 161], // Listing & Delisting
            catalogNames: {
                48: "📈 NEW LISTING",
                161: "🗑️ DELISTING",
            }
        },
        upbit: {
            enabled: parseBooleanEnv(process.env.UPBIT_ENABLED, false),
            name: "Upbit",
            emoji: "🔵",
            baseUrl: "https://upbit.com",
            interval: parseInt(process.env.UPBIT_INTERVAL) || 500,
            apiUrl: "https://api-manager.upbit.com/api/v1/announcements",
            // REST polling spread over the egress IPs at their sustainable rate (per-IP limit, HTTP 429).
            // Optional denser window around each whole minute: UPBIT_BURST_PRE_MS / UPBIT_BURST_POST_MS.
            fastPolling: {
                // 0 = auto: perIpMinIntervalMs / number of egress IPs
                burstIntervalMs: parseInt(process.env.UPBIT_BURST_INTERVAL) || 0,
                burstPreMs: parseInt(process.env.UPBIT_BURST_PRE_MS) || 0,
                burstPostMs: parseInt(process.env.UPBIT_BURST_POST_MS) || 0,
                // 0 = auto: perIpMinIntervalMs / number of egress IPs
                normalIntervalMs: parseInt(process.env.UPBIT_INTERVAL) || 0,
                maxInFlight: parseInt(process.env.UPBIT_MAX_IN_FLIGHT) || 4,
                requestTimeoutMs: parseInt(process.env.UPBIT_REQUEST_TIMEOUT_MS) || 1500,
                // REST interval while the WebSocket stream is connected (REST = fallback only)
                wsFallbackIntervalMs: parseInt(process.env.UPBIT_WS_FALLBACK_INTERVAL) || 5000
            },
            // Egress IPs for REST polling, comma separated: direct, http(s)://user:pass@host:port,
            // socks5://user:pass@host:port. The rate limit is per IP, so N IPs = N× denser polling.
            // UPBIT_SSH_TUNNELS (VMs tunnelled by the upbit-tunnels container) are appended automatically.
            proxies: buildUpbitProxies(),
            // Minimum spacing between two requests from the same IP (tune with
            // scripts/tests/probe-upbit-rate-limit.js on each IP).
            perIpMinIntervalMs: parseInt(process.env.UPBIT_PER_IP_MIN_INTERVAL_MS) || 12500,
            rateLimitBackoffMs: parseInt(process.env.UPBIT_RATE_LIMIT_BACKOFF_MS) || 60000,
            rateLimitPollMs: parseInt(process.env.UPBIT_RATE_LIMIT_POLL_MS) || 2000,
            // Private WebSocket `announcement` stream (push). Needs an Upbit API key (any permission).
            wsEnabled: parseBooleanEnv(process.env.UPBIT_WS_ENABLED, true),
            wsUrl: process.env.UPBIT_WS_URL || "wss://api.upbit.com/websocket/v1/private",
            accessKey: process.env.UPBIT_ACCESS_KEY || '',
            secretKey: process.env.UPBIT_SECRET_KEY || ''
        },
        bithumb: {
            enabled: parseBooleanEnv(process.env.BITHUMB_ENABLED, false),
            name: "Bithumb",
            emoji: "🟠",
            baseUrl: "https://www.bithumb.com",
            interval: parseInt(process.env.BITHUMB_INTERVAL) || 200,
            apiUrl: process.env.BITHUMB_API_URL || "https://feed.bithumb.com/_next/data/NLILjNtdG9PdJyIGBALYd/notice.json?category=9&page=1",
            // HTML page used to re-read the Next.js buildId when apiUrl starts returning 404
            pageUrl: process.env.BITHUMB_PAGE_URL || "https://feed.bithumb.com/notice?category=9&page=1",
            cfClearance: process.env.BITHUMB_CF_CLEARANCE || '',
            cookie: process.env.BITHUMB_COOKIE || ''
        }
    },

    // cryptolisting.ws announcement socket: extra source for the enabled exchanges above, traded like
    // their own feeds (first source wins). jp endpoint = Binance + Upbit + Bithumb.
    // Bybit V5 (Unified Trading Account), SPOT only. BYBIT_TESTNET=true -> api-testnet.bybit.com.
    bybit: {
        apiKey: process.env.BYBIT_API_KEY || '',
        apiSecret: process.env.BYBIT_API_SECRET || '',
        testnet: parseBooleanEnv(process.env.BYBIT_TESTNET, true),
        baseUrl: process.env.BYBIT_BASE_URL
            || (parseBooleanEnv(process.env.BYBIT_TESTNET, true) ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com')
    },

    cryptolisting: {
        enabled: parseBooleanEnv(process.env.CRYPTOLISTING_ENABLED, false),
        apiKey: process.env.CRYPTOLISTING_API_KEY || '',
        wsUrl: process.env.CRYPTOLISTING_WS_URL || 'wss://jp.cryptolisting.ws'
    },

    // Auto-Trading Configuration
    autoTrade: {
        // Never trade a signal published longer ago than this (seconds). Guards against old
        // notices that look "new" to the bot (first run, restart, a proxy missing the baseline).
        maxSignalAgeSec: numEnv('AUTO_TRADE_MAX_SIGNAL_AGE_SEC', 60),
        // ENABLE_AUTO_ORDER is accepted as an alias
        enabled: parseBooleanEnv(process.env.AUTO_TRADE_ENABLED, false) || parseBooleanEnv(process.env.ENABLE_AUTO_ORDER, false),
        upbitListing: process.env.AUTO_TRADE_UPBIT_LISTING !== 'false',
        // Only Upbit listings that open a KRW market (backtest: non-KRW listings pump ~10%
        // vs ~27% and are only profitable with a ≤1-2s entry)
        upbitKrwOnly: parseBooleanEnv(process.env.AUTO_TRADE_UPBIT_KRW_ONLY, false),
        // Upbit KRW listing of a token WITHOUT a Binance perp: buy it on Bybit SPOT instead
        // (backtest 2026-10-20, 26 listings 2023-2026). Independent of AUTO_TRADE_UPBIT_LISTING.
        upbitListingBybitSpot: parseBooleanEnv(process.env.AUTO_TRADE_UPBIT_LISTING_BYBIT_SPOT, false),
        // SHORT on Upbit investment warning (거래 유의 종목 지정) / delisting (거래지원 종료).
        // Own risk profiles below (config.strategies).
        upbitWarning: parseBooleanEnv(process.env.AUTO_TRADE_UPBIT_WARNING, false),
        upbitDelisting: parseBooleanEnv(process.env.AUTO_TRADE_UPBIT_DELISTING, false),
        bithumbListing: process.env.AUTO_TRADE_BITHUMB_LISTING !== 'false',
        binanceListing: process.env.AUTO_TRADE_BINANCE_LISTING !== 'false',
        // "Binance Will Add New Trading Pairs" never moved the price (backtest n=32) — off by default
        binanceNewPairs: parseBooleanEnv(process.env.AUTO_TRADE_BINANCE_NEW_PAIRS, false),
        binanceDelisting: process.env.AUTO_TRADE_BINANCE_DELISTING === 'true',
        amount: parseFloat(process.env.AUTO_TRADE_AMOUNT) || 10,
        leverage: parseInt(process.env.AUTO_TRADE_LEVERAGE) || 5,
        // Upper bound on any order's leverage (0 = none). Keeps SL inside the liquidation distance.
        leverageCap: numEnv('AUTO_TRADE_LEVERAGE_CAP', 20),
        // true = every order uses the symbol's own max leverage (all profiles); false = configured
        // leverage, only capped down when the symbol allows less
        useSymbolMaxLeverage: parseBooleanEnv(process.env.AUTO_TRADE_LEVERAGE_MAX, false),
        stopLossPercent: parseFloat(process.env.AUTO_TRADE_SL_PERCENT) || 1.0,
        takeProfitPercent: parseFloat(process.env.AUTO_TRADE_TP_PERCENT) || 200.0,
        takeProfitPercentUpbit:
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT_UPBIT) ||
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT) ||
            200.0,
        takeProfitPercentBithumb:
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT_BITHUMB) ||
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT_UPBIT) ||
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT) ||
            200.0,
        takeProfitPercentBinance:
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT_BINANCE) ||
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT) ||
            200.0
    },
    
    // Binance Futures API Configuration
    // Environments: production (default) | BINANCE_USE_TESTNET=true | BINANCE_USE_DEMO=true
    // (Binance Demo Trading, keys from demo.binance.com; same simulated account as the futures testnet).
    // Any non-production mode uses the simulated market's own prices for order sizing.
    binanceFutures: buildBinanceFuturesConfig(),
    
    // Position manager (ported from pika's ladder position management): ROI-based SL,
    // trailing SL by ROI step, close detection, PnL to Telegram. All ROI % are of margin
    // (ROI% = price% × leverage).
    positionManager: {
        enabled: parseBooleanEnv(process.env.POSITION_MANAGER_ENABLED, true),
        pollMs: numEnv('POSITION_POLL_MS', 5000),
        // 0 = AUTO_TRADE_SL_PERCENT × leverage (previous behaviour)
        initialSlRoiPct: numEnv('TRAILING_INITIAL_SL_ROI_PCT', 0),
        // true = no take-profit order, exits only via SL/trailing (pika's deployed setup)
        disableTp: parseBooleanEnv(process.env.POSITION_DISABLE_TP, false),
        // Close at market after this many minutes if still open (0 = no time stop)
        maxHoldMin: numEnv('POSITION_MAX_HOLD_MIN', 0),
        trailing: {
            activateRoiPct: numEnv('TRAILING_ACTIVATE_ROI_PCT', 50),    // 0 = trailing off
            stepRoiPct: numEnv('TRAILING_STEP_ROI_PCT', 25),
            lockBufferPct: numEnv('TRAILING_LOCK_BUFFER_PCT', 0),
            firstLockRoiPct: numEnv('TRAILING_FIRST_LOCK_ROI_PCT', 0),
            maxGivebackRoiPct: numEnv('TRAILING_MAX_GIVEBACK_ROI_PCT', 0)
        }
    },

    // Per-signal risk profiles for the SHORT strategies (backtest 2026-10-13, Upbit 2023-01..2026-10).
    // SL/TP are % of PRICE (converted to ROI with the profile's own leverage); 0 = none.
    // No trailing: the backtest's best results held to the time stop.
    strategies: {
        upbitWarning: {
            leverage: numEnv('UPBIT_WARNING_LEVERAGE', 5),
            amount: numEnv('UPBIT_WARNING_AMOUNT', 0),          // 0 = AUTO_TRADE_AMOUNT
            slPct: numEnv('UPBIT_WARNING_SL_PCT', 5),
            tpPct: numEnv('UPBIT_WARNING_TP_PCT', 0),
            maxHoldMin: numEnv('UPBIT_WARNING_MAX_HOLD_MIN', 1440),
            trail: strategyTrail('UPBIT_WARNING')
        },
        // LONG "Binance Will List X" (token already has a perp, n=39): the move keeps going for an
        // hour (price@1h +11% median) — hold with a plain SL, no TP / trailing.
        binanceListing: {
            leverage: numEnv('BINANCE_LISTING_LEVERAGE', 10),
            amount: numEnv('BINANCE_LISTING_AMOUNT', 0),
            slPct: numEnv('BINANCE_LISTING_SL_PCT', 5),
            tpPct: numEnv('BINANCE_LISTING_TP_PCT', 0),
            maxHoldMin: numEnv('BINANCE_LISTING_MAX_HOLD_MIN', 60),
            trail: strategyTrail('BINANCE_LISTING')
        },
        // SHORT "Binance Will Delist X, Y" (backtest 2026-10-14, n=78, 20s latency): hold 240m, wide SL —
        // SL 3-5% gets swept (win 26-33%), no SL has a 130% squeeze tail. Leverage kept low for that tail.
        binanceDelisting: {
            leverage: numEnv('BINANCE_DELISTING_LEVERAGE', 3),
            amount: numEnv('BINANCE_DELISTING_AMOUNT', 0),
            slPct: numEnv('BINANCE_DELISTING_SL_PCT', 10),
            tpPct: numEnv('BINANCE_DELISTING_TP_PCT', 0),
            maxHoldMin: numEnv('BINANCE_DELISTING_MAX_HOLD_MIN', 240),
            trail: strategyTrail('BINANCE_DELISTING')
        },
        // LONG on Bybit SPOT for Upbit KRW listings without a Binance perp (no leverage).
        // Backtest 1s, lag 5s: hold 5-15m with SL 5% ~ +10% median per trade, 65% win.
        upbitListingBybitSpot: {
            amount: numEnv('BYBIT_SPOT_LISTING_AMOUNT', 100),     // USDT spent per listing
            slPct: numEnv('BYBIT_SPOT_LISTING_SL_PCT', 5),
            maxHoldMin: numEnv('BYBIT_SPOT_LISTING_MAX_HOLD_MIN', 15)
        },
        upbitDelisting: {
            leverage: numEnv('UPBIT_DELISTING_LEVERAGE', 5),
            amount: numEnv('UPBIT_DELISTING_AMOUNT', 0),
            slPct: numEnv('UPBIT_DELISTING_SL_PCT', 5),
            tpPct: numEnv('UPBIT_DELISTING_TP_PCT', 0),
            maxHoldMin: numEnv('UPBIT_DELISTING_MAX_HOLD_MIN', 240),
            trail: strategyTrail('UPBIT_DELISTING')
        }
    },

    // Ladder (scale-in) entry config ported from pika — NOT used by the entry path yet
    // (see modules/trading/ladder.js). LADDER_COUNT=1 = single market entry.
    ladder: {
        count: Math.min(3, Math.max(1, numEnv('LADDER_COUNT', 1))),
        multipliers: parseNumberList(process.env.LADDER_MULTIPLIERS, [0.5, 1.2, 2.5]),
        multipliersStrong: parseNumberList(process.env.LADDER_MULTS_STRONG, [0.2, 0.5, 1.0]),
        weights: parseNumberList(process.env.LADDER_WEIGHTS, [1, 2]),
        minStepPct: numEnv('LADDER_MIN_STEP_PCT', 0),
        maxStepPct: numEnv('LADDER_MAX_STEP_PCT', 0),
        e1MaxPct: numEnv('LADDER_E1_MAX_PCT', 0),
        e1CandlePct: numEnv('LADDER_E1_CANDLE_PCT', 0),
        e1CandlePctStrong: numEnv('LADDER_E1_CANDLE_PCT_STRONG', 0)
    },

    // Storage Configuration
    storage: {
        positionsFile: 'data/positions.json',
        bybitSpotPositionsFile: 'data/bybit_spot_positions.json',
        // Persistent "already seen" notice keys (restart must not re-alert / re-trade old notices)
        seenUpbitFile: 'data/seen_upbit.json',
        seenBithumbFile: 'data/seen_bithumb.json',
        // Notices already handled from any source (first source wins, see cross-source-dedup)
        seenCrossSourceFile: 'data/seen_cross_source.json',
        binanceFile: 'data/sent_announcements_binance.json',
        upbitFile: 'data/sent_announcements_upbit.json',
        bithumbFile: 'data/sent_announcements_bithumb.json'
    },
    
    // Server Configuration
    server: {
        port: process.env.PORT || 3003
    },
    
    // General Settings
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 500
};
