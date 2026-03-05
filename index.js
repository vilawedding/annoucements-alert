require('dotenv').config();
const config = require('./config/config');
const storage = require('./modules/storage');
const monitoring = require('./modules/monitoring');
const lightningTrader = require('./modules/automation/lightning-trader');
const http = require('http');

//npx kill-port 3003 && node --require ./preload.js index-new.js

/**
 * Multi-Exchange Crypto Monitor Bot - Lightning Fast Edition
 * Optimized for ultra-low latency: Alert → Trade in <1 second
 */

// ==================== HEALTH SERVER ====================
function startHealthServer() {
    const server = http.createServer((req, res) => {
        const stats = storage.getStats();
        const perfStats = lightningTrader.getPerformanceStats();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            service: 'Multi-Exchange Crypto Monitor (Lightning Fast)',
            uptime: process.uptime(),
            lastCheck: new Date().toISOString(),
            exchanges: [
                {
                    name: config.exchanges.binance.name,
                    enabled: config.exchanges.binance.enabled,
                    interval: `${config.exchanges.binance.interval}ms`
                },
                {
                    name: config.exchanges.upbit.name,
                    enabled: config.exchanges.upbit.enabled,
                    interval: `${config.exchanges.upbit.interval}ms`
                }
            ],
            autoTrade: {
                enabled: config.autoTrade.enabled,
                amount: config.autoTrade.amount,
                leverage: config.autoTrade.leverage
            },
            stats: {
                totalSent: stats.total,
                binanceSent: stats.binance,
                upbitSent: stats.upbit
            },
            performance: {
                announcementDetection: perfStats.announcementDetection,
                tokenExtraction: perfStats.tokenExtraction,
                tradingExecution: perfStats.tradingExecution,
                totalLatency: perfStats.totalLatency
            }
        }));
    });
    
    server.listen(config.server.port, () => {
        console.log(`🚀 Health server running on port ${config.server.port}`);
        console.log(`   📊 Check performance: curl http://localhost:${config.server.port}`);
    });
}

