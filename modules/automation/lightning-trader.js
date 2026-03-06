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
                // Silent fail
            }
            await new Promise(resolve => setTimeout(resolve, 100));
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
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        throw lastError || new Error('Trading not available');
    }
    
    /**
     * Execute trade with maximum speed
     */
    async executeLight(announcement1) {
//         const announcement = {
//   hash: 'bb55240c85b0ac68b02a6fac743de1f4',
//   exchange: 'UPBIT',
//   category: 'LISTING',
//   title: '디피니티브(EDGE) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
//   url: 'https://upbit.com/notice',
//   symbol: 'DOTUSDT',
//   releaseDate: 1772603400000,
//   tokens: [ 'DOT' ],
//   formattedDate: '3/4/2026, 14:50:00 (KST)',
//   metadata: {
//     symbol: 'DOTUSDT',
//     title: '디피니티브(EDGE) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
//     link: 'https://upbit.com/notice',
//     exchange: 'UPBIT',
//     detectedAt: 1772765541466,
//     orderedAt: null,
//     latency: null
//   },
//   detectedAt: 1772765541466,
//   _shouldTrade: true
// }

        if (!this.config.enabled) return null;
        if (announcement.exchange !== 'UPBIT' || announcement.category !== 'LISTING') return null;
        if (!this.config.upbitListing) return null;
        
        const tokens = (announcement.tokens && announcement.tokens.length > 0)
            ? announcement.tokens
            : this.extractTokensFast(announcement.title || '');
        if (tokens.length === 0) return null;
        
        const executionStartTime = Date.now();
        const tradeResults = [];
        const announcementHash = announcement.hash;
        const orderExecutionTime = Date.now();
        
        for (const token of tokens) {
            const symbol = `${token}USDT`;
            const tradeStartTime = Date.now();
            
            try {
                
                // Get precision for TP/SL calculation
                const precision = await fastCache.getSymbolPrecision(symbol, this.binance).catch(error => {
                    throw error;
                });
                
                if (!precision) {
                    throw new Error('No precision data');
                }
                
                // Set leverage (fast - non-blocking)
                this.binance.changeInitialLeverage(symbol, this.config.leverage).catch(() => {});
                
                // Place BUY order with TP/SL using fast retry (listing race condition)
                const order = await this.sniperRetry(
                    () => this.binance.trading.marketBuyWithTPSL(
                        symbol,
                        this.config.amount,
                        this.config.takeProfitPercent,
                        this.config.stopLossPercent,
                        'BOTH',
                        precision
                    ),
                    20,
                    50
                );
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
                
                // Record order execution in storage with millisecond precision
                if (announcementHash) {
                    storage.recordOrderExecution(announcementHash, orderExecutionTime, 'UPBIT');
                    await storage.saveUpbit().catch(err => {});
                }
                
            } catch (error) {
                const tradeDuration = Date.now() - tradeStartTime;
                
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
