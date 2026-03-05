require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const binance = require('./scripts/legacy/binance-trading');

//npx kill-port 3003 && node --require ./preload.js index.js

// ==================== CONFIGURATION ====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003591132823';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 500; // 0.5 seconds for fast updates
const PORT = process.env.PORT || 3003;
const BINANCE_INTERVAL = parseInt(process.env.BINANCE_INTERVAL) || 500; // 0.5s
const UPBIT_INTERVAL = parseInt(process.env.UPBIT_INTERVAL) || 500; // 0.5s

// Auto-trading configuration
const AUTO_TRADE_ENABLED = process.env.AUTO_TRADE_ENABLED === 'true';
const AUTO_TRADE_AMOUNT = parseFloat(process.env.AUTO_TRADE_AMOUNT) || 10; // USDT
const AUTO_TRADE_LEVERAGE = parseInt(process.env.AUTO_TRADE_LEVERAGE) || 5; // 5x
const AUTO_TRADE_UPBIT_LISTING = process.env.AUTO_TRADE_UPBIT_LISTING !== 'false'; // enabled by default

// Exchange monitoring configuration
const EXCHANGES = {
    BINANCE: {
        enabled: process.env.BINANCE_ENABLED !== 'false', // enabled by default
        name: "Binance",
        emoji: "🟡",
        baseUrl: "https://www.binance.com"
    },
    UPBIT: {
        enabled: process.env.UPBIT_ENABLED === 'true', // disabled by default
        name: "Upbit",
        emoji: "🔵",
        baseUrl: "https://upbit.com"
    }
};

// Binance catalog configuration
const BINANCE_CATALOG_IDS = [48, 161]; // Listing & Delisting
const BINANCE_CATALOG_NAMES = {
    48: "📈 NEW LISTING",
    161: "🗑️ DELISTING",
};

// Storage
const STORAGE_FILE = path.join(__dirname, 'data/sent_announcements.json');
const BINANCE_STORAGE_FILE = path.join(__dirname, 'data/sent_announcements_binance.json');
const UPBIT_STORAGE_FILE = path.join(__dirname, 'data/sent_announcements_upbit.json');

// ==================== INITIALIZATION ====================
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
let sentAnnouncements = new Set();
let binanceSentAnnouncements = new Set();
let upbitSentAnnouncements = new Set();

// ==================== STORAGE FUNCTIONS ====================
async function loadSentAnnouncements() {
    try {
        const data = await fs.readFile(STORAGE_FILE, 'utf8');
        const parsed = JSON.parse(data);
        sentAnnouncements = new Set(parsed);
        console.log(`✅ Loaded ${sentAnnouncements.size} sent announcements from storage`);
    } catch (error) {
        console.log('ℹ️ No previous storage found, starting fresh');
        sentAnnouncements = new Set();
    }
}

async function loadBinanceSentAnnouncements() {
    try {
        const data = await fs.readFile(BINANCE_STORAGE_FILE, 'utf8');
        const parsed = JSON.parse(data);
        binanceSentAnnouncements = new Set(parsed);
        console.log(`✅ Loaded ${binanceSentAnnouncements.size} sent Binance announcements`);
    } catch (error) {
        console.log('ℹ️ No Binance storage found, starting fresh');
        binanceSentAnnouncements = new Set();
    }
}

async function loadUpbitSentAnnouncements() {
    try {
        const data = await fs.readFile(UPBIT_STORAGE_FILE, 'utf8');
        const parsed = JSON.parse(data);
        upbitSentAnnouncements = new Set(parsed);
        console.log(`✅ Loaded ${upbitSentAnnouncements.size} sent Upbit announcements`);
    } catch (error) {
        console.log('ℹ️ No Upbit storage found, starting fresh');
        upbitSentAnnouncements = new Set();
    }
}

async function saveSentAnnouncements() {
    try {
        const data = JSON.stringify(Array.from(sentAnnouncements));
        await fs.writeFile(STORAGE_FILE, data, 'utf8');
    } catch (error) {
        console.error('❌ Error saving announcements:', error.message);
    }
}

async function saveBinanceSentAnnouncements() {
    try {
        const data = JSON.stringify(Array.from(binanceSentAnnouncements));
        await fs.writeFile(BINANCE_STORAGE_FILE, data, 'utf8');
    } catch (error) {
        console.error('❌ Error saving Binance announcements:', error.message);
    }
}

