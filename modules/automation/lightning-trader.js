const config = require('../../config/config');
const trading = require('../trading');
const telegram = require('../notifications');
const storage = require('../storage');
const perfOptimizer = require('./performance-optimizer');
const fastCache = require('./fast-cache');
const { createPositionManager } = require('../trading/position-manager');
const { trailingFromPricePct } = require('../trading/trade-engine');
const { BybitSpot } = require('../trading/bybit-spot');
const { BybitSpotManager } = require('../trading/bybit-spot-manager');

// Never bought on the Bybit spot route (no listing pump: ~0% in the backtest).
const STABLECOINS = new Set(['USDT', 'USDC', 'USDE', 'USDS', 'USD1', 'RLUSD', 'PYUSD', 'FDUSD', 'TUSD', 'DAI', 'USDD', 'XAUT', 'PAXG', 'EURC']);

const PRECISION_REFRESH_MS = 5 * 60 * 1000;
const CONNECTION_KEEPALIVE_MS = 15000;
const WARM_SOCKETS = 3;
// 2 signed calls per symbol: ~10 req/s, far below the API limits, done in ~2 min for ~600 symbols.
const MARGIN_PREP_SPACING_MS = 200;

/**
 * Lightning-Fast Auto Trader
 * Optimized for ultra-low latency
 */

class LightningAutoTrader {
    constructor() {
        this.config = config.autoTrade;
        this.binance = trading.binance;
        this.telegramQueue = [];
        // Symbols with an entry order on its way (not yet in the position manager)
        this.entriesInFlight = new Set();
        this.isSendingTelegram = false;
        this.fastModeSkipTradableCheck = process.env.AUTO_TRADE_FAST_SKIP_TRADABLE_CHECK !== 'false';
        this.marketFirstAsyncProtection = process.env.AUTO_TRADE_MARKET_FIRST_ASYNC_PROTECTION !== 'false';
        this.retryCount = Math.max(0, parseInt(process.env.AUTO_TRADE_RETRY_COUNT || '1', 10));
        this.retryDelayMs = Math.max(0, parseInt(process.env.AUTO_TRADE_RETRY_DELAY_MS || '50', 10));
        // Market entry here, then protective orders / trailing / PnL in the position manager.
        // POSITION_MANAGER_ENABLED=false keeps the old one-shot market+TP/SL path.
        this.positionManager = config.positionManager.enabled ? createPositionManager() : null;
        this.tradableSymbolSet = new Set();
        const bybitClient = new BybitSpot();
        this.bybitSpot = bybitClient.enabled
            ? new BybitSpotManager({
                client: bybitClient,
                notify: (message, channel) => telegram.notify(message, channel),
                settings: config.strategies.upbitListingBybitSpot,
                storageFile: require('path').join(__dirname, '..', '..', config.storage.bybitSpotPositionsFile)
            })
            : null;
    }
    
