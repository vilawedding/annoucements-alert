const config = require('../../config/config');
const trading = require('../trading');
const telegram = require('../notifications');
const storage = require('../storage');
const perfOptimizer = require('./performance-optimizer');
const fastCache = require('./fast-cache');

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
                await telegram.sendMessage(message);
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

    async sniperRetry(fn, retries = 20, delayMs = 50) {
        let lastError;

        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                if (!this.shouldRetryTradeError(error) || i === retries - 1) {
                    throw error;
                }
                console.warn(`[RETRY] ${i + 1}/${retries} failed: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        throw lastError || new Error('Trading not available');
    }
    
    /**
     * Execute trade with maximum speed
     */
    async executeLight(announcement) {

        if (!this.config.enabled) return null;
        if (!announcement) return null;

        const exchange = String(announcement.exchange || '').toUpperCase();
        const category = String(announcement.category || '').toUpperCase();

        if (exchange === 'UPBIT') {
            if (!this.config.upbitListing) return null;
            if (category !== 'LISTING') return null;
        } else if (exchange === 'BINANCE') {
            if (category === 'DELISTING') {
                if (!this.config.binanceDelisting) return null;
            } else if (['LISTING', 'NEW_PAIRS'].includes(category)) {
                if (!this.config.binanceListing) return null;
            } else {
                return null;
            }
        } else {
            return null;
        }
        
        const tokens = (announcement.tokens && announcement.tokens.length > 0)
            ? announcement.tokens
            : this.extractTokensFast(announcement.title || '');
        if (tokens.length === 0) return null;

        const takeProfitPercent = exchange === 'BINANCE'
            ? this.config.takeProfitPercentBinance
            : this.config.takeProfitPercentUpbit;
        
        const isShort = category === 'DELISTING';
        const executionStartTime = Date.now();
        const tradeResults = [];
        const announcementHash = announcement.hash;
        const orderExecutionTime = Date.now();
        
        for (const token of tokens) {
            const symbol = `${token}USDT`;
            const tradeStartTime = Date.now();
            
            try {
                const tradableNow = await this.binance.isSymbolTradable(symbol).catch(() => true);
                if (!tradableNow) {
                    const tradableAfterRefresh = await this.binance.isSymbolTradable(symbol, true).catch(() => false);
                    if (!tradableAfterRefresh) {
                        throw new Error('Symbol is not tradable on Binance Futures');
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
                
                // Set leverage (fast - non-blocking)
                this.binance.changeInitialLeverage(symbol, this.config.leverage).catch((error) => {
                    console.warn(`[LEVERAGE] ${symbol} set failed: ${error.message}`);
                });
                
                // Place order with TP/SL using fast retry
                const tradeFn = isShort
                    ? () => this.binance.trading.marketSellWithTPSL(
                        symbol,
                        this.config.amount,
                        takeProfitPercent,
                        this.config.stopLossPercent,
                        'BOTH',
                        precision
                    )
                    : () => this.binance.trading.marketBuyWithTPSL(
                        symbol,
                        this.config.amount,
                        takeProfitPercent,
                        this.config.stopLossPercent,
                        'BOTH',
                        precision
                    );

                const order = await this.sniperRetry(tradeFn, 20, 50);
                const tradeDuration = Date.now() - tradeStartTime;
                
                const result = {
                    token,
                    symbol,
                    success: true,
                    orderId: order.orderId,
                    avgPrice: order.avgPrice,
                    executedQty: order.executedQty,
                    quantity: order.quantity,
                    duration: tradeDuration,
                    leverage: this.config.leverage,
                    amount: this.config.amount,
                    entryPrice: order.entryPrice,
                    stopLoss: order.stopLossPrice,
                    takeProfit: order.takeProfitPrice,
                    stopLossOrderId: order.stopLossOrderId,
                    takeProfitOrderId: order.takeProfitOrderId
                };
                
                tradeResults.push(result);
                
                // Record order execution in storage with millisecond precision (non-blocking)
                if (announcementHash) {
                    const sourceExchange = announcement.exchange === 'BINANCE' ? 'BINANCE' : 'UPBIT';
                    storage.recordOrderExecution(announcementHash, orderExecutionTime, sourceExchange);
                    // Save async without blocking trade flow
                    if (sourceExchange === 'BINANCE') {
                        storage.saveBinance().catch(() => {});
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
        }
        
        const totalDuration = Date.now() - executionStartTime;
        perfOptimizer.recordMetric('tradingExecution', totalDuration);
        
        return tradeResults.length > 0 ? tradeResults : null;
    }
    
    getPerformanceStats() {
        return perfOptimizer.getStats();
    }
}

module.exports = new LightningAutoTrader();
