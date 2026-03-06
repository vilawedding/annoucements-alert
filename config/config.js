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
        }
    },
    
    // Auto-Trading Configuration
    autoTrade: {
        enabled: process.env.AUTO_TRADE_ENABLED === 'true',
        upbitListing: process.env.AUTO_TRADE_UPBIT_LISTING !== 'false',
        amount: parseFloat(process.env.AUTO_TRADE_AMOUNT) || 10,
        leverage: parseInt(process.env.AUTO_TRADE_LEVERAGE) || 5,
        stopLossPercent: parseFloat(process.env.AUTO_TRADE_SL_PERCENT) || 1.0,
        takeProfitPercent: parseFloat(process.env.AUTO_TRADE_TP_PERCENT) || 200.0
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
        mainFile: 'data/sent_announcements.json',
        binanceFile: 'data/sent_announcements_binance.json',
        upbitFile: 'data/sent_announcements_upbit.json'
    },
    
    // Server Configuration
    server: {
        port: process.env.PORT || 3003
    },
    
    // General Settings
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 500
};
