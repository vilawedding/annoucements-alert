/**
 * Upbit announcement relay - Cloudflare Worker (free plan: 100k requests/day).
 *
 * Purpose: extra egress IPs for polling Upbit's announcement API, which is rate limited
 * per IP. Only the announcements list endpoint is relayed (not an open proxy) and every
 * request must carry the shared secret in `x-relay-key`.
 *
 *   GET /announcements?os=web&page=1&per_page=5&category=trade  → Upbit response (status + body)
 *   GET /trace                                                  → IP that Cloudflare-fronted sites
 *                                                                  (like Upbit) see for this relay
 * Setup: Workers → Create → paste this file → Settings → Variables → add secret RELAY_KEY.
 */
const UPSTREAM = 'https://api-manager.upbit.com/api/v1/announcements';
const ALLOWED_PARAMS = ['os', 'page', 'per_page', 'category'];
const UPSTREAM_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
};

function json(body, status, extraHeaders = {}) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders }
    });
}

export default {
    async fetch(request, env) {
        if (!env.RELAY_KEY || request.headers.get('x-relay-key') !== env.RELAY_KEY) {
            return json({ error: 'forbidden' }, 403);
        }

        const url = new URL(request.url);
        const colo = (request.cf && request.cf.colo) || '';

        if (url.pathname === '/trace') {
            // cdn-cgi/trace is served by Cloudflare itself: `ip=` is the address a
            // Cloudflare-fronted origin's rate limiter would count for this relay.
            const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { cf: { cacheTtl: 0 } });
            const trace = Object.fromEntries((await res.text()).trim().split('\n').map(line => line.split('=')));
            return json({ relay: 'cloudflare-worker', colo, egressIp: trace.ip, egressColo: trace.colo }, 200);
        }

        if (url.pathname !== '/announcements') {
            return json({ error: 'not found' }, 404);
        }

        const target = new URL(UPSTREAM);
        for (const key of ALLOWED_PARAMS) {
            const value = url.searchParams.get(key);
            if (value !== null) target.searchParams.set(key, value);
        }

        const startedAt = Date.now();
        try {
            const upstream = await fetch(target.toString(), {
                headers: UPSTREAM_HEADERS,
                cf: { cacheTtl: 0, cacheEverything: false }
            });
            const body = await upstream.text();
            return json(body, upstream.status, {
                'x-relay-upstream-ms': String(Date.now() - startedAt),
                'x-relay-upstream-cache': upstream.headers.get('cf-cache-status') || '',
                'x-relay-colo': colo
            });
        } catch (error) {
            return json({ error: 'upstream fetch failed', message: String(error && error.message) }, 502, { 'x-relay-colo': colo });
        }
    }
};
