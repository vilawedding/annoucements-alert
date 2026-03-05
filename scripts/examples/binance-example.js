/**
 * Binance Futures Trading API - Usage Examples
 * 
 * Setup:
 * 1. Add to .env file:
 *    BINANCE_API_KEY=your_api_key
 *    BINANCE_API_SECRET=your_api_secret
 *    BINANCE_USE_TESTNET=true  # Use testnet for safety
 * 
 * 2. Run: npm run example:binance
 */

const binance = require('../legacy/binance-trading');

// ==================== EXAMPLES ====================

/**
 * Example 1: Test API connection
 */
async function example1_testConnection() {
    console.log('\n=== Example 1: Test Connection ===');
    
    try {
        await binance.testConnectivity();
        console.log('✅ API connection successful');
        
        const serverTime = await binance.getServerTime();
        console.log('⏰ Server time:', new Date(serverTime).toISOString());
        
        console.log(`🌐 Using: ${binance.USE_TESTNET ? 'TESTNET' : 'PRODUCTION'}`);
        console.log(`🔗 Base URL: ${binance.BASE_URL}`);
        
    } catch (error) {
        console.error('❌ Connection failed:', error.message);
    }
}

/**
 * Example 2: Get market data
 */
async function example2_getMarketData() {
    console.log('\n=== Example 2: Get Market Data ===');
    
    const symbol = 'BTCUSDT';
    
    try {
        // Get current price
        const price = await binance.getPrice(symbol);
        console.log(`💰 ${symbol} Price:`, price.price);
        
        // Get 24hr ticker
        const ticker = await binance.get24hrTicker(symbol);
        console.log(`📊 24h Change: ${ticker.priceChangePercent}%`);
        console.log(`📈 24h High: ${ticker.highPrice}`);
        console.log(`📉 24h Low: ${ticker.lowPrice}`);
        console.log(`💵 24h Volume: ${ticker.volume}`);
        
        // Get best bid/ask
        const bookTicker = await binance.getBookTicker(symbol);
        console.log(`🔵 Best Bid: ${bookTicker.bidPrice} (${bookTicker.bidQty})`);
        console.log(`🔴 Best Ask: ${bookTicker.askPrice} (${bookTicker.askQty})`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

/**
 * Example 3: Get account info
 */
async function example3_getAccountInfo() {
    console.log('\n=== Example 3: Get Account Info ===');
    
    try {
        // Get balance
        const balance = await binance.getBalance();
        console.log('💰 Account Balance:');
        balance.forEach(asset => {
            if (parseFloat(asset.balance) > 0) {
                console.log(`   ${asset.asset}: ${asset.balance} (Available: ${asset.availableBalance})`);
            }
        });
        
        // Get positions
        const positions = await binance.getPositionInfo();
        console.log('\n📊 Open Positions:');
        positions.forEach(pos => {
            const posAmt = parseFloat(pos.positionAmt);
            if (posAmt !== 0) {
                console.log(`   ${pos.symbol}: ${posAmt} @ ${pos.entryPrice} | PnL: ${pos.unRealizedProfit}`);
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

/**
 * Example 4: Place orders (TESTNET ONLY)
 */
async function example4_placeOrders() {
    console.log('\n=== Example 4: Place Orders (Testnet) ===');
    
    if (!binance.USE_TESTNET) {
        console.log('⚠️ Skipping order placement - not on testnet');
        return;
    }
    
    const symbol = 'BTCUSDT';
    
    try {
        // Get current price
        const priceData = await binance.getPrice(symbol);
        const currentPrice = parseFloat(priceData.price);
        console.log(`💰 Current Price: ${currentPrice}`);
        
        // Get symbol precision
        const precision = await binance.getSymbolPrecision(symbol);
        console.log(`🔧 Price Precision: ${precision.pricePrecision}`);
        console.log(`🔧 Quantity Precision: ${precision.quantityPrecision}`);
        
        // Set leverage
        await binance.changeInitialLeverage(symbol, 10);
        console.log('⚙️ Leverage set to 10x');
        
        // Place limit buy order (below current price)
        const buyPrice = binance.formatPrice(currentPrice * 0.98, precision.pricePrecision);
        const quantity = binance.formatQuantity(0.001, precision.quantityPrecision);
        
        console.log(`\n📝 Placing LIMIT BUY: ${quantity} @ ${buyPrice}`);
        const buyOrder = await binance.limitBuy(symbol, quantity, buyPrice);
        console.log('✅ Buy Order placed:', buyOrder.orderId);
        
        // Get open orders
        const openOrders = await binance.getOpenOrders(symbol);
        console.log(`\n📋 Open Orders: ${openOrders.length}`);
        openOrders.forEach(order => {
            console.log(`   Order ${order.orderId}: ${order.side} ${order.origQty} @ ${order.price}`);
        });
        
        // Cancel the order
        if (openOrders.length > 0) {
            console.log(`\n❌ Canceling order ${buyOrder.orderId}...`);
            await binance.cancelOrder(symbol, buyOrder.orderId);
            console.log('✅ Order canceled');
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.response?.data || error);
    }
}

/**
 * Example 5: Market order example (TESTNET ONLY)
 */
async function example5_marketOrder() {
    console.log('\n=== Example 5: Market Order (Testnet) ===');
    
    if (!binance.USE_TESTNET) {
        console.log('⚠️ Skipping market order - not on testnet');
        return;
    }
    
    const symbol = 'BTCUSDT';
    
    try {
        const precision = await binance.getSymbolPrecision(symbol);
        const quantity = binance.formatQuantity(0.001, precision.quantityPrecision);
        
        console.log(`\n🚀 Placing MARKET BUY: ${quantity}`);
        const order = await binance.marketBuy(symbol, quantity);
        console.log('✅ Market Buy executed:', order.orderId);
        console.log(`   Filled: ${order.executedQty} @ avg ${order.avgPrice}`);
        
        // Check position
        const positions = await binance.getPositionInfo(symbol);
        const position = positions.find(p => p.symbol === symbol);
        console.log(`\n📊 Position: ${position.positionAmt} @ ${position.entryPrice}`);
        
        // Close position
        if (parseFloat(position.positionAmt) !== 0) {
            console.log('\n🔒 Closing position...');
            const closeOrder = await binance.closePosition(symbol);
            console.log('✅ Position closed:', closeOrder.orderId);
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.response?.data || error);
    }
}

/**
 * Example 6: Monitor position and PnL
 */
async function example6_monitorPosition() {
    console.log('\n=== Example 6: Monitor Position ===');
    
    const symbol = 'BTCUSDT';
    
    try {
        const positions = await binance.getPositionInfo(symbol);
        const position = positions.find(p => p.symbol === symbol);
        
        if (!position || parseFloat(position.positionAmt) === 0) {
            console.log('ℹ️ No open position');
            return;
        }
        
        const posAmt = parseFloat(position.positionAmt);
        const entryPrice = parseFloat(position.entryPrice);
        const markPrice = parseFloat(position.markPrice);
        const unrealizedPnL = parseFloat(position.unRealizedProfit);
        const pnlPercent = (unrealizedPnL / (Math.abs(posAmt) * entryPrice)) * 100;
        
        console.log('📊 Position Details:');
        console.log(`   Symbol: ${symbol}`);
        console.log(`   Size: ${posAmt} (${posAmt > 0 ? 'LONG' : 'SHORT'})`);
        console.log(`   Entry Price: ${entryPrice}`);
        console.log(`   Mark Price: ${markPrice}`);
        console.log(`   Unrealized PnL: ${unrealizedPnL} USDT (${pnlPercent.toFixed(2)}%)`);
        console.log(`   Leverage: ${position.leverage}x`);
        console.log(`   Margin Type: ${position.marginType}`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

// ==================== RUN EXAMPLES ====================

async function runAllExamples() {
    console.log('🤖 BINANCE FUTURES API EXAMPLES');
    console.log('================================\n');
    
    // Run examples sequentially
    await example1_testConnection();
    await example2_getMarketData();
    await example3_getAccountInfo();
    await example4_placeOrders();
    // await example5_marketOrder(); // Uncomment to test market orders
    await example6_monitorPosition();
    
    console.log('\n✅ All examples completed!');
}

// Run if called directly
if (require.main === module) {
    runAllExamples().catch(error => {
        console.error('💥 Fatal error:', error);
        process.exit(1);
    });
}

module.exports = {
    example1_testConnection,
    example2_getMarketData,
    example3_getAccountInfo,
    example4_placeOrders,
    example5_marketOrder,
    example6_monitorPosition
};
