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
    })
});

class BithumbMonitor {
    constructor() {
        this.config = config.exchanges.bithumb;
        this.lastNoticeId = null;
        this.lastCloudflareWarningAt = 0;
        this.sessionCookie = this.config.cookie || '';
    }

    _extractCookiePairs(cookieString = '') {
        return String(cookieString)
            .split(';')
            .map(v => v.trim())
            .filter(v => v.includes('='))
            .filter(v => {
                const key = v.split('=')[0].toLowerCase();
                return key !== 'path' && key !== 'domain' && key !== 'expires' && key !== 'max-age' && key !== 'samesite' && key !== 'secure' && key !== 'httponly';
            });
    }

    _mergeCookieHeader(baseCookie = '', setCookieHeaders = []) {
        const cookieMap = {};

        this._extractCookiePairs(baseCookie).forEach(pair => {
            const idx = pair.indexOf('=');
            const key = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            cookieMap[key] = value;
        });

        (setCookieHeaders || []).forEach(raw => {
            const first = String(raw).split(';')[0].trim();
            if (!first.includes('=')) return;
            const idx = first.indexOf('=');
            const key = first.slice(0, idx).trim();
            const value = first.slice(idx + 1).trim();
            cookieMap[key] = value;
        });

        return Object.entries(cookieMap)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }

    _isCloudflareBlocked(err) {
        const status = err?.response?.status;
        const data = String(err?.response?.data || '');
        return status === 403 && (data.includes('Cloudflare') || data.includes('blocked'));
    }

    _warnCloudflareBlocked() {
        const now = Date.now();
        if (now - this.lastCloudflareWarningAt < 60000) {
            return;
        }
        this.lastCloudflareWarningAt = now;
        console.log('⚠️ [BITHUMB] Cloudflare 403 block from server IP. If browser works but bot fails, set BITHUMB_COOKIE (full cookie string) or BITHUMB_CF_CLEARANCE in .env.');
    }

    async fetchLatestNotice() {
        const url = this.config.apiUrl;

        const profiles = [
            {
                // Match the successful Postman request as close as possible
                headers: {
                    'User-Agent': 'PostmanRuntime/7.51.1',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                }
            },
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
                    'Referer': 'https://feed.bithumb.com/',
                    'Origin': 'https://feed.bithumb.com',
                    'X-Nextjs-Data': '1',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            }
        ];

        let lastErr = null;

        for (const profile of profiles) {
            try {
                const headers = { ...profile.headers };
                const cookieHeader = this.sessionCookie
                    || this.config.cookie
                    || (this.config.cfClearance ? `cf_clearance=${this.config.cfClearance}` : '');

                if (cookieHeader) {
                    headers.Cookie = cookieHeader;
                }

                const response = await httpClient.get(url, { headers });

                // Keep latest anti-bot cookies for next polls
                const setCookieHeaders = response?.headers?.['set-cookie'] || [];
                if (setCookieHeaders.length > 0) {
                    this.sessionCookie = this._mergeCookieHeader(headers.Cookie || '', setCookieHeaders);
                }

                const notices = response.data?.pageProps?.noticeList || [];
                return notices[0] || null; // only first record as requested
            } catch (err) {
                lastErr = err;
                if (this._isCloudflareBlocked(err)) {
                    continue;
                }
            }
        }

        if (this._isCloudflareBlocked(lastErr)) {
            this._warnCloudflareBlocked();
        }
        return null;
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
                _shouldTrade: category === 'LISTING'
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
