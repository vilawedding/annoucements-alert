const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const config = require('../../config/config');
const storage = require('../storage');
const telegram = require('../notifications');

const httpClient = axios.create({
    timeout: 3000,
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
 * Upbit Announcements Monitor
 */

class UpbitMonitor {
    constructor() {
        this.config = config.exchanges.upbit;
        this.lastNoticeId = null;
    }
    
    async fetchAnnouncements() {
        try {
            const url = `${this.config.apiUrl}?os=web&page=1&per_page=1&category=trade`;
            
            const response = await httpClient.get(url);
            
            if (response.data.success) {
                const notices = response.data.data.notices;
                
                return notices.map(notice => ({
                    ...notice,
                    exchange: 'UPBIT',
                    title: notice.title,
                    url: 'https://upbit.com/notice',
                    releaseDate: new Date(notice.listed_at).getTime()
                }));
            }
            
            return [];
            
        } catch (error) {
            return [];
        }
    }
    
    extractToken(title) {
        const slashMarketMatch = title.match(/\(([A-Z]{2,10})\s*\/\s*(KRW|BTC|USDT)\)/i);
        if (slashMarketMatch) {
            return slashMarketMatch[1].toUpperCase();
        }

        const match = title.match(/\(([A-Z]{2,10})\)/);
        if (match) {
            return match[1].toUpperCase();
        }
        
        const uppercaseMatch = title.match(/\b([A-Z]{2,10})\b/);
        if (uppercaseMatch) {
            return uppercaseMatch[1].toUpperCase();
        }
        
        return null;
    }
    
    categorize(title) {
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
    
    async processAnnouncement(article) {
        const { id, title, listed_at, url } = article;
        
        const hash = crypto.createHash('md5').update(`UPBIT-${id}-${listed_at}`).digest('hex');
        
        if (storage.has(hash, 'UPBIT')) {
            return null;
        }
        
        const category = this.categorize(title);
        
        if (!['LISTING', 'DELISTING', 'WARNING'].includes(category)) {
            return null;
        }
        
        const token = this.extractToken(title);
        const tokens = token ? [token] : [];
        
        const releaseDate = typeof listed_at === 'number' ? listed_at : new Date(listed_at).getTime();
        const formattedDate = new Date(listed_at).toLocaleString('en-US', {
            timeZone: 'Asia/Seoul',
            hour12: false
        }) + ' (KST)';
        
        // Prepare metadata for storage with millisecond precision
        const detectionTime = Date.now();
        const symbol = token ? `${token}USDT` : null;
        
        const metadata = {
            symbol,
            title,
            link: url,
            exchange: 'UPBIT',
            detectedAt: detectionTime,
            orderedAt: null,
            latency: null
        };
        
        return {
            hash,
            exchange: 'UPBIT',
            category,
            title,
            url,
            symbol,
            releaseDate,
            tokens,
            formattedDate,
            metadata,
            detectedAt: detectionTime,
            _shouldTrade: category === 'LISTING'
        };
    }
    
    async check() {
        if (!this.config.enabled) {
            return { processed: 0, sent: 0, announcement: null };
        }
        
        let processed = 0, sent = 0, latestListing = null, latestAnnouncement = null;
        
        try {
            const articles = await this.fetchAnnouncements();

            const article = articles[0];
            if (!article) {
                return { processed, sent, announcement: latestListing, latestAnnouncement };
            }

            if (this.lastNoticeId && String(article.id) === String(this.lastNoticeId)) {
                return { processed, sent, announcement: latestListing, latestAnnouncement };
            }

            this.lastNoticeId = article.id;

            processed = 1;
            const announcement = await this.processAnnouncement(article);

            if (announcement) {
                const detectionTime = new Date();
                announcement._detectionTime = detectionTime;
                latestAnnouncement = announcement;
                sent = 1;

                // Store with detailed metadata including detection timestamp (non-blocking)
                storage.add(announcement.hash, announcement.metadata, 'UPBIT');
                storage.saveUpbit().catch(() => {});

                // Mark for auto-trade if it's a listing
                if (announcement._shouldTrade) {
                    latestListing = announcement;
                }
            }
        } catch (error) {
            // Silent fail
        }
        
        return { processed, sent, announcement: latestListing, latestAnnouncement };
    }
}

module.exports = new UpbitMonitor();