// ==================== MONITOR RUNNERS ====================
async function runBinanceMonitor() {
    let cycleCount = 0;
    while (true) {
        cycleCount++;
        const startTime = Date.now();
        try {
            const result = await monitoring.binance.check();
            const duration = Date.now() - startTime;
            if (result.processed > 0 || duration > 500) {
                console.log(`🟡 [BIN] Cycle #${cycleCount} - ${duration}ms (${result.processed}/${result.sent})`);
            }
        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`❌ [BIN] Cycle #${cycleCount} - ${duration}ms - Error: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, config.exchanges.binance.interval));
    }
}

async function runUpbitMonitor() {
    let cycleCount = 0;
    while (true) {
        cycleCount++;
        const startTime = Date.now();
        try {
            const result = await monitoring.upbit.check();
            const duration = Date.now() - startTime;
            
            if (result.processed > 0 || duration > 500) {
                console.log(`🔵 [UPB] Cycle #${cycleCount} - ${duration}ms (${result.processed}/${result.sent})`);
            }
            
            // Trigger lightning-fast auto-trade if listing detected
            if (config.autoTrade.enabled && result.announcement && result.announcement._shouldTrade) {
                const tradeStartTime = Date.now();
                console.log(`⚡ [AUTO-TRADE] Triggering for Upbit listing...`);
                
                const tradeResults = await lightningTrader.executeLight(result.announcement);
                
                if (tradeResults && tradeResults.length > 0) {
                    const tradeDuration = Date.now() - tradeStartTime;
                    const successCount = tradeResults.filter(r => r.success).length;
                    console.log(`✅ [AUTO-TRADE] Completed ${successCount}/${tradeResults.length} trades in ${tradeDuration}ms`);
                }
            }
        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`❌ [UPB] Cycle #${cycleCount} - ${duration}ms - Error: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, config.exchanges.upbit.interval));
    }
}

// ==================== MAIN FUNCTION ====================
async function main() {
    console.log(`
    ⚡ MULTI-EXCHANGE CRYPTO MONITOR - LIGHTNING FAST
    ================================================
    Alert → Trade in <1 second
    `);
    
    // Validate configuration
    if (!config.telegram.botToken || !config.telegram.chatId) {
        console.error(`
    ❌ CONFIGURATION ERROR
    ======================
    Please configure the following in .env file:
    
    TELEGRAM_BOT_TOKEN=your_bot_token_here
    TELEGRAM_CHAT_ID=your_chat_id_here
    
    Optional configuration:
    BINANCE_ENABLED=true           # Enable Binance monitoring
    UPBIT_ENABLED=true             # Enable Upbit monitoring
    BINANCE_INTERVAL=500           # Binance check interval in ms
    UPBIT_INTERVAL=500             # Upbit check interval in ms
    
    Auto-trading configuration:
    AUTO_TRADE_ENABLED=true        # Enable auto-trading
    AUTO_TRADE_UPBIT_LISTING=true  # Trade on Upbit listings
    AUTO_TRADE_AMOUNT=10           # Trade amount in USDT
    AUTO_TRADE_LEVERAGE=5          # Leverage for futures
    BINANCE_API_KEY=...            # Required for auto-trading
    BINANCE_API_SECRET=...         # Required for auto-trading
    BINANCE_USE_TESTNET=true       # Use testnet for safety
        `);
        process.exit(1);
    }
    
    console.log(`✅ Configuration loaded`);
    console.log(`🤖 Telegram Bot: Connected`);
    console.log(`\n📊 Enabled exchanges:`);
    console.log(`   ${config.exchanges.binance.enabled ? '✅' : '❌'} ${config.exchanges.binance.name} (${config.exchanges.binance.interval}ms interval)`);
    console.log(`   ${config.exchanges.upbit.enabled ? '✅' : '❌'} ${config.exchanges.upbit.name} (${config.exchanges.upbit.interval}ms interval)`);
    
    console.log(`\n⚡ Auto-trading (Lightning Fast):`);
    console.log(`   ${config.autoTrade.enabled ? '✅' : '❌'} Auto-trade ${config.autoTrade.enabled ? 'ENABLED' : 'DISABLED'}`);
    if (config.autoTrade.enabled) {
        console.log(`   💰 Trade Amount: ${config.autoTrade.amount} USDT`);
        console.log(`   📊 Leverage: ${config.autoTrade.leverage}x`);
        console.log(`   🔵 Upbit Listing: ${config.autoTrade.upbitListing ? 'ENABLED' : 'DISABLED'}`);
        
        const trading = require('./modules/trading');
        console.log(`   🌐 Binance: ${trading.binance.USE_TESTNET ? 'TESTNET' : 'PRODUCTION'}`);
        
        console.log(`\n⚡ Optimizations enabled:`);
        console.log(`   ✅ Non-blocking Telegram queue`);
        console.log(`   ✅ Parallel price & precision fetching`);
        console.log(`   ✅ Smart caching for symbol data`);
        console.log(`   ✅ Async leverage setting`);
        console.log(`   ✅ Minimal delays between trades`);
        console.log(`   ✅ Fast token extraction`);
    }
    
    console.log(`\n💾 Loading storage...`);
    await storage.loadAll();
    
    const stats = storage.getStats();
    console.log(`   📊 Total: ${stats.total}`);
    console.log(`   🟡 Binance: ${stats.binance}`);
    console.log(`   🔵 Upbit: ${stats.upbit}`);
    
    // Start health server
    startHealthServer();
    
    // Start independent monitors in parallel
    console.log(`\n🚀 Starting parallel monitors...`);
    
    // if (config.exchanges.binance.enabled) {
    //     runBinanceMonitor().catch(error => console.error('❌ Binance monitor crashed:', error));
    //     console.log(`✅ Binance monitor started (${config.exchanges.binance.interval}ms interval)`);
    // }
    
    if (config.exchanges.upbit.enabled) {
        runUpbitMonitor().catch(error => console.error('❌ Upbit monitor crashed:', error));
        console.log(`✅ Upbit monitor started (${config.exchanges.upbit.interval}ms interval)`);
    }
    
    console.log(`\n⚡ Bot is now running with LIGHTNING FAST execution!`);
    console.log(`📱 Telegram notifications will be sent to chat: ${config.telegram.chatId}`);
    console.log(`📊 Performance stats available at: http://localhost:${config.server.port}`);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log(`\n👋 Shutting down bot...`);
        await storage.saveAll();
        const finalStats = storage.getStats();
        console.log(`💾 Saved all announcements to storage`);
        console.log(`   Total: ${finalStats.total}`);
        console.log(`   Binance: ${finalStats.binance}`);
        console.log(`   Upbit: ${finalStats.upbit}`);
        console.log(`🛑 Bot stopped`);
        process.exit(0);
    });
}

// ==================== START THE BOT ====================
main().catch(error => {
    console.error('💥 Fatal error during startup:', error);
    process.exit(1);
});
