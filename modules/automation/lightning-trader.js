const config = require('../../config/config');
const trading = require('../trading');
const telegram = require('../notifications');
const storage = require('../storage');
const perfOptimizer = require('./performance-optimizer');
const fastCache = require('./fast-cache');
const { createPositionManager } = require('../trading/position-manager');

const PRECISION_REFRESH_MS = 5 * 60 * 1000;
const CONNECTION_KEEPALIVE_MS = 15000;
const WARM_SOCKETS = 3;

/**
 * Lightning-Fast Auto Trader
 * Optimized for ultra-low latency
 */

class LightningAutoTrader {
    constructor() {
        this.config = config.autoTrade;
        this.binance = trading.binance;
        this.telegramQueue = [];
        this.isSendingTelegram = false;
        this.fastModeSkipTradableCheck = process.env.AUTO_TRADE_FAST_SKIP_TRADABLE_CHECK !== 'false';
        this.marketFirstAsyncProtection = process.env.AUTO_TRADE_MARKET_FIRST_ASYNC_PROTECTION !== 'false';
        this.retryCount = Math.max(0, parseInt(process.env.AUTO_TRADE_RETRY_COUNT || '1', 10));
        this.retryDelayMs = Math.max(0, parseInt(process.env.AUTO_TRADE_RETRY_DELAY_MS || '50', 10));
        // Market entry here, then protective orders / trailing / PnL in the position manager.
        // POSITION_MANAGER_ENABLED=false keeps the old one-shot market+TP/SL path.
        this.positionManager = config.positionManager.enabled ? createPositionManager() : null;
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

        if (!this.config.enabled) return;

        const refreshPrecisions = async () => {
            try {
                const precisions = await this.binance.loadTradableSymbolPrecisions();
                precisions.forEach((precision, symbol) => fastCache.cacheSymbolPrecision(symbol, precision));
                return precisions.size;
            } catch (error) {
                console.error(`[WARMUP] precision preload failed: ${error.message}`);
                return 0;
            }
        };

        this.binance.priceStream.start();

        const count = await refreshPrecisions();
        console.log(`⚡ [WARMUP] Preloaded precision for ${count} Binance Futures symbols`);

        setInterval(refreshPrecisions, PRECISION_REFRESH_MS);
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
        if (exchange === 'UPBIT') key = category === 'WARNING' ? 'upbitWarning' : category === 'DELISTING' ? 'upbitDelisting' : null;
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
            risk: {
                name: key,
                initialSlRoiPct: p.slPct * p.leverage,
                tpRoiPct: p.tpPct > 0 ? p.tpPct * p.leverage : 0,
                trailing: null,
                maxHoldMin: p.maxHoldMin
            }
        };
    }

    /**
     * Execute trade with maximum speed
     */
    async executeLight(announcement) {

        if (!this.config.enabled) return null;
        if (!announcement) return null;

        const exchange = String(announcement.exchange || '').toUpperCase();
        const category = String(announcement.category || '').toUpperCase();

        // Freshness guard: trade only signals published moments ago. Without it, any notice the
        // bot had not seen before (first run, restart, a proxy missing the baseline poll) was
        // traded as if new — on 2026-10-13 a restart opened 6 demo positions on 1h–5 week old news.
        const publishedAt = Number(announcement.releaseDate);
        const ageMs = Date.now() - publishedAt;
        if (!(publishedAt > 0)) {
            console.log(`⏭️ [TRADE] skip ${exchange} ${category}: no publication time — ${announcement.title}`);
            return null;
        }
        if (ageMs > this.config.maxSignalAgeSec * 1000) {
            console.log(`⏭️ [TRADE] skip ${exchange} ${category}: published ${Math.round(ageMs / 1000)}s ago (> ${this.config.maxSignalAgeSec}s) — ${announcement.title}`);
            return null;
        }

        if (exchange === 'UPBIT') {
            if (category === 'LISTING') {
                if (!this.config.upbitListing) return null;
                if (this.config.upbitKrwOnly && !/KRW/.test(announcement.title || '')) {
                    console.log(`⏭️ [TRADE] skip Upbit listing without KRW market (AUTO_TRADE_UPBIT_KRW_ONLY): ${announcement.title}`);
                    return null;
                }
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

        const takeProfitPercent = exchange === 'BINANCE'
            ? this.config.takeProfitPercentBinance
            : exchange === 'BITHUMB'
                ? this.config.takeProfitPercentBithumb
                : this.config.takeProfitPercentUpbit;
        
        const isShort = category === 'DELISTING' || category === 'WARNING';
        const profile = this.strategyProfile(exchange, category);
        const executionStartTime = Date.now();
        const tradeResults = [];
        const announcementHash = announcement.hash;
        const orderExecutionTime = Date.now();
        
        // All tokens of one announcement are ordered in parallel, not one after another.
        await Promise.all(tokens.map(async (token) => {
            const symbol = `${token}USDT`;
            const tradeStartTime = Date.now();
            
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
                
                // Get precision for TP/SL calculation
                const precision = await fastCache.getSymbolPrecision(symbol, this.binance).catch(error => {
                    console.error(`[PRECISION] ${symbol} failed: ${error.message}`);
                    throw error;
                });
                
                if (!precision) {
                    throw new Error('No precision data');
                }
                
                const side = isShort ? 'SELL' : 'BUY';

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
