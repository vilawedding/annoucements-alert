const axios = require('axios');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * Pool of egress IPs for rate-limited polling.
 *
 * Upbit's announcement API is rate limited per IP by Cloudflare (429, then 418 bans that
 * grow on repeat). Spreading requests over N IPs multiplies the budget, so polling can be
 * N times denser. Each entry ("direct" or a proxy URL) has its own keep-alive client,
 * its own minimum spacing between requests and its own 429/418 cooldown.
 *
 * Supported entries: direct | http://[user:pass@]host:port | https://... |
 *                    socks5://[user:pass@]host:port | socks5h://... | socks4://...
 */

function createAgent(proxyUrl) {
    const agentOptions = { keepAlive: true, maxSockets: 16 };
    if (!proxyUrl || proxyUrl === 'direct') return new https.Agent(agentOptions);
    if (/^socks/i.test(proxyUrl)) return new SocksProxyAgent(proxyUrl, agentOptions);
    if (/^https?:\/\//i.test(proxyUrl)) return new HttpsProxyAgent(proxyUrl, agentOptions);
    throw new Error(`Unsupported proxy URL: ${maskProxyUrl(proxyUrl)}`);
}

function maskProxyUrl(proxyUrl) {
    if (!proxyUrl || proxyUrl === 'direct') return 'direct';
    return String(proxyUrl).replace(/\/\/[^@/]+@/, '//***@');
}

function createHttpClient(proxyUrl, { timeout = 3000, headers = {} } = {}) {
    return axios.create({
        timeout,
        httpsAgent: createAgent(proxyUrl),
        // Never let axios pick up HTTP(S)_PROXY env vars on top of our agent.
        proxy: false,
        headers
    });
}

// A malformed entry (e.g. a copied placeholder like "http://user:pass@ip1:port") would
// otherwise crash startup with a bare "Invalid URL".
function createClientOrExplain(url, index, options) {
    try {
        return createHttpClient(url, options);
    } catch (error) {
        // error.message can echo the raw URL (credentials) - only report its code.
        const reason = error.code || (/^Unsupported proxy/.test(error.message) ? 'unsupported scheme' : 'invalid URL');
        throw new Error(`Invalid Upbit proxy #${index + 1} (${maskProxyUrl(url)}): ${reason}. Check UPBIT_PROXIES / UPBIT_PROXIES_FILE`);
    }
}

class ProxyPool {
    constructor(proxyUrls, { minIntervalMs, backoffMs, headers, timeout } = {}) {
        const urls = (proxyUrls && proxyUrls.length > 0) ? proxyUrls : ['direct'];
        this.minIntervalMs = minIntervalMs;
        this.backoffMs = backoffMs;
        this.cursor = 0;
        this.entries = urls.map((url, index) => ({
            id: maskProxyUrl(url),
            client: createClientOrExplain(url, index, { timeout, headers }),
            nextAllowedAt: 0,
            cooldownUntil: 0,
            ok: 0,
            errors: 0,
            rateLimited: 0,
            lastStatus: null,
            lastLatencyMs: null,
            lastSuccessAt: null
        }));
    }

    get size() {
        return this.entries.length;
    }

    _available(entry, now) {
        return now >= entry.nextAllowedAt && now >= entry.cooldownUntil;
    }

    /**
     * Round-robin over entries that are not cooling down and respect their own spacing.
     * Returns null when every IP is busy — the caller skips this tick instead of
     * overspending an IP's budget.
     */
    acquire(now = Date.now()) {
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[(this.cursor + i) % this.entries.length];
            if (this._available(entry, now)) {
                this.cursor = (this.cursor + i + 1) % this.entries.length;
                entry.nextAllowedAt = now + this.minIntervalMs;
                return entry;
            }
        }
        return null;
    }

    reportSuccess(entry, latencyMs) {
        entry.ok++;
        entry.lastStatus = 200;
        entry.lastLatencyMs = latencyMs;
        entry.lastSuccessAt = Date.now();
    }

    reportError(entry, status) {
        entry.errors++;
        entry.lastStatus = status || 'ERR';
        // 429 = over limit; 418 = temporarily banned after repeated 429s (ban grows on repeat).
        if (status === 429 || status === 418) {
            entry.rateLimited++;
            entry.cooldownUntil = Date.now() + this.backoffMs * (status === 418 ? 4 : 1);
        }
    }

    allCoolingDown(now = Date.now()) {
        return this.entries.every(entry => now < entry.cooldownUntil);
    }

    getHealth() {
        const now = Date.now();
        return this.entries.map(entry => ({
            id: entry.id,
            ok: entry.ok,
            errors: entry.errors,
            rateLimited: entry.rateLimited,
            lastStatus: entry.lastStatus,
            lastLatencyMs: entry.lastLatencyMs,
            coolingDownForMs: Math.max(0, entry.cooldownUntil - now),
            lastSuccessAt: entry.lastSuccessAt ? new Date(entry.lastSuccessAt).toISOString() : null
        }));
    }
}

module.exports = { ProxyPool, createHttpClient, maskProxyUrl };