    /**
     * Take everything that is not signal-specific off the order's critical path:
     *  - precision for all tradable perpetuals (exchangeInfo is ~1s to download)
     *  - streamed prices (skips GET /ticker/price before the order)
     *  - a periodic ping so the keep-alive TLS connection to fapi stays open
     *    (a fresh TLS handshake costs ~150ms+)
     */
    async warmup() {
        // Started even with auto-trade off: positions left open by a previous run keep their
        // trailing SL / PnL tracking.
        if (this.positionManager) {
            await this.positionManager.start().catch(error => console.error(`[WARMUP] position manager start failed: ${error.message}`));
        }
        if (this.bybitSpot) this.bybitSpot.start();

        if (!this.config.enabled) return;

        const refreshPrecisions = async () => {
            try {
                const precisions = await this.binance.loadTradableSymbolPrecisions();
                precisions.forEach((precision, symbol) => fastCache.cacheSymbolPrecision(symbol, precision));
                this.tradableSymbols = [...precisions.keys()];
                if (this.tradableSymbols.length > 0) this.tradableSymbolSet = new Set(this.tradableSymbols);
                return precisions.size;
            } catch (error) {
                console.error(`[WARMUP] precision preload failed: ${error.message}`);
                return 0;
            }
        };

        // Per-symbol max leverage, so an order never asks for more than the symbol allows.
        const refreshLeverageBrackets = async () => {
            try {
                return await this.binance.loadLeverageBrackets();
            } catch (error) {
                console.error(`[WARMUP] leverage bracket preload failed: ${error.response?.data?.msg || error.message}`);
                return 0;
            }
        };

        this.binance.priceStream.start();

        const [count, bracketCount] = await Promise.all([refreshPrecisions(), refreshLeverageBrackets()]);
        console.log(`⚡ [WARMUP] Preloaded precision for ${count} and leverage brackets for ${bracketCount} Binance Futures symbols`);

        // Bybit spot pairs (route for Upbit KRW listings without a Binance perp)
        const refreshBybitPairs = async () => {
            if (!this.bybitSpot || !this.config.upbitListingBybitSpot) return;
            try {
                const n = await this.bybitSpot.client.loadInstruments();
                console.log(`🟠 [WARMUP] Bybit ${this.bybitSpot.client.cfg.testnet ? 'TESTNET ' : ''}spot: ${n} USDT pairs`);
            } catch (error) {
                console.error(`[WARMUP] Bybit spot pairs failed: ${error.message}`);
            }
        };
        refreshBybitPairs();

        // Background: never awaited, the monitors start right away. Symbols listed later are picked
        // up on the next refresh.
        this.prepareMargin().catch(error => console.error(`[MARGIN] prepare failed: ${error.message}`));

        setInterval(async () => {
            await refreshPrecisions();
            await refreshLeverageBrackets();
            await refreshBybitPairs();
            this.prepareMargin().catch(error => console.error(`[MARGIN] prepare failed: ${error.message}`));
        }, PRECISION_REFRESH_MS);
        // Concurrent pings keep several sockets warm (order + parallel tokens + leverage).
        const keepWarm = () => {
            for (let i = 0; i < WARM_SOCKETS; i++) {
                this.binance.testConnectivity().catch(() => {});
            }
        };
        keepWarm();
        setInterval(keepWarm, CONNECTION_KEEPALIVE_MS);
    }

