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
    
    server.listen(config.server.port, () => {});
}

function formatTime(date) {
    if (!date) return 'N/A';
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ==================== MONITOR RUNNERS ====================
async function runBinanceMonitor() {
    while (true) {
        try {
            const result = await monitoring.binance.check();
            if (result?.latestAnnouncement) {
                const a = result.latestAnnouncement;
                const tokenText = a.tokens && a.tokens.length > 0 ? a.tokens.join(',') : 'N/A';
                console.log(`📩 [BINANCE] ${formatTime(a.detectedAt)} | ${a.category} | ${tokenText} | ${a.title}`);
            }
        } catch (error) {
            // Silent fail
        }
        await new Promise(resolve => setTimeout(resolve, config.exchanges.binance.interval));
    }
}

async function runUpbitMonitor() {
    while (true) {
        try {
            const result = await monitoring.upbit.check();
            if (result?.latestAnnouncement) {
                const a = result.latestAnnouncement;
                const tokenText = a.tokens && a.tokens.length > 0 ? a.tokens.join(',') : 'N/A';
                console.log(`📩 [UPBIT] ${formatTime(a.detectedAt)} | ${a.category} | ${tokenText} | ${a.title}`);
            }
            
            // Trigger lightning-fast auto-trade if listing detected
            if (config.autoTrade.enabled && result.announcement && result.announcement._shouldTrade) {
                const tradeStartTime = Date.now();
                const detectionTime = result.announcement._detectionTime;
                
                const tradeResults = await lightningTrader.executeLight(result.announcement);
                
                if (tradeResults && tradeResults.length > 0) {
                    const tradeEndTime = Date.now();
                    const tradeDuration = tradeEndTime - tradeStartTime;
                    const totalDuration = detectionTime ? tradeEndTime - detectionTime.getTime() : tradeDuration;
                    const successCount = tradeResults.filter(r => r.success).length;
                    const endTime = new Date();
                    const orderText = tradeResults
                        .filter(r => r.success)
                        .map(r => `${r.symbol}:entry=${r.entryPrice},qty=${r.executedQty || r.quantity},sl=${r.stopLoss},tp=${r.takeProfit},slId=${r.stopLossOrderId || 'N/A'},tpId=${r.takeProfitOrderId || 'N/A'}`)
                        .join(' || ');

                    console.log(`✅ [TRADE] ${successCount}/${tradeResults.length} | ${tradeDuration}ms | ${totalDuration}ms | ${formatTime(detectionTime)} → ${formatTime(endTime)} | ${orderText || 'NO_SUCCESS_ORDER'}`);
                }
            }
        } catch (error) {
            // Silent fail
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
    
    await storage.loadAll();
    startHealthServer();
    
    if (config.exchanges.binance.enabled) {
        runBinanceMonitor().catch(() => {});
    }
    
    if (config.exchanges.upbit.enabled) {
        runUpbitMonitor().catch(() => {});
    }
    
    console.log(`⚡ Bot running | Auto-trade: ${config.autoTrade.enabled ? 'ON' : 'OFF'}`);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        await storage.saveAll();
        process.exit(0);
    });
}

// ==================== START THE BOT ====================
main().catch(error => {
    process.exit(1);
});
