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
    async executeLight(announcement1) {
        const announcement = {
  hash: 'bb55240c85b0ac68b02a6fac743de1f4',
  exchange: 'UPBIT',
  category: 'LISTING',
  title: '디피니티브(EDGE) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
  url: 'https://upbit.com/notice',
  symbol: 'PIEVERSEUSDT',
  releaseDate: 1772603400000,
  tokens: [ 'PIEVERSE' ],
  formattedDate: '3/4/2026, 14:50:00 (KST)',
  metadata: {
    symbol: 'PIEVERSEUSDT',
    title: '디피니티브(EDGE) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
    link: 'https://upbit.com/notice',
    exchange: 'UPBIT',
    detectedAt: 1772765541466,
    orderedAt: null,
    latency: null
  },
  detectedAt: 1772765541466,
  _shouldTrade: true
}

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
                
                // Get precision for formatting prices (SL/TP)
                const precision = await fastCache.getSymbolPrecision(symbol, this.binance).catch(error => {
                    console.log(`⚠️ ${symbol} unavailable`);
                    throw error;
                });
                
                if (!precision) {
                    throw new Error('No precision data');
                }
                
                // Set leverage (fast - non-blocking)
                this.binance.changeInitialLeverage(symbol, this.config.leverage).catch(() => {});
                
                // Place order by USDT amount with TP/SL using ROI%
                const usdtAmount = this.config.amount;
                const order = await this.binance.marketBuy(
                    symbol, 
                    usdtAmount, 
                    'BOTH', 
                    true,
                    // takeProfit with callbackRate (ROI%)
                    {
                        type: 'MARKET',
                        stopPrice: undefined,
                        callbackRate: this.config.takeProfitPercent
                    },
                    // stopLoss with callbackRate (ROI%)
                    {
                        type: 'MARKET',
                        stopPrice: undefined,
                        callbackRate: this.config.stopLossPercent
                    }
                );
                const tradeDuration = Date.now() - tradeStartTime;
                
                const entryPrice = parseFloat(order.avgPrice);
                const executedQty = parseFloat(order.executedQty);
                
                const result = {
                    token,
                    symbol,
                    success: true,
                    orderId: order.orderId,
                    avgPrice: order.avgPrice,
                    executedQty: order.executedQty,
                    duration: tradeDuration,
                    leverage: this.config.leverage,
                    amount: this.config.amount,
                    stopLoss: `-${this.config.stopLossPercent}%`,
                    takeProfit: `+${this.config.takeProfitPercent}%`
                };
                
                tradeResults.push(result);
                console.log(`✅ [TRADE] ${symbol} in ${tradeDuration}ms`);
                console.log(`   📉 SL: ${result.stopLoss}`);
                console.log(`   📈 TP: ${result.takeProfit}`);
                
                // Record order execution in storage with millisecond precision
                if (announcementHash) {
                    storage.recordOrderExecution(announcementHash, orderExecutionTime, 'UPBIT');
                    await storage.saveUpbit().catch(err =>
                        console.error('❌ Storage save error:', err.message)
                    );
                }
                
                // Send notification asynchronously (non-blocking)
                // const tradeMessage = telegram.createTradeMessage(result);
                // this.queueTelegramMessage(tradeMessage);
                
                // No delay between trades - send immediately
                
            } catch (error) {
                console.log(error)
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