    /**
     * ISOLATED margin + leverage set ahead on every tradable symbol, so the order path does not wait
     * on them and the loss of a trade is capped at its margin. Margin type cannot change once a
     * position is open, so it must happen before the signal. Leverage = the highest strategy
     * leverage, capped per symbol; the trade still sets its own profile's leverage after the order.
     */
    async prepareMargin() {
        if (this.preparingMargin || !this.tradableSymbols) return;
        this.preparingMargin = true;
        const profiles = Object.values(config.strategies);
        const leverage = Math.max(this.config.leverage, ...profiles.map(p => p.leverage));
        const amount = Math.max(this.config.amount, ...profiles.map(p => p.amount));
        let done = 0, failed = 0;
        try {
            for (const symbol of this.tradableSymbols) {
                if (this.binance.isIsolatedCached(symbol)) continue;
                try {
                    await this.binance.ensureIsolated(symbol);
                    const symbolLeverage = config.autoTrade.useSymbolMaxLeverage
                        ? (this.cappedMaxLeverage(symbol, this.config.amount / this.config.leverage) || leverage)
                        : Math.min(leverage, this.binance.getMaxLeverageCached(symbol, amount) || leverage);
                    await this.binance.changeInitialLeverage(symbol, symbolLeverage);
                    done++;
                } catch (error) {
                    failed++;
                    console.warn(`[MARGIN] ${symbol}: ${error.response?.data?.msg || error.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, MARGIN_PREP_SPACING_MS));
            }
        } finally {
            this.preparingMargin = false;
        }
        if (done || failed) console.log(`⚙️ [MARGIN] ISOLATED + leverage set on ${done} symbols (${failed} failed)`);
    }

    /**
     * Queue telegram message to send async (non-blocking)
     */
    queueTelegramMessage(message) {
        this.telegramQueue.push(message);
        if (!this.isSendingTelegram) {
            this.processTelegramQueue();
        }
    }
    
    async processTelegramQueue() {
        this.isSendingTelegram = true;
        while (this.telegramQueue.length > 0) {
            const message = this.telegramQueue.shift();
            try {
                await telegram.sendMessage(message, 'order');
            } catch (error) {
                console.error(`[TELEGRAM] send failed: ${error.message}`);
            }
        }
        this.isSendingTelegram = false;
    }
    
    /**
     * Fast token extraction (optimized)
     */
    extractTokensFast(title) {
        const tokens = [];
        
        // Pattern 1: (TOKEN)
        const paren = title.match(/\(([A-Z]{2,10})\)/);
        if (paren) tokens.push(paren[1]);
        
        // Pattern 2: TOKENSDT
        const sdt = title.match(/([A-Z]{2,10})USDT/);
        if (sdt) tokens.push(sdt[1]);
        
        return [...new Set(tokens)].slice(0, 5); // Limit to 5 tokens max
    }

    shouldRetryTradeError(error) {
        const msg = (
            error?.response?.data?.msg ||
            error?.message ||
            ''
        ).toLowerCase();
        const code = error?.response?.data?.code;

        // Common listing-start race errors
        return (
            code === -1121 || // Invalid symbol
            msg.includes('invalid symbol') ||
            msg.includes('notional') ||
            msg.includes('not trading') ||
            msg.includes('market is closed')
        );
    }

    async sniperRetry(fn) {
        let lastError;
        const totalRetries = this.retryCount;
        const maxAttempts = totalRetries + 1;
        const delayMs = this.retryDelayMs;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                if (!this.shouldRetryTradeError(error) || i === maxAttempts - 1) {
                    throw error;
                }
                const retryIndex = i + 1;
                console.warn(`[RETRY] ${retryIndex}/${totalRetries} failed: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        throw lastError || new Error('Trading not available');
    }
    
    /**
     * Leverage / size / risk for a signal. Listings use the global AUTO_TRADE_* and
     * POSITION_* / TRAILING_* settings (risk=null); the Upbit SHORT strategies have their own
     * profile (config.strategies) with SL/TP given in price % and converted to ROI here.
     */
    strategyProfile(exchange, category) {
        let key = null;
        if (exchange === 'UPBIT') key = { WARNING: 'upbitWarning', DELISTING: 'upbitDelisting', LISTING_SHORT: 'upbitListingShort' }[category] || null;
        if (exchange === 'BINANCE' && category === 'LISTING') key = 'binanceListing';
        if (exchange === 'BINANCE' && category === 'DELISTING') key = 'binanceDelisting';
        if (!key) {
            return { name: 'default', leverage: this.config.leverage, amount: this.config.amount, risk: null };
        }
        const p = config.strategies[key];
        return {
            name: key,
            leverage: p.leverage,
            amount: p.amount > 0 ? p.amount : this.config.amount,
            slPct: p.slPct,
            tpPct: p.tpPct,
            trail: p.trail,
            risk: {
                name: key,
                initialSlRoiPct: p.slPct * p.leverage,
                tpRoiPct: p.tpPct > 0 ? p.tpPct * p.leverage : 0,
                // null = no trailing (default): hold to SL / TP / time stop
                trailing: trailingFromPricePct(p.trail, p.leverage),
                maxHoldMin: p.maxHoldMin
            }
        };
    }

    /**
     * The profile with its leverage capped at the symbol's max for this notional (Binance rejects
     * a higher one, and the position kept whatever leverage it had). Strategy SL/TP are price %, so
     * their ROI is recomputed with the capped leverage. Unknown max (brackets not loaded) = as configured.
     */
    profileForSymbol(profile, symbol) {
        // Isolated margin = the max loss of the trade: keep it, so a different leverage means a different notional.
        const margin = profile.amount / profile.leverage;
        const symbolMax = this.cappedMaxLeverage(symbol, margin);
        if (!symbolMax) return profile;
        // AUTO_TRADE_LEVERAGE_MAX: always the symbol's max (under the cap); otherwise only lower a too-high setting.
        const leverage = config.autoTrade.useSymbolMaxLeverage ? symbolMax : Math.min(profile.leverage, symbolMax);
        if (leverage === profile.leverage) return profile;

        const amount = margin * leverage;
        console.log(`⚙️ [LEVERAGE] ${symbol} max ${symbolMax}x, ${profile.name} ${profile.leverage}x — using ${leverage}x, notional ${amount}u (same margin)`);
        return {
            ...profile,
            leverage,
            amount,
            risk: profile.risk && {
                ...profile.risk,
                initialSlRoiPct: profile.slPct * leverage,
                tpRoiPct: profile.tpPct > 0 ? profile.tpPct * leverage : 0,
                trailing: trailingFromPricePct(profile.trail, leverage)
            }
        };
    }

    /** The symbol's max leverage for this margin, held under AUTO_TRADE_LEVERAGE_CAP (0 = no cap). */
    cappedMaxLeverage(symbol, margin) {
        const max = this.binance.getMaxLeverageForMargin(symbol, margin);
        const cap = config.autoTrade.leverageCap;
        return max && cap > 0 ? Math.min(max, cap) : max;
    }

    /**
     * Execute trade with maximum speed
     */
    async executeLight(announcement) {

        if (!this.config.enabled) return null;
        if (!announcement) return null;

        // Upbit KRW listing tokens without a Binance perp go to Bybit SPOT; the rest stays on Binance.
        const spot = this._bybitSpotListing(announcement);
        const [spotResults, binanceResults, shortResults] = await Promise.all([
            spot ? spot.results : null,
            this._executeBinance(spot ? spot.rest : announcement),
            this._upbitListingShort(announcement)
        ]);
        const all = [...(spotResults || []), ...(binanceResults || []), ...(shortResults || [])];
        return all.length > 0 ? all : null;
    }

    /**
     * SHORT an Upbit listing that opens BTC/USDT markets only (no KRW) on the Binance perp, `delaySec`
     * after the notice: the small pump fades (backtest 2026-10-21, 1s candles + funding, 58 listings
     * 2023-2026: +160u at 10u x10, DD 19u, every year positive). KRW listings keep pumping: never shorted.
     * The freshness check runs at the notice; the delayed order skips it (it is late on purpose).
     */
    async _upbitListingShort(announcement) {
        if (!this.config.upbitListingShort) return null;
        if (String(announcement.exchange).toUpperCase() !== 'UPBIT' || String(announcement.category).toUpperCase() !== 'LISTING') return null;
        const title = announcement.title || '';
        if (/KRW/.test(title) || !/BTC|USDT/.test(title)) return null;
        if (!this._isFresh(announcement, false)) return null;

        const delayMs = config.strategies.upbitListingShort.delaySec * 1000;
        const waitMs = Math.max(0, Number(announcement.releaseDate) + delayMs - Date.now());
        console.log(`⏳ [LISTING-SHORT] ${(announcement.tokens || []).join(',')}: short in ${Math.round(waitMs / 1000)}s — ${title}`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return this._executeBinance({ ...announcement, category: 'LISTING_SHORT' }, { freshnessChecked: true });
    }

    _hasBinancePerp(token) {
        return ['', '1000', '1000000'].some(prefix => this.tradableSymbolSet.has(`${prefix}${token}USDT`));
    }

    /**
     * Bybit SPOT route for an Upbit listing: KRW market (BTC/USDT-only listings lost in the backtest),
     * not a stablecoin, no Binance perp, a USDT pair on Bybit. Returns null when nothing is routed,
     * else { results: Promise<result[]>, rest: announcement with the remaining tokens for Binance }.
     */
    _bybitSpotListing(announcement) {
        if (!this.bybitSpot || !this.config.upbitListingBybitSpot) return null;
        if (String(announcement.exchange).toUpperCase() !== 'UPBIT' || String(announcement.category).toUpperCase() !== 'LISTING') return null;
        if (!/KRW/.test(announcement.title || '')) return null;
        if (!this._isFresh(announcement, false)) return null; // the Binance path logs the skip
        if (this.tradableSymbolSet.size === 0) {
            console.log(`⏭️ [BYBIT-SPOT] skip: Binance symbols not loaded, cannot tell which tokens lack a perp — ${announcement.title}`);
            return null;
        }

        const tokens = Array.isArray(announcement.tokens) ? announcement.tokens : [];
        const routed = [];
        for (const token of tokens) {
            const symbol = `${token}USDT`;
            if (STABLECOINS.has(token) || this._hasBinancePerp(token)) continue;
            if (!this.bybitSpot.client.hasPair(symbol)) {
                console.log(`⏭️ [BYBIT-SPOT] ${token}: no Binance perp and no Bybit spot pair`);
                continue;
            }
            if (this.entriesInFlight.has(`BYBIT:${symbol}`) || this.bybitSpot.positions.has(symbol)) {
                console.log(`⏭️ [BYBIT-SPOT] skip ${symbol}: position already open`);
                continue;
            }
            routed.push(token);
        }
        if (routed.length === 0) return null;

        const source = { exchange: 'UPBIT', category: 'LISTING', title: announcement.title || '', hash: announcement.hash || null };
        const results = Promise.all(routed.map(async (token) => {
            const symbol = `${token}USDT`;
            const key = `BYBIT:${symbol}`;
            this.entriesInFlight.add(key);
            const startedAt = Date.now();
            try {
                return await this.bybitSpot.open({ symbol, token, source });
            } catch (error) {
                console.error(`[BYBIT-SPOT] ${symbol} buy failed in ${Date.now() - startedAt}ms: ${error.message}`);
                this.queueTelegramMessage(telegram.createErrorMessage(token, `${symbol} (Bybit spot)`, error.message));
                return { token, symbol, success: false, venue: 'BYBIT_SPOT', error: error.message, duration: Date.now() - startedAt };
            } finally {
                this.entriesInFlight.delete(key);
            }
        }));
        return { results, rest: { ...announcement, tokens: tokens.filter(t => !routed.includes(t)) } };
    }

    /**
     * Freshness guard: trade only signals published moments ago. Without it, any notice the bot had
     * not seen before (first run, restart, a proxy missing the baseline poll) was traded as if new —
     * on 2026-10-13 a restart opened 6 demo positions on 1h–5 week old news.
     */
    _isFresh(announcement, log = true) {
        const exchange = String(announcement.exchange || '').toUpperCase();
        const category = String(announcement.category || '').toUpperCase();
        const publishedAt = Number(announcement.releaseDate);
        const ageMs = Date.now() - publishedAt;
        if (!(publishedAt > 0)) {
            if (log) console.log(`⏭️ [TRADE] skip ${exchange} ${category}: no publication time — ${announcement.title}`);
            return false;
        }
        if (ageMs > this.config.maxSignalAgeSec * 1000) {
            if (log) console.log(`⏭️ [TRADE] skip ${exchange} ${category}: published ${Math.round(ageMs / 1000)}s ago (> ${this.config.maxSignalAgeSec}s) — ${announcement.title}`);
            return false;
        }
        return true;
    }

    async _executeBinance(announcement, { freshnessChecked = false } = {}) {
        const exchange = String(announcement.exchange || '').toUpperCase();
        const category = String(announcement.category || '').toUpperCase();

        if (!freshnessChecked && !this._isFresh(announcement)) return null;

        if (exchange === 'UPBIT') {
            if (category === 'LISTING') {
                if (!this.config.upbitListing) return null;
                if (this.config.upbitKrwOnly && !/KRW/.test(announcement.title || '')) {
                    console.log(`⏭️ [TRADE] skip Upbit listing without KRW market (AUTO_TRADE_UPBIT_KRW_ONLY): ${announcement.title}`);
                    return null;
                }
            } else if (category === 'LISTING_SHORT') {
                if (!this.config.upbitListingShort) return null;
            } else if (category === 'WARNING') {
                if (!this.config.upbitWarning) return null;
            } else if (category === 'DELISTING') {
                if (!this.config.upbitDelisting) return null;
            } else {
                return null;
            }
        } else if (exchange === 'BITHUMB') {
            if (!this.config.bithumbListing) return null;
            if (category !== 'LISTING') return null;
        } else if (exchange === 'BINANCE') {
            if (category === 'DELISTING') {
                if (!this.config.binanceDelisting) return null;
                // Margin/loan/Alpha/pair-removal delists did not move price enough to short.
                if (!['SPOT', 'FUTURES'].includes(announcement.delistScope)) {
                    console.log(`⏭️ [TRADE] skip Binance delisting (scope ${announcement.delistScope || 'unknown'}, only SPOT/FUTURES are shorted): ${announcement.title}`);
                    return null;
                }
            } else if (category === 'LISTING') {
                if (!this.config.binanceListing) return null;
            } else if (category === 'NEW_PAIRS') {
                if (!this.config.binanceNewPairs) return null;
            } else {
                return null;
            }
        } else {
            return null;
        }
        
        // Monitors already extracted tokens; an empty list means "no safe ticker found"
        // and must not fall back to guessing from the title.
        const tokens = Array.isArray(announcement.tokens)
            ? announcement.tokens
            : this.extractTokensFast(announcement.title || '');
        if (tokens.length === 0) return null;

        // One position per symbol: a token whose symbol already has an open position (or an entry on
        // its way) is skipped, other symbols trade as usual. Checked and claimed synchronously, so two
        // signals for the same symbol (e.g. Upbit warning then delisting) cannot both pass.
        const busy = tokens.filter(token => this._symbolBusy(`${token}USDT`));
        if (busy.length > 0) {
            console.log(`⏭️ [TRADE] skip ${busy.map(t => `${t}USDT`).join(',')}: position already open — ${exchange} ${category} ${announcement.title}`);
        }
        const free = [...new Set(tokens.filter(token => !busy.includes(token)))];
        if (free.length === 0) return null;

        const symbols = free.map(token => `${token}USDT`);
        symbols.forEach(symbol => this.entriesInFlight.add(symbol));
        try {
            return await this._executeEntries(announcement, exchange, category, free);
        } finally {
            symbols.forEach(symbol => this.entriesInFlight.delete(symbol));
        }
    }

    _symbolBusy(symbol) {
        return this.entriesInFlight.has(symbol) || Boolean(this.positionManager?.positions?.has(symbol));
    }

    async _executeEntries(announcement, exchange, category, tokens) {
        const takeProfitPercent = exchange === 'BINANCE'
            ? this.config.takeProfitPercentBinance
            : exchange === 'BITHUMB'
                ? this.config.takeProfitPercentBithumb
                : this.config.takeProfitPercentUpbit;
        
        const isShort = category === 'DELISTING' || category === 'WARNING' || category === 'LISTING_SHORT';
        const signalProfile = this.strategyProfile(exchange, category);
        const executionStartTime = Date.now();
        const tradeResults = [];
        const announcementHash = announcement.hash;
        const orderExecutionTime = Date.now();
        
        // All tokens of one announcement are ordered in parallel, not one after another.
        await Promise.all(tokens.map(async (token) => {
            const symbol = `${token}USDT`;
            const tradeStartTime = Date.now();
            const profile = this.profileForSymbol(signalProfile, symbol);

            try {
                if (this.fastModeSkipTradableCheck) {
                    const cachedTradable = this.binance.isSymbolTradableCached(symbol);
                    if (cachedTradable === false) {
                        throw new Error('Symbol is not tradable on Binance Futures (cached)');
                    }
                } else {
                    const tradableNow = await this.binance.isSymbolTradable(symbol).catch(() => true);
                    if (!tradableNow) {
                        const tradableAfterRefresh = await this.binance.isSymbolTradable(symbol, true).catch(() => false);
                        if (!tradableAfterRefresh) {
                            throw new Error('Symbol is not tradable on Binance Futures');
                        }
                    }
                }
                
                // Contract about to be settled (Binance is delisting this perp): it would be force-closed
                // before the strategy's time stop. In-memory lookup, no extra request.
                const deliveryAt = this.binance.getDeliveryTimeCached(symbol);
                const holdMs = (profile.risk?.maxHoldMin || 60) * 60000;
                if (deliveryAt && deliveryAt < Date.now() + holdMs) {
                    throw new Error(`Perp ${symbol} settles ${new Date(deliveryAt).toISOString()}, inside the ${holdMs / 60000}min hold window`);
                }

                // Get precision for TP/SL calculation
                const precision = await fastCache.getSymbolPrecision(symbol, this.binance).catch(error => {
                    console.error(`[PRECISION] ${symbol} failed: ${error.message}`);
                    throw error;
                });
                
                if (!precision) {
                    throw new Error('No precision data');
                }
                
                const side = isShort ? 'SELL' : 'BUY';

                // Normally already done by prepareMargin(); awaited only for a symbol it has not reached
                // (fresh start, new listing). A trade that cannot be isolated is not placed.
                if (!this.binance.isIsolatedCached(symbol)) {
                    await this.binance.ensureIsolated(symbol).catch(error => {
                        throw new Error(`cannot set ISOLATED margin: ${error.response?.data?.msg || error.message}`);
                    });
                }

                // Place order with TP/SL using fast retry
                const tradeFn = this.positionManager
                    ? () => this.binance.trading.marketEntry(symbol, side, profile.amount, precision)
                    : isShort
                    ? () => this.binance.trading.marketSellWithTPSL(
                        symbol,
                        profile.amount,
                        takeProfitPercent,
                        this.config.stopLossPercent,
                        'BOTH',
                        precision,
                        { asyncProtection: this.marketFirstAsyncProtection }
                    )
                    : () => this.binance.trading.marketBuyWithTPSL(
                        symbol,
                        profile.amount,
                        takeProfitPercent,
                        this.config.stopLossPercent,
                        'BOTH',
                        precision,
                        { asyncProtection: this.marketFirstAsyncProtection }
                    );

                const orderPromise = this.sniperRetry(tradeFn);

                // Set leverage only after the order request is on the wire: fired first, it took
                // the warm keep-alive socket and pushed the order onto a fresh TLS handshake.
                // (It never applied to this order anyway — both requests were already racing.)
                // setImmediate: runs after the order's promise chain (all microtasks) has dispatched it.
                setImmediate(() => {
                    this.binance.changeInitialLeverage(symbol, profile.leverage).catch((error) => {
                        console.warn(`[LEVERAGE] ${symbol} set failed: ${error.message}`);
                    });
                });

                const order = await orderPromise;
                const tradeDuration = Date.now() - tradeStartTime;

                // Entry is filled: hand it to the position manager (SL/TP + trailing + PnL).
                let protection = null;
                if (this.positionManager) {
                    protection = await this.positionManager.open({
                        symbol,
                        side,
                        quantity: order.quantity,
                        entryPrice: order.entryPrice,
                        leverage: profile.leverage,
                        source: { exchange, category, title: announcement.title || '', hash: announcementHash || null },
                        risk: profile.risk
                    });
                }
                const filled = order.order || order;
                
                const result = {
                    token,
                    symbol,
                    success: true,
                    side: isShort ? 'SHORT' : 'LONG',
                    orderId: filled.orderId,
                    avgPrice: filled.avgPrice,
                    executedQty: filled.executedQty || order.quantity,
                    quantity: order.quantity,
                    duration: tradeDuration,
                    leverage: profile.leverage,
                    amount: profile.amount,
                    entryPrice: order.entryPrice,
                    stopLoss: protection ? protection.slPrice : order.stopLossPrice,
                    takeProfit: protection ? protection.tpPrice : order.takeProfitPrice,
                    stopLossOrderId: protection ? protection.slAlgoId : order.stopLossOrderId,
                    takeProfitOrderId: protection ? protection.tpAlgoId : order.takeProfitOrderId,
                    protectionError: protection ? protection.slError : null
                };
                
                tradeResults.push(result);
                
                // Record order execution in storage with millisecond precision (non-blocking)
                if (announcementHash) {
                    const sourceExchange = exchange === 'BINANCE'
                        ? 'BINANCE'
                        : exchange === 'BITHUMB'
                            ? 'BITHUMB'
                            : 'UPBIT';
                    storage.recordOrderExecution(announcementHash, orderExecutionTime, sourceExchange);
                    // Save async without blocking trade flow
                    if (sourceExchange === 'BINANCE') {
                        storage.saveBinance().catch(() => {});
                    } else if (sourceExchange === 'BITHUMB') {
                        storage.saveBithumb().catch(() => {});
                    } else {
                        storage.saveUpbit().catch(() => {});
                    }
                }
                
            } catch (error) {
                const tradeDuration = Date.now() - tradeStartTime;
                console.error(`[TRADE] ${symbol} failed in ${tradeDuration}ms: ${error.message}`);
                
                const result = {
                    token,
                    symbol,
                    success: false,
                    error: error.message,
                    duration: tradeDuration
                };
                
                tradeResults.push(result);
                
                // Send error notification asynchronously
                const errorMessage = telegram.createErrorMessage(token, symbol, error.message);
                this.queueTelegramMessage(errorMessage);
            }
        }));

        const totalDuration = Date.now() - executionStartTime;
        perfOptimizer.recordMetric('tradingExecution', totalDuration);
        
        return tradeResults.length > 0 ? tradeResults : null;
    }
    
    getPerformanceStats() {
        return perfOptimizer.getStats();
    }
}

module.exports = new LightningAutoTrader();