async function saveUpbitSentAnnouncements() {
    try {
        const data = JSON.stringify(Array.from(upbitSentAnnouncements));
        await fs.writeFile(UPBIT_STORAGE_FILE, data, 'utf8');
    } catch (error) {
        console.error('❌ Error saving Upbit announcements:', error.message);
    }
}

// ==================== BINANCE FUNCTIONS ====================
async function getBinanceAnnouncements(catalogId) {
    try {
        const startTime = Date.now();
        const url = `https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query?type=1&pageNo=1&pageSize=10&catalogId=${catalogId}`;
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        
        const duration = Date.now() - startTime;
        if (duration > 2000) {
            console.log(`   ⏱️ Binance API (Catalog ${catalogId}): ${duration}ms`);
        }
        
        if (response.data.success && response.data.data?.catalogs?.length > 0) {
            const catalog = response.data.data.catalogs[0];
            return {
                name: catalog.catalogName,
                articles: catalog.articles.map(article => ({
                    ...article,
                    catalogId: catalogId,
                    exchange: 'BINANCE',
                    url: `https://www.binance.com/en/support/announcement/${article.code}`
                }))
            };
        }
        
        return { name: BINANCE_CATALOG_NAMES[catalogId] || `Catalog ${catalogId}`, articles: [] };
        
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ Error fetching Binance catalog ${catalogId} (${duration}ms):`, error.message);
        return { name: BINANCE_CATALOG_NAMES[catalogId] || `Catalog ${catalogId}`, articles: [] };
    }
}

// ==================== UPBIT FUNCTIONS ====================
async function getUpbitAnnouncements() {
    try {
        const startTime = Date.now();
        const url = 'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=trade';
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        
        const duration = Date.now() - startTime;
        if (duration > 2000) {
            console.log(`   ⏱️ Upbit API: ${duration}ms`);
        }
        
        if (response.data.success) {
            const notices = response.data.data.notices;
            console.log(`✅ Fetched ${notices.length} Upbit announcements`);
            
            return notices.map(notice => ({
                ...notice,
                exchange: 'UPBIT',
                title: notice.title,
                // Upbit doesn't provide individual article URLs, use general page
                url: 'https://upbit.com/notice',
                // Convert Korean time to Date object
                releaseDate: new Date(notice.listed_at).getTime()
            }));
        }
        
        return [];
        
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`❌ Error fetching Upbit (${duration}ms):`, error.message);
        return [];
    }
}

/**
 * Extract token from Upbit Korean title
 * Example: "그로스톨코인(GRS) 거래 유의 종목 지정 안내" -> "GRS"
 */
function extractTokenFromUpbitTitle(title) {
    // Pattern 1: Korean name followed by token in parentheses
    const match = title.match(/\(([A-Z]{2,10})\)/);
    if (match) {
        return match[1];
    }
    
    // Pattern 2: Look for uppercase token in title
    const uppercaseMatch = title.match(/\b([A-Z]{2,10})\b/);
    if (uppercaseMatch) {
        return uppercaseMatch[1];
    }
    
    return null;
}

/**
 * Categorize Upbit announcement based on Korean keywords
 */
function categorizeUpbitAnnouncement(title) {
    if (title.includes('신규 거래지원 안내')) {
        return 'LISTING';
    }
    if (title.includes('거래지원 종료 안내')) {
        return 'DELISTING';
    }
    if (title.includes('거래 유의 종목 지정')) {
        return 'WARNING';
    }
    if (title.includes('유의 촉구 안내')) {
        return 'WARNING';
    }
    
    return 'OTHER';
}

/**
 * Translate Korean category to English
 */
function translateUpbitCategory(koreanTitle) {
    const mapping = {
        '신규 거래지원 안내': 'New Trading Support',
        '거래지원 종료 안내': 'Trading Support Termination',
        '거래 유의 종목 지정 안내': 'Trading Caution Designation',
        '거래 유의 종목 지정 기간 연장 안내': 'Trading Caution Period Extension',
        '유의 촉구 안내': 'Caution Urged'
    };
    
    for (const [korean, english] of Object.entries(mapping)) {
        if (koreanTitle.includes(korean)) {
            return english;
        }
    }
    
    return 'Trade Announcement';
}

// ==================== TOKEN EXTRACTION (COMMON) ====================
function extractTokensFromTitle(title, exchange) {
    const tokens = new Set();
    
    if (exchange === 'UPBIT') {
        const token = extractTokenFromUpbitTitle(title);
        if (token) {
            tokens.add(token);
        }
        return Array.from(tokens);
    }
    
    // Binance token extraction (existing logic)
    const parenthesizedPattern = /\(([A-Z]{1,10})\)/g;
    let match;
    
    while ((match = parenthesizedPattern.exec(title)) !== null) {
        if (match[1].length >= 2) {
            tokens.add(match[1]);
        }
    }
    
    const pairPattern = /([A-Z]{2,10})(USDT|BUSD|BTC|ETH|BNB|TUSD|FDUSD)(?![a-z])/gi;
    while ((match = pairPattern.exec(title)) !== null) {
        tokens.add(match[1]);
    }
    
    return Array.from(tokens);
}

// ==================== ANNOUNCEMENT PROCESSING ====================
function categorizeAnnouncement(title, exchange, catalogId = null) {
    if (exchange === 'UPBIT') {
        return categorizeUpbitAnnouncement(title);
    }
    
    // Binance categorization
    const lowerTitle = title.toLowerCase();
    
    if (catalogId === 48) {
        if (lowerTitle.includes('list') || lowerTitle.includes('listing')) {
            return 'LISTING';
        }
        if (lowerTitle.includes('add') && lowerTitle.includes('pairs')) {
            return 'NEW_PAIRS';
        }
        return 'LISTING_RELATED';
    }
    
    if (catalogId === 161) {
        if (lowerTitle.includes('delist') || lowerTitle.includes('removal')) {
            return 'DELISTING';
        }
        return 'DELISTING_RELATED';
    }
    
    return 'OTHER';
}

async function processAnnouncement(article) {
    const { id, code, title, releaseDate, url, exchange, catalogId, listed_at } = article;
    
    // Create unique hash
    let hash;
    if (exchange === 'BINANCE') {
        hash = crypto.createHash('md5').update(`BINANCE-${catalogId}-${id}-${code}`).digest('hex');
    } else {
        hash = crypto.createHash('md5').update(`UPBIT-${id}-${listed_at}`).digest('hex');
    }
    
    // Check if already sent (use exchange-specific storage)
    const announceSet = exchange === 'BINANCE' ? binanceSentAnnouncements : upbitSentAnnouncements;
    if (announceSet.has(hash)) {
        return null;
    }
    
    // Categorize
    const category = categorizeAnnouncement(title, exchange, catalogId);
    
    // Skip non-listing/delisting for Upbit
    if (exchange === 'UPBIT' && !['LISTING', 'DELISTING', 'WARNING'].includes(category)) {
        return null;
    }
    
    // Extract tokens
    const tokens = extractTokensFromTitle(title, exchange);
    
    // Special handling for Binance delisting with multiple tokens
    if (exchange === 'BINANCE' && category === 'DELISTING' && 
        (tokens.length === 0 || title.toLowerCase().includes('multiple'))) {
        console.log(`🔍 Parsing detailed page for delisting: ${title}`);
        const detailedTokens = await parseDelistDetails(code);
        if (detailedTokens.length > 0) {
            tokens.push(...detailedTokens);
        }
    }
    
    // Format date
    let formattedDate;
    if (exchange === 'UPBIT' && listed_at) {
        const date = new Date(listed_at);
        formattedDate = date.toLocaleString('en-US', {
            timeZone: 'Asia/Seoul',
            hour12: false
        }) + ' (KST)';
    } else {
        formattedDate = new Date(releaseDate).toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            hour12: false
        });
    }
    
    return {
        hash,
        exchange,
        catalogId,
        category,
        title,
        url,
        releaseDate,
        tokens: Array.from(new Set(tokens)), // Remove duplicates
        formattedDate
    };
}

// ==================== TELEGRAM MESSAGING ====================
function createTelegramMessage(announcement) {
    const { exchange, category, title, url, tokens, formattedDate } = announcement;
    
    const exchangeConfig = EXCHANGES[exchange];
    const emoji = exchangeConfig.emoji;
    const exchangeName = exchangeConfig.name;
    
    let header = '', actionEmoji = '';
    
    switch(category) {
        case 'LISTING':
            header = '🚀 NEW LISTING';
            actionEmoji = '🎉';
            break;
        case 'DELISTING':
            header = '🗑️ DELISTING';
            actionEmoji = '⚠️';
            break;
        case 'WARNING':
            header = '🔴 TRADING WARNING';
            actionEmoji = '🚨';
            break;
        default:
            header = '📢 ANNOUNCEMENT';
            actionEmoji = '📢';
    }
    
    let message = `${emoji} <b>[${exchangeName}] ${header}</b>\n`;
    message += '════════════════════════\n\n';
    
    // Add translated title for Upbit if needed
    if (exchange === 'UPBIT') {
        const englishCategory = translateUpbitCategory(title);
        message += `<b>${englishCategory}</b>\n`;
    }
    
    message += `<b>${title}</b>\n\n`;
    
    // Add tokens if available
    if (tokens.length > 0) {
        message += `<b>🔸 Token${tokens.length > 1 ? 's' : ''}:</b>\n`;
        tokens.forEach((token, index) => {
            message += `${index + 1}. <code>${token}</code>\n`;
        });
        message += '\n';
    }
    
    // Add metadata
    message += `<b>📅 Time:</b> ${formattedDate}\n`;
    
    if (exchange === 'BINANCE') {
        message += `<b>🔗 Details:</b> <a href="${url}">View Official Announcement</a>\n`;
    } else {
        message += `<b>🔗 Source:</b> <a href="${url}">Upbit Notices</a>\n`;
    }
    
    message += `\n<b>🏦 Exchange:</b> ${exchangeName}\n\n`;
    
    // Add footer with hashtags
    message += '════════════════════════\n';
    
    const hashtags = [`#${exchangeName}`];
    if (category === 'LISTING') hashtags.push('#Listing', '#NewCoin');
    if (category === 'DELISTING') hashtags.push('#Delisting', '#Warning');
    if (category === 'WARNING') hashtags.push('#TradingWarning', '#Caution');
    hashtags.push('#Crypto');
    
    message += hashtags.join(' ');
    
    return message;
}

async function sendTelegramMessage(message) {
    // try {
    //     await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
    //         parse_mode: 'HTML',
    //     });
        return true;
    // } catch (error) {
    //     console.log(error)
    //     console.error('❌ Telegram send error:', error.message);
    //     return false;
    // }
}

// ==================== AUTO-TRADING ====================

/**
 * Execute auto-trade when Upbit listing is detected
 * @param {object} announcement - The announcement object
 */
async function executeAutoTrade(announcement) {
    if (!AUTO_TRADE_ENABLED) {
        return null;
    }
    
    // Only trade on Upbit listings
    if (announcement.exchange !== 'UPBIT' || announcement.category !== 'LISTING') {
        return null;
    }
    
    if (!AUTO_TRADE_UPBIT_LISTING) {
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
            
            // Check if symbol exists on Binance
            try {
                const price = await binance.getPrice(symbol);
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
            const precision = await binance.getSymbolPrecision(symbol);
            
            // Set leverage
            try {
                await binance.changeInitialLeverage(symbol, AUTO_TRADE_LEVERAGE);
                console.log(`   ⚙️ Leverage set to ${AUTO_TRADE_LEVERAGE}x`);
            } catch (error) {
                console.log(`   ⚠️ Could not set leverage: ${error.message}`);
            }
            
            // Calculate quantity based on trade amount and current price
            const priceData = await binance.getPrice(symbol);
            const currentPrice = parseFloat(priceData.price);
            const quantity = AUTO_TRADE_AMOUNT / currentPrice;
            const formattedQty = binance.formatQuantity(quantity, precision.quantityPrecision);
            
            console.log(`   📊 Order: BUY ${formattedQty} ${symbol} (≈${AUTO_TRADE_AMOUNT} USDT)`);
            
            // Place market buy order
            const order = await binance.marketBuy(symbol, formattedQty);
            const tradeDuration = Date.now() - tradeStart;
            
            console.log(`   ✅ Order executed in ${tradeDuration}ms`);
            console.log(`   📝 Order ID: ${order.orderId}`);
            console.log(`   💵 Avg Price: ${order.avgPrice}`);
            console.log(`   📦 Filled: ${order.executedQty}`);
            
            tradeResults.push({
                token,
                symbol,
                success: true,
                orderId: order.orderId,
                avgPrice: order.avgPrice,
                executedQty: order.executedQty,
                duration: tradeDuration
            });
            
            // Send Telegram notification
            const tradeMessage = `🤖 <b>AUTO-TRADE EXECUTED</b>\n` +
                `════════════════════════\n\n` +
                `<b>🔵 Upbit Listing Detected</b>\n` +
                `Token: <code>${token}</code>\n\n` +
                `<b>🟡 Binance Futures Order</b>\n` +
                `Symbol: ${symbol}\n` +
                `Side: LONG\n` +
                `Quantity: ${order.executedQty}\n` +
                `Price: ${order.avgPrice}\n` +
                `Leverage: ${AUTO_TRADE_LEVERAGE}x\n` +
                `Amount: ~${AUTO_TRADE_AMOUNT} USDT\n\n` +
                `Order ID: <code>${order.orderId}</code>\n` +
                `Time: ${tradeDuration}ms\n\n` +
                `#AutoTrade #UpbitListing`;
            
            await sendTelegramMessage(tradeMessage);
            
            // Wait before next trade to avoid rate limits
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
            const errorMessage = `⚠️ <b>AUTO-TRADE FAILED</b>\n` +
                `════════════════════════\n\n` +
                `Token: <code>${token}</code>\n` +
                `Symbol: ${symbol}\n` +
                `Error: ${error.message}\n\n` +
                `#AutoTrade #Error`;
            
            await sendTelegramMessage(errorMessage);
        }
    }
    
    return tradeResults;
}

// ==================== BINANCE DETAILED PARSING ====================
async function parseDelistDetails(articleCode) {
    try {
        const url = `https://www.binance.com/en/support/announcement/${articleCode}`;
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        
        const $ = cheerio.load(response.data);
        const tokens = new Set();
        
        // Try multiple selectors for article content
        const contentSelectors = ['.article-body', '.htmlcontent', 'article'];
        
        let content = '';
        for (const selector of contentSelectors) {
            content = $(selector).html() || '';
            if (content) break;
        }
        
        if (!content) return [];
        
        const textContent = $(content).text();
        
        // Pattern 1: Trading pairs like BTC/USDT
        const slashPairs = textContent.match(/([A-Z]{2,10})\s*\/\s*(USDT|BUSD|BTC|ETH|BNB)/gi) || [];
        slashPairs.forEach(pair => {
            const token = pair.split('/')[0].trim();
            if (token.length >= 2) tokens.add(token);
        });
        
        // Pattern 2: USDT pairs without slash
        const usdtPairs = textContent.match(/([A-Z]{2,10})USDT/gi) || [];
        usdtPairs.forEach(pair => {
            const token = pair.replace('USDT', '');
            if (token.length >= 2) tokens.add(token.toUpperCase());
        });
        
        return Array.from(tokens);
        
    } catch (error) {
        console.error('❌ Error parsing detailed page:', error.message);
        return [];
    }
}

// ==================== MONITORING LOGIC ====================
async function checkBinanceAnnouncements() {
    if (!EXCHANGES.BINANCE.enabled) {
        return { processed: 0, sent: 0 };
    }
    
    let processed = 0, sent = 0;
    const fetchStart = Date.now();
    
    try {
        for (const catalogId of BINANCE_CATALOG_IDS) {
            try {
                const catalogData = await getBinanceAnnouncements(catalogId);
                
                for (const article of catalogData.articles) {
                    const itemStart = Date.now();
                    processed++;
                    const announcement = await processAnnouncement(article);
                    
                    if (announcement) {
                        const message = createTelegramMessage(announcement);
                        console.log(`🟡 [BIN] ${announcement.title.substring(0, 60)}...`)
                        const success = await sendTelegramMessage(message);
                        
                        if (success) {
                            sent++;
                            binanceSentAnnouncements.add(announcement.hash);
                            sentAnnouncements.add(announcement.hash);
                            await saveBinanceSentAnnouncements();
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    }
                    const itemDuration = Date.now() - itemStart;
                    if (itemDuration > 1000) {
                        console.log(`   ⏱️ Item processed in ${itemDuration}ms`);
                    }
                }
            } catch (error) {
                console.error(`❌ Binance catalog ${catalogId}:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Binance error:', error.message);
    }
    
    const totalDuration = Date.now() - fetchStart;
    if (processed > 0 || totalDuration > 500) {
        console.log(`   ⏱️ Total Binance: ${totalDuration}ms`);
    }
    
    return { processed, sent };
}

async function checkUpbitAnnouncements() {
    if (!EXCHANGES.UPBIT.enabled) {
        return { processed: 0, sent: 0 };
    }
    
    let processed = 0, sent = 0;
    const fetchStart = Date.now();
    
    try {
        const articles = await getUpbitAnnouncements();
        const fetchDuration = Date.now() - fetchStart;
        
        for (const article of articles) {
            const itemStart = Date.now();
            processed++;
            const announcement = await processAnnouncement(article);
            
            if (announcement) {
                const message = createTelegramMessage(announcement);
                console.log(`🔵 [UPB] ${announcement.title.substring(0, 60)}...`)
                const success = await sendTelegramMessage(message);
                
                if (success) {
                    sent++;
                    upbitSentAnnouncements.add(announcement.hash);
                    sentAnnouncements.add(announcement.hash);
                    await saveUpbitSentAnnouncements();
                    
                    // Execute auto-trade if it's a listing announcement
                    if (announcement.category === 'LISTING' && AUTO_TRADE_ENABLED) {
                        console.log(`🤖 [AUTO-TRADE] Triggering trade for Upbit listing...`);
                        const tradeResults = await executeAutoTrade(announcement);
                        if (tradeResults && tradeResults.length > 0) {
                            console.log(`✅ [AUTO-TRADE] Completed ${tradeResults.filter(r => r.success).length}/${tradeResults.length} trades`);
                        }
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            const itemDuration = Date.now() - itemStart;
            if (itemDuration > 1000) {
                console.log(`   ⏱️ Item processed in ${itemDuration}ms`);
            }
        }
        
        const totalDuration = Date.now() - fetchStart;
        if (processed > 0 || totalDuration > 500) {
            console.log(`   ⏱️ Total Upbit: ${totalDuration}ms (Fetch: ${fetchDuration}ms)`);
        }
    } catch (error) {
        const totalDuration = Date.now() - fetchStart;
        console.error(`❌ Upbit error (${totalDuration}ms):`, error.message);
    }
    
    return { processed, sent };
}

// Run Binance checks in parallel with independent interval
async function runBinanceMonitor() {
    let cycleCount = 0;
    while (true) {
        cycleCount++;
        const startTime = Date.now();
        try {
            const result = await checkBinanceAnnouncements();
            const duration = Date.now() - startTime;
            console.log(`🟡 [BIN] Cycle #${cycleCount} - ${duration}ms (${result.processed}/${result.sent})`);
        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`❌ [BIN] Cycle #${cycleCount} - ${duration}ms - Error: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, BINANCE_INTERVAL));
    }
}

// Run Upbit checks in parallel with independent interval
async function runUpbitMonitor() {
    let cycleCount = 0;
    while (true) {
        cycleCount++;
        const startTime = Date.now();
        try {
            const result = await checkUpbitAnnouncements();
            const duration = Date.now() - startTime;
            console.log(`🔵 [UPB] Cycle #${cycleCount} - ${duration}ms (${result.processed}/${result.sent})`);
        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`❌ [UPB] Cycle #${cycleCount} - ${duration}ms - Error: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, UPBIT_INTERVAL));
    }
}

function startHealthServer() {
    const http = require('http');
    
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            service: 'Multi-Exchange Crypto Monitor',
            uptime: process.uptime(),
            lastCheck: new Date().toISOString(),
            exchanges: Object.keys(EXCHANGES).map(key => ({
                name: EXCHANGES[key].name,
                enabled: EXCHANGES[key].enabled,
                interval: key === 'BINANCE' ? `${BINANCE_INTERVAL}ms` : `${UPBIT_INTERVAL}ms`
            })),
            stats: {
                totalSent: sentAnnouncements.size,
                binanceSent: binanceSentAnnouncements.size,
                upbitSent: upbitSentAnnouncements.size,
                binanceInterval: `${BINANCE_INTERVAL}ms`,
                upbitInterval: `${UPBIT_INTERVAL}ms`
            }
        }));
    });
    
    server.listen(PORT, () => {
        console.log(`🚀 Health server running on port ${PORT}`);
    });
}

// ==================== MAIN FUNCTION ====================
async function main() {
    console.log(`
    🤖 MULTI-EXCHANGE CRYPTO MONITOR BOT
    =====================================
    `);
    
    // Validate configuration
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error(`
    ❌ CONFIGURATION ERROR
    ======================
    Please configure the following in .env file:
    
    TELEGRAM_BOT_TOKEN=your_bot_token_here
    TELEGRAM_CHAT_ID=your_chat_id_here
    
    Optional configuration:
    BINANCE_ENABLED=true           # Enable Binance monitoring (default)
    UPBIT_ENABLED=false            # Enable Upbit monitoring (default false)
    BINANCE_INTERVAL=500           # Binance check interval in ms (default 500)
    UPBIT_INTERVAL=500             # Upbit check interval in ms (default 500)
    PORT=3003                      # Health server port
    
    Auto-trading configuration:
    AUTO_TRADE_ENABLED=true        # Enable auto-trading (default false)
    AUTO_TRADE_UPBIT_LISTING=true  # Trade on Upbit listings (default true)
    AUTO_TRADE_AMOUNT=10           # Trade amount in USDT (default 10)
    AUTO_TRADE_LEVERAGE=5          # Leverage for futures (default 5x)
    BINANCE_API_KEY=...            # Required for auto-trading
    BINANCE_API_SECRET=...         # Required for auto-trading
    BINANCE_USE_TESTNET=true       # Use testnet for safety (default false)
        `);
        process.exit(1);
    }
    
    console.log(`✅ Configuration loaded`);
    console.log(`🤖 Telegram Bot: Connected`);
    console.log(`📊 Enabled exchanges:`);
    console.log(`   ${EXCHANGES.BINANCE.enabled ? '✅' : '❌'} ${EXCHANGES.BINANCE.name} (${BINANCE_INTERVAL}ms interval)`);
    console.log(`   ${EXCHANGES.UPBIT.enabled ? '✅' : '❌'} ${EXCHANGES.UPBIT.name} (${UPBIT_INTERVAL}ms interval)`);
    console.log(`\n🤖 Auto-trading:`);
    console.log(`   ${AUTO_TRADE_ENABLED ? '✅' : '❌'} Auto-trade ${AUTO_TRADE_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    if (AUTO_TRADE_ENABLED) {
        console.log(`   💰 Trade Amount: ${AUTO_TRADE_AMOUNT} USDT`);
        console.log(`   📊 Leverage: ${AUTO_TRADE_LEVERAGE}x`);
        console.log(`   🔵 Upbit Listing: ${AUTO_TRADE_UPBIT_LISTING ? 'ENABLED' : 'DISABLED'}`);
        console.log(`   🌐 Binance: ${binance.USE_TESTNET ? 'TESTNET' : 'PRODUCTION'}`);
    }
    console.log(`\n💾 Storage files:`);
    console.log(`   📄 Binance: ${BINANCE_STORAGE_FILE}`);
    console.log(`   📄 Upbit: ${UPBIT_STORAGE_FILE}`);
    
    // Load previously sent announcements
    await loadSentAnnouncements();
    await loadBinanceSentAnnouncements();
    await loadUpbitSentAnnouncements();
    
    // Start health server
    startHealthServer();
    
    // Start independent monitors in parallel (non-blocking)
    console.log(`\n🚀 Starting parallel monitors...`);
    if (EXCHANGES.BINANCE.enabled) {
        runBinanceMonitor().catch(error => console.error('❌ Binance monitor crashed:', error));
        console.log(`✅ Binance monitor started (${BINANCE_INTERVAL}ms interval)`);
    }
    
    if (EXCHANGES.UPBIT.enabled) {
        runUpbitMonitor().catch(error => console.error('❌ Upbit monitor crashed:', error));
        console.log(`✅ Upbit monitor started (${UPBIT_INTERVAL}ms interval)`);
    }
    
    console.log(`\n✅ Bot is now running with parallel monitoring!`);
    console.log(`📱 Telegram notifications will be sent to chat: ${TELEGRAM_CHAT_ID}`);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log(`\n👋 Shutting down bot...`);
        await saveSentAnnouncements();
        await saveBinanceSentAnnouncements();
        await saveUpbitSentAnnouncements();
        console.log(`💾 Saved all announcements to storage`);
        console.log(`   Total: ${sentAnnouncements.size}`);
        console.log(`   Binance: ${binanceSentAnnouncements.size}`);
        console.log(`   Upbit: ${upbitSentAnnouncements.size}`);
        console.log(`🛑 Bot stopped`);
        process.exit(0);
    });
}

// ==================== START THE BOT ====================
main().catch(error => {
    console.error('💥 Fatal error during startup:', error);
    process.exit(1);
});