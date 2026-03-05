/**
 * Test Auto-Trading Functionality
 * This script simulates an Upbit listing announcement and tests the auto-trade execution
 */

require('dotenv').config();
const binance = require('../legacy/binance-trading');

// Mock announcement object (giống như Upbit listing)
const mockUpbitListing = {
    hash: 'test-hash-12345',
    exchange: 'UPBIT',
    category: 'LISTING',
    title: '페페(PEPE) 원화 마켓 신규 거래지원 안내',
    url: 'https://upbit.com/notice',
    releaseDate: Date.now(),
    tokens: ['PEPE'], // Test với PEPE - token phổ biến
    formattedDate: new Date().toLocaleString()
};

// Import executeAutoTrade function (we'll need to expose it)
// For testing, we'll recreate the logic here

const AUTO_TRADE_ENABLED = process.env.AUTO_TRADE_ENABLED === 'true';
const AUTO_TRADE_AMOUNT = parseFloat(process.env.AUTO_TRADE_AMOUNT) || 10;
const AUTO_TRADE_LEVERAGE = parseInt(process.env.AUTO_TRADE_LEVERAGE) || 5;

async function testAutoTrade(announcement) {
    console.log('\n🧪 TESTING AUTO-TRADE FUNCTIONALITY');
    console.log('═══════════════════════════════════\n');
    
    console.log('📋 Test Configuration:');
    console.log(`   AUTO_TRADE_ENABLED: ${AUTO_TRADE_ENABLED}`);
    console.log(`   AUTO_TRADE_AMOUNT: ${AUTO_TRADE_AMOUNT} USDT`);
    console.log(`   AUTO_TRADE_LEVERAGE: ${AUTO_TRADE_LEVERAGE}x`);
    console.log(`   BINANCE_USE_TESTNET: ${binance.USE_TESTNET}`);
    console.log(`   BINANCE_BASE_URL: ${binance.BASE_URL}\n`);
    
    if (!AUTO_TRADE_ENABLED) {
        console.log('⚠️ AUTO_TRADE_ENABLED is false. Please enable it in .env file:');
        console.log('   AUTO_TRADE_ENABLED=true\n');
        return;
    }
    
    console.log('📢 Mock Announcement:');
    console.log(`   Exchange: ${announcement.exchange}`);
    console.log(`   Category: ${announcement.category}`);
    console.log(`   Title: ${announcement.title}`);
    console.log(`   Tokens: ${announcement.tokens.join(', ')}\n`);
    
    // Step 1: Test API connection
    console.log('🔗 Step 1: Testing Binance API connection...');
    try {
        await binance.testConnectivity();
        const serverTime = await binance.getServerTime();
        console.log(`   ✅ Connected to Binance (${binance.USE_TESTNET ? 'TESTNET' : 'PRODUCTION'})`);
        console.log(`   ⏰ Server time: ${new Date(serverTime).toISOString()}\n`);
    } catch (error) {
        console.error('   ❌ Connection failed:', error.message);
        console.log('\n⚠️ Please check your BINANCE_API_KEY and BINANCE_API_SECRET in .env\n');
        return;
    }
    
    // Step 2: Check account balance
    console.log('💰 Step 2: Checking account balance...');
    try {
        const balance = await binance.getBalance();
        const usdtBalance = balance.find(b => b.asset === 'USDT');
        if (usdtBalance) {
            console.log(`   ✅ USDT Balance: ${usdtBalance.balance} (Available: ${usdtBalance.availableBalance})`);
            
            if (parseFloat(usdtBalance.availableBalance) < AUTO_TRADE_AMOUNT) {
                console.log(`   ⚠️ Insufficient balance for ${AUTO_TRADE_AMOUNT} USDT trade`);
                if (binance.USE_TESTNET) {
                    console.log('   💡 Get free testnet USDT at: https://testnet.binancefuture.com/\n');
                }
                return;
            }
        }
        console.log();
    } catch (error) {
        console.error('   ❌ Failed to get balance:', error.message);
        console.log();
    }
    
    // Step 3: Process each token
    for (const token of announcement.tokens) {
        const symbol = `${token}USDT`;
        console.log(`\n🎯 Step 3: Processing ${symbol}...`);
        
        try {
            // Check if symbol exists
            console.log(`   📊 Checking if ${symbol} exists on Binance Futures...`);
            const priceData = await binance.getPrice(symbol);
            const currentPrice = parseFloat(priceData.price);
            console.log(`   ✅ ${symbol} is available!`);
            console.log(`   💰 Current Price: ${currentPrice}\n`);
            
            // Get symbol precision
            console.log(`   🔧 Getting symbol precision...`);
            const precision = await binance.getSymbolPrecision(symbol);
            console.log(`   ✅ Price Precision: ${precision.pricePrecision}`);
            console.log(`   ✅ Quantity Precision: ${precision.quantityPrecision}\n`);
            
            // Set leverage
            console.log(`   ⚙️ Setting leverage to ${AUTO_TRADE_LEVERAGE}x...`);
            try {
                await binance.changeInitialLeverage(symbol, AUTO_TRADE_LEVERAGE);
                console.log(`   ✅ Leverage set successfully\n`);
            } catch (error) {
                console.log(`   ⚠️ Leverage setting: ${error.message} (may already be set)\n`);
            }
            
            // Calculate quantity
            const quantity = AUTO_TRADE_AMOUNT / currentPrice;
            const formattedQty = binance.formatQuantity(quantity, precision.quantityPrecision);
            console.log(`   📐 Calculating order quantity...`);
            console.log(`   💵 Amount: ${AUTO_TRADE_AMOUNT} USDT`);
            console.log(`   💱 Price: ${currentPrice}`);
            console.log(`   📦 Quantity: ${formattedQty} ${token}\n`);
            
            // Confirm order
            console.log('   ⚠️ READY TO PLACE ORDER:');
            console.log(`   Symbol: ${symbol}`);
            console.log(`   Side: LONG (MARKET BUY)`);
            console.log(`   Quantity: ${formattedQty}`);
            console.log(`   Leverage: ${AUTO_TRADE_LEVERAGE}x`);
            console.log(`   Estimated Value: ~${AUTO_TRADE_AMOUNT} USDT\n`);
            
            // Place order (confirm first)
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            await new Promise((resolve) => {
                readline.question('   ❓ Place this order? (yes/no): ', async (answer) => {
                    readline.close();
                    
                    if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
                        try {
                            console.log('\n   🚀 Placing MARKET BUY order...');
                            const orderStart = Date.now();
                            
                            const order = await binance.marketBuy(symbol, formattedQty);
                            const orderDuration = Date.now() - orderStart;
                            
                            console.log(`\n   ✅ ORDER EXECUTED! (${orderDuration}ms)`);
                            console.log('   ═══════════════════════════════');
                            console.log(`   📝 Order ID: ${order.orderId}`);
                            console.log(`   💰 Avg Price: ${order.avgPrice}`);
                            console.log(`   📦 Filled Qty: ${order.executedQty}`);
                            console.log(`   💵 Total Value: ${parseFloat(order.executedQty) * parseFloat(order.avgPrice)} USDT`);
                            console.log(`   📊 Status: ${order.status}\n`);
                            
                            // Check position
                            console.log('   📊 Checking position...');
                            const positions = await binance.getPositionInfo(symbol);
                            const position = positions.find(p => p.symbol === symbol);
                            if (position && parseFloat(position.positionAmt) !== 0) {
                                console.log(`   ✅ Position opened:`);
                                console.log(`      Size: ${position.positionAmt}`);
                                console.log(`      Entry Price: ${position.entryPrice}`);
                                console.log(`      Mark Price: ${position.markPrice}`);
                                console.log(`      Unrealized PnL: ${position.unRealizedProfit} USDT\n`);
                                
                                // Ask if want to close position
                                const readline2 = require('readline').createInterface({
                                    input: process.stdin,
                                    output: process.stdout
                                });
                                
                                readline2.question('   ❓ Close position now? (yes/no): ', async (closeAnswer) => {
                                    readline2.close();
                                    
                                    if (closeAnswer.toLowerCase() === 'yes' || closeAnswer.toLowerCase() === 'y') {
                                        try {
                                            console.log('\n   🔒 Closing position...');
                                            const closeOrder = await binance.closePosition(symbol);
                                            console.log(`   ✅ Position closed!`);
                                            console.log(`   📝 Close Order ID: ${closeOrder.orderId}\n`);
                                        } catch (error) {
                                            console.error(`   ❌ Failed to close position:`, error.message);
                                        }
                                    } else {
                                        console.log('\n   ℹ️ Position left open. Close it manually when ready.\n');
                                    }
                                    resolve();
                                });
                            } else {
                                resolve();
                            }
                            
                        } catch (error) {
                            console.error(`\n   ❌ ORDER FAILED:`, error.response?.data || error.message);
                            resolve();
                        }
                    } else {
                        console.log('\n   ❌ Order cancelled by user.\n');
                        resolve();
                    }
                });
            });
            
        } catch (error) {
            if (error.response?.status === 404 || error.response?.data?.code === -1121) {
                console.log(`   ⚠️ ${symbol} not available on Binance Futures`);
                console.log(`   💡 Try a different token (BTC, ETH, PEPE, etc.)\n`);
            } else {
                console.error(`   ❌ Error:`, error.response?.data || error.message);
            }
        }
    }
    
    console.log('\n✅ Test completed!\n');
}

// Run test
async function main() {
    try {
        await testAutoTrade(mockUpbitListing);
    } catch (error) {
        console.error('💥 Test failed:', error);
    }
    process.exit(0);
}

main();
