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
                console.error('❌ Telegram queue error:', error.message);
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
    
    /**
     * Execute trade with maximum speed
     */
    async executeLight(announcement) {
        if (!this.config.enabled) return null;
        if (announcement.exchange !== 'UPBIT' || announcement.category !== 'LISTING') return null;
        if (!this.config.upbitListing) return null;
        
        const tokens = announcement.tokens || [];
        if (tokens.length === 0) return null;
        
        const executionStartTime = Date.now();
        const tradeResults = [];
        const announcementHash = announcement.hash;
        const orderExecutionTime = Date.now();
        
        for (const token of tokens) {
            const symbol = `${token}USDT`;
            const tradeStartTime = Date.now();
            
            try {
                console.log(`🚀 [TRADE] ${symbol}`);
                
                // Parallel operations for speed
                const [priceData, precision] = await Promise.all([
                    this.binance.getPrice(symbol).catch(() => null),
                    fastCache.getSymbolPrecision(symbol, this.binance)
                ]).catch(error => {
                    console.log(`⚠️ ${symbol} unavailable`);
                    throw error;
                });
                
                if (!priceData || !precision) {
                    throw new Error('No price data');
                }
                
                const currentPrice = parseFloat(priceData.price);
                if (currentPrice <= 0) throw new Error('Invalid price');
                
                // Fast quantity calculation
                const quantity = this.binance.formatQuantity(
                    this.config.amount / currentPrice,
                    precision.quantityPrecision
                );
                
                // Set leverage (fast - non-blocking)
                this.binance.changeInitialLeverage(symbol, this.config.leverage).catch(() => {});
                
                // Place order immediately (most critical step)
                const order = await this.binance.marketBuy(symbol, quantity);
                const tradeDuration = Date.now() - tradeStartTime;
                
                const result = {
                    token,
                    symbol,
                    success: true,
                    orderId: order.orderId,
                    avgPrice: order.avgPrice,
                    executedQty: order.executedQty,
                    duration: tradeDuration,
                    leverage: this.config.leverage,
                    amount: this.config.amount
                };
                
                tradeResults.push(result);
                console.log(`✅ [TRADE] ${symbol} in ${tradeDuration}ms`);
                
                // Record order execution in storage with millisecond precision
                if (announcementHash) {
                    storage.recordOrderExecution(announcementHash, orderExecutionTime, 'UPBIT');
                    await storage.saveUpbit().catch(err =>
                        console.error('❌ Storage save error:', err.message)
                    );
                }
                
                // Send notification asynchronously (non-blocking)
                const tradeMessage = telegram.createTradeMessage(result);
                this.queueTelegramMessage(tradeMessage);
                
                // No delay between trades - send immediately
                
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
                console.error(`❌ [TRADE] ${symbol} failed (${tradeDuration}ms): ${error.message}`);
                
                // Send error notification asynchronously
                const errorMessage = telegram.createErrorMessage(token, symbol, error.message);
                this.queueTelegramMessage(errorMessage);
            }
        }
        
        const totalDuration = Date.now() - executionStartTime;
        perfOptimizer.recordMetric('tradingExecution', totalDuration);
        
        console.log(`⚡ Total execution: ${totalDuration}ms for ${tokens.length} tokens`);
        
        return tradeResults.length > 0 ? tradeResults : null;
    }
    
    getPerformanceStats() {
        return perfOptimizer.getStats();
    }
}

module.exports = new LightningAutoTrader();
