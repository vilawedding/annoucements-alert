const config = require('../../config/config');
const trading = require('../trading');
const telegram = require('../notifications');

/**
 * Auto-Trader - Automated trading on announcements
 */

class AutoTrader {
    constructor() {
        this.config = config.autoTrade;
        this.binance = trading.binance;
    }
    
    async execute(announcement) {
        if (!this.config.enabled) {
            return null;
        }
        
        if (announcement.exchange !== 'UPBIT' || announcement.category !== 'LISTING') {
            return null;
        }
        
        if (!this.config.upbitListing) {
            console.log('⚠️ Auto-trade for Upbit listing is disabled');
            return null;
        }
        
        const tokens = announcement.tokens;
        if (!tokens || tokens.length === 0) {
            console.log('⚠️ No tokens found in announcement');
            return null;
        }
        
        const tradeResults = [];
        
        for (const token of tokens) {
            const symbol = `${token}USDT`;
            const tradeStart = Date.now();
            
            try {
                console.log(`\n🤖 [AUTO-TRADE] Starting trade for ${symbol}...`);
                
                // Check if symbol exists
                try {
                    const price = await this.binance.getPrice(symbol);
                    console.log(`   💰 Current price: ${price.price}`);
                } catch (error) {
                    console.log(`   ⚠️ ${symbol} not available on Binance Futures`);
                    tradeResults.push({
                        token,
                        symbol,
                        success: false,
                        error: 'Symbol not available'
                    });
                    continue;
                }
                
                // Get symbol precision
                const precision = await this.binance.getSymbolPrecision(symbol);
                
                // Set leverage
                try {
                    await this.binance.changeInitialLeverage(symbol, this.config.leverage);
                    console.log(`   ⚙️ Leverage set to ${this.config.leverage}x`);
                } catch (error) {
                    console.log(`   ⚠️ Could not set leverage: ${error.message}`);
                }
                
                // Calculate quantity
                const priceData = await this.binance.getPrice(symbol);
                const currentPrice = parseFloat(priceData.price);
                const quantity = this.config.amount / currentPrice;
                const formattedQty = this.binance.formatQuantity(quantity, precision.quantityPrecision);
                
                console.log(`   📊 Order: BUY ${formattedQty} ${symbol} (≈${this.config.amount} USDT)`);
                
                // Place market buy order
                const order = await this.binance.marketBuy(symbol, formattedQty);
                const tradeDuration = Date.now() - tradeStart;
                
                console.log(`   ✅ Order executed in ${tradeDuration}ms`);
                console.log(`   📝 Order ID: ${order.orderId}`);
                console.log(`   💵 Avg Price: ${order.avgPrice}`);
                console.log(`   📦 Filled: ${order.executedQty}`);
                
                const tradeResult = {
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
                
                tradeResults.push(tradeResult);
                
                // Send success notification
                const tradeMessage = telegram.createTradeMessage(tradeResult);
                await telegram.sendMessage(tradeMessage);
                
                await new Promise(resolve => setTimeout(resolve, 200));
                
            } catch (error) {
                const tradeDuration = Date.now() - tradeStart;
                console.error(`   ❌ Trade failed (${tradeDuration}ms):`, error.response?.data || error.message);
                
                tradeResults.push({
                    token,
                    symbol,
                    success: false,
                    error: error.message,
                    duration: tradeDuration
                });
                
                // Send error notification
                const errorMessage = telegram.createErrorMessage(token, symbol, error.message);
                await telegram.sendMessage(errorMessage);
            }
        }
        
        return tradeResults;
    }
}

module.exports = new AutoTrader();
