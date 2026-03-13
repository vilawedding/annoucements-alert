require('dotenv').config();

/**
 * Centralized configuration for the entire application
 */

module.exports = {
    // Telegram Configuration
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID || '-1003591132823'
    },
    
    // Exchange Monitoring Configuration
    exchanges: {
        binance: {
            enabled: process.env.BINANCE_ENABLED || false,
            name: "Binance",
            emoji: "🟡",
            baseUrl: "https://www.binance.com",
            interval: parseInt(process.env.BINANCE_INTERVAL) || 500,
            catalogIds: [48, 161], // Listing & Delisting
            catalogNames: {
                48: "📈 NEW LISTING",
                161: "🗑️ DELISTING",
            }
        },
        upbit: {
            enabled: process.env.UPBIT_ENABLED || false,
            name: "Upbit",
            emoji: "🔵",
            baseUrl: "https://upbit.com",
            interval: parseInt(process.env.UPBIT_INTERVAL) || 500,
            apiUrl: "https://api-manager.upbit.com/api/v1/announcements"
        },
        bithumb: {
            enabled: process.env.BITHUMB_ENABLED || false,
            name: "Bithumb",
            emoji: "🟠",
            baseUrl: "https://www.bithumb.com",
            interval: parseInt(process.env.BITHUMB_INTERVAL) || 200,
            apiUrl: process.env.BITHUMB_API_URL || "https://feed.bithumb.com/_next/data/NLILjNtdG9PdJyIGBALYd/notice.json?category=9&page=1",
            cfClearance: process.env.BITHUMB_CF_CLEARANCE || '',
            cookie: process.env.BITHUMB_COOKIE || ''
        }
    },
    
    // Auto-Trading Configuration
    autoTrade: {
        enabled: process.env.AUTO_TRADE_ENABLED === 'true',
        upbitListing: process.env.AUTO_TRADE_UPBIT_LISTING !== 'false',
        bithumbListing: process.env.AUTO_TRADE_BITHUMB_LISTING !== 'false',
        binanceListing: process.env.AUTO_TRADE_BINANCE_LISTING !== 'false',
        binanceDelisting: process.env.AUTO_TRADE_BINANCE_DELISTING === 'true',
        amount: parseFloat(process.env.AUTO_TRADE_AMOUNT) || 10,
        leverage: parseInt(process.env.AUTO_TRADE_LEVERAGE) || 5,
        stopLossPercent: parseFloat(process.env.AUTO_TRADE_SL_PERCENT) || 1.0,
        takeProfitPercent: parseFloat(process.env.AUTO_TRADE_TP_PERCENT) || 200.0,
        takeProfitPercentUpbit:
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT_UPBIT) ||
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT) ||
            200.0,
        takeProfitPercentBithumb:
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT_BITHUMB) ||
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT_UPBIT) ||
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT) ||
            200.0,
        takeProfitPercentBinance:
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT_BINANCE) ||
            parseFloat(process.env.AUTO_TRADE_TP_PERCENT) ||
            200.0
    },
    
    // Binance Futures API Configuration
    binanceFutures: {
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_API_SECRET,
        useTestnet: process.env.BINANCE_USE_TESTNET === 'true',
        testnetUrl: 'https://testnet.binancefuture.com',
        productionUrl: 'https://fapi.binance.com'
    },
    
    // Storage Configuration
    storage: {
        binanceFile: 'data/sent_announcements_binance.json',
        upbitFile: 'data/sent_announcements_upbit.json',
        bithumbFile: 'data/sent_announcements_bithumb.json'
    },
    
    // Server Configuration
    server: {
        port: process.env.PORT || 3003
    },
    
    // General Settings
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 500
};
