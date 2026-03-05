const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const config = require('../../config/config');
const storage = require('../storage');
const telegram = require('../notifications');

/**
 * Binance Announcements Monitor
 */

class BinanceMonitor {
    constructor() {
        this.config = config.exchanges.binance;
        this.catalogIds = this.config.catalogIds;
        this.catalogNames = this.config.catalogNames;
    }
    
    async fetchAnnouncements(catalogId) {
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
            
            return { name: this.catalogNames[catalogId] || `Catalog ${catalogId}`, articles: [] };
            
        } catch (error) {
            console.error(`❌ Binance catalog ${catalogId}:`, error.message);
            return { name: this.catalogNames[catalogId] || `Catalog ${catalogId}`, articles: [] };
        }
    }
    
    async parseDelistDetails(articleCode) {
        try {
            const url = `https://www.binance.com/en/support/announcement/${articleCode}`;
            
            const response = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 15000
            });
            
            const $ = cheerio.load(response.data);
            const tokens = new Set();
            
            const contentSelectors = ['.article-body', '.htmlcontent', 'article'];
            
            let content = '';
            for (const selector of contentSelectors) {
                content = $(selector).html() || '';
                if (content) break;
            }
            
            if (!content) return [];
            
            const textContent = $(content).text();
            
            const slashPairs = textContent.match(/([A-Z]{2,10})\s*\/\s*(USDT|BUSD|BTC|ETH|BNB)/gi) || [];
            slashPairs.forEach(pair => {
                const token = pair.split('/')[0].trim();
                if (token.length >= 2) tokens.add(token);
            });
            
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
    
    extractTokens(title) {
        const tokens = new Set();
        
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
    
    categorize(title, catalogId) {
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
    
    async processAnnouncement(article) {
        const { id, code, title, releaseDate, url, catalogId } = article;
        
        const hash = crypto.createHash('md5').update(`BINANCE-${catalogId}-${id}-${code}`).digest('hex');
        
        if (storage.has(hash, 'BINANCE')) {
            return null;
        }
        
        const category = this.categorize(title, catalogId);
        const tokens = this.extractTokens(title);
        
        if (category === 'DELISTING' && (tokens.length === 0 || title.toLowerCase().includes('multiple'))) {
            console.log(`🔍 Parsing detailed page for delisting: ${title}`);
            const detailedTokens = await this.parseDelistDetails(code);
            if (detailedTokens.length > 0) {
                tokens.push(...detailedTokens);
            }
        }
        
        const formattedDate = new Date(releaseDate).toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            hour12: false
        });
        
        // Prepare metadata for storage with millisecond precision
        const detectionTime = Date.now();
        const primaryToken = tokens.length > 0 ? tokens[0] : null;
        const symbol = primaryToken ? `${primaryToken}USDT` : null;
        
        const metadata = {
            symbol,
            title,
            link: url,
            exchange: 'BINANCE',
            detectedAt: detectionTime,
            orderedAt: null,
            latency: null
        };
        
        return {
            hash,
            exchange: 'BINANCE',
            catalogId,
            category,
            title,
            url,
            symbol,
            releaseDate,
            tokens: Array.from(new Set(tokens)),
            formattedDate,
            metadata,
            detectedAt: detectionTime
        };
    }
    
    async check() {
        if (!this.config.enabled) {
            return { processed: 0, sent: 0 };
        }
        
        let processed = 0, sent = 0;
        const fetchStart = Date.now();
        
        try {
            for (const catalogId of this.catalogIds) {
                try {
                    const catalogData = await this.fetchAnnouncements(catalogId);
                    
                    for (const article of catalogData.articles) {
                        const itemStart = Date.now();
                        processed++;
                        const announcement = await this.processAnnouncement(article);
                        
                        if (announcement) {
                            const message = telegram.createAnnouncementMessage(announcement);
                            console.log(`🟡 [BIN] ${announcement.title.substring(0, 60)}...`);
                            const success = await telegram.sendMessage(message);
                            
                            if (success) {
                                sent++;
                                // Store with detailed metadata including detection timestamp
                                storage.add(announcement.hash, announcement.metadata, 'BINANCE');
                                await storage.saveBinance();
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
}

module.exports = new BinanceMonitor();
