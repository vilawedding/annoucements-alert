require('dotenv').config();
const config = require('./config/config');
const storage = require('./modules/storage');
const monitoring = require('./modules/monitoring');
const lightningTrader = require('./modules/automation/lightning-trader');
const telegram = require('./modules/notifications');
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
                },
                {
                    name: config.exchanges.bithumb.name,
                    enabled: config.exchanges.bithumb.enabled,
                    interval: `${config.exchanges.bithumb.interval}ms`
                }
            ],
            autoTrade: {
                enabled: config.autoTrade.enabled,
                binanceFuturesMode: config.binanceFutures.mode,
                amount: config.autoTrade.amount,
                leverage: config.autoTrade.leverage
            },
            stats: {
                totalSent: stats.total,
                binanceSent: stats.binance,
                upbitSent: stats.upbit,
                bithumbSent: stats.bithumb
            },
            crawlers: {
                binance: monitoring.binance.getHealth(),
                upbit: monitoring.upbit.getHealth(),
                bithumb: monitoring.bithumb.getHealth(),
                binancePriceStream: lightningTrader.binance.priceStream.getHealth()
            },
            positions: lightningTrader.positionManager ? lightningTrader.positionManager.getHealth() : { enabled: false },
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
    const milliseconds = String(d.getMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function startHeartbeatLogger() {
    const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    const logHeartbeat = () => {
        const stats = storage.getStats();
        const uptimeMinutes = Math.floor(process.uptime() / 60);
        console.log(`💓 [HEARTBEAT] ${formatTime(new Date())} | uptime=${uptimeMinutes}m | total=${stats.total} | binance=${stats.binance} | upbit=${stats.upbit} | bithumb=${stats.bithumb}`);
    };

    logHeartbeat(); // log immediately at startup
    setInterval(logHeartbeat, HEARTBEAT_INTERVAL_MS);
}

// ==================== MONITOR RUNNERS ====================
function logAnnouncement(a) {
    const tokenText = a.tokens && a.tokens.length > 0 ? a.tokens.join(',') : 'N/A';
    let extra = '';

    if (a.exchange === 'UPBIT') {
        if (a._source === 'WS') {
            const wsTs = a._wsTimestamp ? formatTime(a._wsTimestamp) : 'N/A';
            extra = ` | source=WS | wsTimestamp=${wsTs}`;
        } else {
            const apiStart = a._apiCallStartedAt ? formatTime(a._apiCallStartedAt) : 'N/A';
            const apiEnd = a._apiCallFinishedAt ? formatTime(a._apiCallFinishedAt) : 'N/A';
            const apiFetchMs = Number.isFinite(a._apiFetchMs) ? `${a._apiFetchMs}ms` : 'N/A';
            const apiToDetectMs = Number.isFinite(a._apiToDetectMs) ? `${a._apiToDetectMs}ms` : 'N/A';
            extra = ` | source=REST | apiStart=${apiStart} | apiEnd=${apiEnd} | fetch=${apiFetchMs} | api→detect=${apiToDetectMs}`;
        }
    }

    console.log(`📩 [${a.exchange}] ${formatTime(a.detectedAt)} | ${a.category} | ${tokenText} | ${a.title}${extra}`);
}

async function executeTrade(a) {
    const tradeStartTime = Date.now();
    const detectionTime = a.detectedAt ? new Date(a.detectedAt) : new Date(tradeStartTime);

    const tradeResults = await lightningTrader.executeLight(a);

    if (tradeResults && tradeResults.length > 0) {
        const tradeEndTime = Date.now();
        const tradeDuration = tradeEndTime - tradeStartTime;
        const totalDuration = tradeEndTime - detectionTime.getTime();
        const successCount = tradeResults.filter(r => r.success).length;
        const endTime = new Date();
        const orderText = tradeResults
            .filter(r => r.success)
            .map(r => `${r.symbol}:entry=${r.entryPrice},qty=${r.executedQty || r.quantity},sl=${r.stopLoss},tp=${r.takeProfit},slId=${r.stopLossOrderId || 'N/A'},tpId=${r.takeProfitOrderId || 'N/A'}`)
            .join(' || ');

        console.log(`✅ [TRADE] ${successCount}/${tradeResults.length} | ${tradeDuration}ms | ${totalDuration}ms | ${formatTime(detectionTime)} → ${formatTime(endTime)} | ${orderText || 'NO_SUCCESS_ORDER'}`);

        // Failures are already reported to the order chat by lightningTrader.
        tradeResults.filter(r => r.success).forEach(r => telegram.notify(telegram.createTradeMessage(r, a), 'order'));
    }
}

function handleAnnouncement(a) {
    logAnnouncement(a);
    // Old notices first seen now (startup, restart) are logged but not re-sent to Telegram.
    const ageMs = Date.now() - Number(a.releaseDate);
    if (Number(a.releaseDate) > 0 && ageMs <= config.telegram.maxSignalAgeMin * 60000) {
        telegram.notify(telegram.createAnnouncementMessage(a), 'signal');
    }

    // Fire-and-forget: awaiting the order here would pause polling for the whole trade.
    if (config.autoTrade.enabled && a._shouldTrade) {
        executeTrade(a).catch(error => {
            console.error(`❌ [TRADE] ${a.exchange} ${a.symbol || ''}: ${error.message}`);
        });
    }
}

async function runMonitorLoop(name, monitor, intervalMs) {
    while (true) {
        const loopStart = Date.now();
        try {
            const result = await monitor.check();
            for (const a of result?.announcements || []) {
                handleAnnouncement(a);
            }
        } catch (error) {
            console.error(`⚠️ [${name}] monitor loop error: ${error.message}`);
        }
        const elapsed = Date.now() - loopStart;
        const waitMs = Math.max(0, intervalMs - elapsed);
        await new Promise(resolve => setTimeout(resolve, waitMs));
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
        console.error(`❌ CONFIGURATION ERROR`);
        process.exit(1);
    }
    
    await storage.loadAll();
    // Preload order-path data before monitors start, so the first signal is not a cold trade.
    await lightningTrader.warmup().catch(error => console.error(`[WARMUP] ${error.message}`));
    startHealthServer();
    startHeartbeatLogger();
    
    if (config.exchanges.binance.enabled) {
        runMonitorLoop('BINANCE', monitoring.binance, config.exchanges.binance.interval);
    }
    
    if (config.exchanges.upbit.enabled) {
        monitoring.upbit.startWebSocket(handleAnnouncement);
        monitoring.upbit.startFastPolling(handleAnnouncement).catch(error => {
            console.error(`⚠️ [UPBIT] fast polling stopped: ${error.message}`);
        });
    }

    if (config.exchanges.bithumb.enabled) {
        runMonitorLoop('BITHUMB', monitoring.bithumb, config.exchanges.bithumb.interval);
    }
    
    console.log(`⚡ Bot running | Auto-trade: ${config.autoTrade.enabled ? 'ON' : 'OFF'} | Binance Futures: ${config.binanceFutures.mode} (${config.binanceFutures.testnetUrl && config.binanceFutures.useTestnet ? config.binanceFutures.testnetUrl : config.binanceFutures.productionUrl})`);
    
    // Handle graceful shutdown (SIGINT = Ctrl+C, SIGTERM = `docker stop` / orchestrators)
    const shutdown = async () => {
        monitoring.upbit.seenStore.flush();
        monitoring.bithumb.seenStore.flush();
        await storage.saveAll();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// ==================== START THE BOT ====================
main().catch(error => {
    console.error(`❌ FATAL ERROR: ${error.message}`);
    process.exit(1);
});
