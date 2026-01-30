require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

// ==================== CONFIGURATION ====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003591132823';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 15000; // 15 seconds
const PORT = process.env.PORT || 3003;

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
const STORAGE_FILE = path.join(__dirname, 'sent_announcements.json');

// ==================== INITIALIZATION ====================
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
let sentAnnouncements = new Set();

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

async function saveSentAnnouncements() {
    try {
        const data = JSON.stringify(Array.from(sentAnnouncements));
        await fs.writeFile(STORAGE_FILE, data, 'utf8');
    } catch (error) {
        console.error('❌ Error saving announcements:', error.message);
    }
}

// ==================== BINANCE FUNCTIONS ====================
async function getBinanceAnnouncements(catalogId) {
    try {
        const url = `https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query?type=1&pageNo=1&pageSize=10&catalogId=${catalogId}`;
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        
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
        console.error(`❌ Error fetching Binance catalog ${catalogId}:`, error.message);
        return { name: BINANCE_CATALOG_NAMES[catalogId] || `Catalog ${catalogId}`, articles: [] };
    }
}

// ==================== UPBIT FUNCTIONS ====================
async function getUpbitAnnouncements() {
    try {
        const url = 'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=trade';
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        
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
        console.error('❌ Error fetching Upbit announcements:', error.message);
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
    
    // Check if already sent
    if (sentAnnouncements.has(hash)) {
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
    try {
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'HTML',
        });
        return true;
    } catch (error) {
        console.log(error)
        console.error('❌ Telegram send error:', error.message);
        return false;
    }
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
        console.log('ℹ️ Binance monitoring is disabled');
        return { processed: 0, sent: 0 };
    }
    
    console.log('\n🟡 Checking Binance announcements...');
    let processed = 0, sent = 0;
    
    for (const catalogId of BINANCE_CATALOG_IDS) {
        try {
            const catalogData = await getBinanceAnnouncements(catalogId);
            console.log(`   Catalog ${catalogId}: ${catalogData.articles.length} articles`);
            
            for (const article of catalogData.articles) {
                processed++;
                const announcement = await processAnnouncement(article);
                
                if (announcement) {
                    const message = createTelegramMessage(announcement);
                    const success = await sendTelegramMessage(message);
                    
                    if (success) {
                        sent++;
                        sentAnnouncements.add(announcement.hash);
                        console.log(`   ✅ Sent: ${announcement.title.substring(0, 50)}...`);
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Error processing Binance catalog ${catalogId}:`, error.message);
        }
    }
    
    console.log(`   📊 Binance: Processed ${processed}, Sent ${sent}`);
    return { processed, sent };
}

async function checkUpbitAnnouncements() {
    if (!EXCHANGES.UPBIT.enabled) {
        console.log('ℹ️ Upbit monitoring is disabled');
        return { processed: 0, sent: 0 };
    }
    
    console.log('\n🔵 Checking Upbit announcements...');
    let processed = 0, sent = 0;
    
    try {
        const articles = await getUpbitAnnouncements();
        console.log(`   Found ${articles.length} announcements`);
        
        for (const article of articles) {
            processed++;
            const announcement = await processAnnouncement(article);
            
            if (announcement) {
                const message = createTelegramMessage(announcement);
                const success = await sendTelegramMessage(message);
                
                if (success) {
                    sent++;
                    sentAnnouncements.add(announcement.hash);
                    console.log(`   ✅ Sent: ${announcement.title.substring(0, 50)}...`);
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
        }
    } catch (error) {
        console.error('❌ Error processing Upbit announcements:', error.message);
    }
    
    console.log(`   📊 Upbit: Processed ${processed}, Sent ${sent}`);
    return { processed, sent };
}

async function checkAllAnnouncements() {
    console.log(`\n⏰ [${new Date().toISOString()}] Checking for new announcements...`);
    
    const binanceResult = await checkBinanceAnnouncements();
    const upbitResult = await checkUpbitAnnouncements();
    
    const totalProcessed = binanceResult.processed + upbitResult.processed;
    const totalSent = binanceResult.sent + upbitResult.sent;
    
    // Save sent announcements if any were sent
    if (totalSent > 0) {
        await saveSentAnnouncements();
    }
    
    console.log(`\n📊 Summary:`);
    console.log(`   Binance: ${binanceResult.processed} processed, ${binanceResult.sent} sent`);
    console.log(`   Upbit: ${upbitResult.processed} processed, ${upbitResult.sent} sent`);
    console.log(`   Total: ${totalProcessed} processed, ${totalSent} sent`);
    console.log(`   Storage: ${sentAnnouncements.size} total sent announcements`);
    
    return { totalProcessed, totalSent };
}

// ==================== HEALTH SERVER ====================
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
                enabled: EXCHANGES[key].enabled
            })),
            stats: {
                sentAnnouncements: sentAnnouncements.size,
                checkInterval: `${CHECK_INTERVAL / 1000} seconds`
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
    CHECK_INTERVAL=15000           # Check interval in milliseconds
    PORT=3003                      # Health server port
        `);
        process.exit(1);
    }
    
    console.log(`✅ Configuration loaded`);
    console.log(`🤖 Telegram Bot: Connected`);
    console.log(`📊 Enabled exchanges:`);
    console.log(`   ${EXCHANGES.BINANCE.enabled ? '✅' : '❌'} ${EXCHANGES.BINANCE.name}`);
    console.log(`   ${EXCHANGES.UPBIT.enabled ? '✅' : '❌'} ${EXCHANGES.UPBIT.name}`);
    console.log(`⏰ Check Interval: ${CHECK_INTERVAL / 1000} seconds`);
    console.log(`💾 Storage: ${STORAGE_FILE}`);
    
    // Load previously sent announcements
    await loadSentAnnouncements();
    
    // Start health server
    startHealthServer();
    
    // Initial check immediately
    console.log(`\n🔍 Performing initial check...`);
    await checkAllAnnouncements();
    
    // Set up periodic checking
    const interval = setInterval(checkAllAnnouncements, CHECK_INTERVAL);
    
    console.log(`\n✅ Bot is now running and monitoring exchanges!`);
    console.log(`📱 Telegram notifications will be sent to chat: ${TELEGRAM_CHAT_ID}`);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log(`\n👋 Shutting down bot...`);
        clearInterval(interval);
        await saveSentAnnouncements();
        console.log(`💾 Saved ${sentAnnouncements.size} announcements to storage`);
        console.log(`🛑 Bot stopped`);
        process.exit(0);
    });
}

// ==================== START THE BOT ====================
main().catch(error => {
    console.error('💥 Fatal error during startup:', error);
    process.exit(1);
});