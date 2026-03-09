const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const https = require('https');
const config = require('../../config/config');
const storage = require('../storage');

const httpClient = axios.create({
    timeout: 5000,
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 100
    }),
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
    }
});

/**
 * Binance Announcements Monitor
 */

class BinanceMonitor {
    constructor() {
        this.config = config.exchanges.binance;
        this.catalogIds = this.config.catalogIds;
        this.catalogNames = this.config.catalogNames;
        this.blacklist = new Set(['USDT', 'FDUSD', 'TUSD', 'USD', 'BTC', 'ETH', 'BNB']);
    }
    
    async fetchAnnouncements(catalogId) {
        try {
            const url = 'https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query';

            const response = await httpClient.get(url, {
                params: {
                    type: 1,
                    pageNo: 1,
                    pageSize: 5,
                    catalogId
                },
                timeout: 3500
            });
            
            if (response.data.success && response.data.data?.catalogs?.length > 0) {
                const catalog = response.data.data.catalogs[0];
                return {
                    name: catalog.catalogName,
                    articles: catalog.articles.map(article => ({
                        id: article.id,
                        code: article.code,
                        title: article.title,
                        releaseDate: article.releaseDate,
                        catalogId: catalogId,
                        exchange: 'BINANCE',
                        url: `https://www.binance.com/en/support/announcement/${article.code}`
                    }))
                };
            }
            
            return { name: this.catalogNames[catalogId] || `Catalog ${catalogId}`, articles: [] };
            
        } catch (error) {
            return { name: this.catalogNames[catalogId] || `Catalog ${catalogId}`, articles: [] };
        }
    }
    
    async parseDelistDetails(articleCode) {
        try {
            const url = `https://www.binance.com/en/support/announcement/${articleCode}`;
            
            const response = await httpClient.get(url, {
                timeout: 15000
            });

            const pageHtml = String(response.data || '');
            const tokens = new Set();
            let content = '';

            const jsonMatch = pageHtml.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
            if (jsonMatch && jsonMatch[1]) {
                try {
                    const json = JSON.parse(jsonMatch[1]);
                    content =
                        json?.props?.pageProps?.article?.content ||
                        json?.props?.pageProps?.data?.article?.content ||
                        '';
                } catch (_) {}
            }

            if (!content) {
                const $page = cheerio.load(pageHtml);
                const contentSelectors = ['.article-body', '.htmlcontent', 'article'];

                for (const selector of contentSelectors) {
                    content = $page(selector).html() || '';
                    if (content) break;
                }
            }

            if (!content) return [];

            const $ = cheerio.load(content);
            const textContent = $.text().replace(/\s+/g, ' ');
            
            const slashPairs = [...textContent.matchAll(/([A-Z]{2,10})\s*\/\s*(USDT|BUSD|BTC|ETH|BNB|TUSD|FDUSD)/gi)];
            slashPairs.forEach(m => {
                if (m[1] && m[1].length >= 2) tokens.add(m[1].toUpperCase());
            });
            
            const usdtPairs = textContent.match(/([A-Z]{2,10})USDT/gi) || [];
            usdtPairs.forEach(pair => {
                const token = pair.replace('USDT', '');
                if (token.length >= 2) tokens.add(token.toUpperCase());
            });
            
            return Array.from(tokens);
            
        } catch (error) {
            return [];
        }
    }
    
    extractTokens(title) {
        const tokens = new Set();

        const unifiedPattern = /\(([A-Z]{2,10})\)|([A-Z]{2,10})(USDT|BUSD|BTC|ETH|BNB|TUSD|FDUSD)(?![a-z])|([A-Z]{2,10})\s*\/\s*(USDT|BUSD|BTC|ETH|BNB|TUSD|FDUSD)/gi;
        let match;
        while ((match = unifiedPattern.exec(title)) !== null) {
            const token = match[1] || match[2] || match[4];
            if (token) tokens.add(token.toUpperCase());
        }
        
        return Array.from(tokens);
    }

    filterValidTokens(tokens) {
        return Array.from(new Set(tokens))
            .map(t => String(t || '').toUpperCase().trim())
            .filter(t => t.length >= 2 && t.length <= 10)
            .filter(t => !this.blacklist.has(t));
    }

    generateSignals(tokens, category) {
        const side = category === 'DELISTING' ? 'SELL' : 'BUY';
        const signalType = category === 'DELISTING' ? 'DELISTING_SIGNAL' : 'LISTING_SIGNAL';

        return tokens.map(token => ({
            token,
            symbol: `${token}USDT`,
            side,
            type: signalType
        }));
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
        if (!['LISTING', 'NEW_PAIRS', 'DELISTING'].includes(category)) {
            return null;
        }

        const tokens = this.extractTokens(title);
        
        if (category === 'DELISTING' && tokens.length === 0 && /(delist|removal)/i.test(title)) {
            const detailedTokens = await this.parseDelistDetails(code);
            if (detailedTokens.length > 0) {
                tokens.push(...detailedTokens);
            }
        }

        const validTokens = this.filterValidTokens(tokens);
        if (validTokens.length === 0) {
            return null;
        }
        
        const formattedDate = new Date(releaseDate).toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            hour12: false
        });
        
        // Prepare metadata for storage with millisecond precision
        const detectionTime = Date.now();
        const primaryToken = validTokens.length > 0 ? validTokens[0] : null;
        const symbols = validTokens.map(token => `${token}USDT`);
        const symbol = primaryToken ? `${primaryToken}USDT` : null;
        const signals = this.generateSignals(validTokens, category);
        
        const metadata = {
            symbol,
            symbols,
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
            symbols,
            releaseDate,
            tokens: validTokens,
            signals,
            formattedDate,
            metadata,
            detectedAt: detectionTime,
            _shouldTrade: category === 'LISTING' || category === 'NEW_PAIRS'
        };
    }
    
    async check() {
        if (!this.config.enabled) {
            return { processed: 0, sent: 0, latestAnnouncement: null };
        }
        
        let processed = 0, sent = 0, latestAnnouncement = null;
        
        try {
            const catalogResults = await Promise.all(
                this.catalogIds.map(catalogId => this.fetchAnnouncements(catalogId))
            );

            for (const catalogData of catalogResults) {
                try {
                    const unseenArticles = [];

                    for (const article of catalogData.articles) {
                        const articleHash = crypto
                            .createHash('md5')
                            .update(`BINANCE-${article.catalogId}-${article.id}-${article.code}`)
                            .digest('hex');

                        // API usually returns latest first. Stop when hitting first known item.
                        if (storage.has(articleHash, 'BINANCE')) {
                            break;
                        }

                        unseenArticles.push(article);
                    }

                    if (unseenArticles.length === 0) {
                        continue;
                    }

                    const announcements = await Promise.all(
                        unseenArticles.map(article => this.processAnnouncement(article))
                    );

                    processed += unseenArticles.length;

                    for (const announcement of announcements) {
                        if (announcement) {
                            sent++;
                            if (!latestAnnouncement) {
                                latestAnnouncement = announcement;
                            }
                            storage.add(announcement.hash, announcement.metadata, 'BINANCE');
                        }
                    }
                } catch (error) {
                    console.error(`[BINANCE] Error processing catalog: ${error.message}`);
                }
            }

            if (sent > 0) {
                await storage.saveBinance();
            }
        } catch (error) {
            console.error(`[BINANCE] Error checking announcements: ${error.message}`);
        }
        
        return { processed, sent, latestAnnouncement };
    }
}

module.exports = new BinanceMonitor();
