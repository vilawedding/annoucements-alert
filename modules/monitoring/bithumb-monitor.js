const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const config = require('../../config/config');
const storage = require('../storage');

const httpClient = axios.create({
    timeout: 2500,
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 100
    }),
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    }
});

class BithumbMonitor {
    constructor() {
        this.config = config.exchanges.bithumb;
        this.lastNoticeId = null;
    }

    async fetchLatestNotice() {
        try {
            const separator = this.config.apiUrl.includes('?') ? '&' : '?';
            const url = `${this.config.apiUrl}${separator}_=${Date.now()}`;
            const response = await httpClient.get(url);
            const notices = response.data?.pageProps?.noticeList || [];
            return notices[0] || null; // only first record as requested
        } catch (_) {
            return null;
        }
    }

    extractToken(title = '') {
        const match = title.match(/\(([A-Z0-9]{2,15})\)/);
        return match ? match[1].toUpperCase() : null;
    }

    categorize(notice) {
        const c1 = String(notice?.categoryName1 || '');
        const title = String(notice?.title || '');

        if (c1.includes('마켓 추가') || title.includes('마켓 추가')) {
            return 'LISTING';
        }
        return 'OTHER';
    }

    async check() {
        if (!this.config.enabled) {
            return { processed: 0, sent: 0, announcement: null, latestAnnouncement: null };
        }

        let processed = 0;
        let sent = 0;
        let latestAnnouncement = null;

        try {
            const notice = await this.fetchLatestNotice();
            if (!notice || !notice.id) {
                return { processed, sent, announcement: null, latestAnnouncement };
            }

            if (this.lastNoticeId && String(this.lastNoticeId) === String(notice.id)) {
                return { processed, sent, announcement: null, latestAnnouncement };
            }

            this.lastNoticeId = notice.id;
            processed = 1;

            const listedAtRaw = notice.publicationDateTime || notice.modifyDateTime || '';
            const listedAt = listedAtRaw ? new Date(`${listedAtRaw.replace(' ', 'T')}+09:00`).getTime() : Date.now();
            const hash = crypto.createHash('md5').update(`BITHUMB-${notice.id}-${listedAtRaw}`).digest('hex');

            if (storage.has(hash, 'BITHUMB')) {
                return { processed, sent, announcement: null, latestAnnouncement };
            }

            const category = this.categorize(notice);
            const token = this.extractToken(notice.title || '');
            const tokens = token ? [token] : [];
            const detectionTime = Date.now();

            const metadata = {
                symbol: token ? `${token}USDT` : '',
                title: notice.title || '',
                link: 'https://www.bithumb.com/customer_support/info_announcement',
                exchange: 'BITHUMB',
                detectedAt: detectionTime,
                orderedAt: null,
                latency: null
            };

            const announcement = {
                hash,
                exchange: 'BITHUMB',
                category,
                title: notice.title || '',
                url: metadata.link,
                symbol: metadata.symbol || null,
                releaseDate: listedAt,
                tokens,
                detectedAt: detectionTime,
                metadata,
                _shouldTrade: false
            };

            storage.add(hash, metadata, 'BITHUMB');
            storage.saveBithumb().catch(() => {});

            latestAnnouncement = announcement;
            sent = 1;

            return { processed, sent, announcement: null, latestAnnouncement };
        } catch (_) {
            return { processed, sent, announcement: null, latestAnnouncement };
        }
    }
}

module.exports = new BithumbMonitor();
