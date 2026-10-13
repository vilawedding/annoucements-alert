/**
 * Upbit announcement relay - Deno Deploy (free tier, runs on Google Cloud regions).
 * Same contract as relay/cloudflare-worker.js; use it if Cloudflare Worker subrequests
 * turn out to share one egress IP (see GET /trace).
 *
 *   GET /announcements?os=web&page=1&per_page=5&category=trade  → Upbit response
 *   GET /trace                                                  → egress IP seen by Cloudflare
 * Setup: dash.deno.com → New Project → Playground → paste → Settings → Env var RELAY_KEY.
 */
const UPSTREAM = 'https://api-manager.upbit.com/api/v1/announcements';
const ALLOWED_PARAMS = ['os', 'page', 'per_page', 'category'];
const UPSTREAM_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
};
const RELAY_KEY = Deno.env.get('RELAY_KEY') || '';
const REGION = Deno.env.get('DENO_REGION') || '';

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders }
    });
}

Deno.serve(async (request: Request) => {
    if (!RELAY_KEY || request.headers.get('x-relay-key') !== RELAY_KEY) {
        return json({ error: 'forbidden' }, 403);
    }

    const url = new URL(request.url);

    if (url.pathname === '/trace') {
        const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
        const trace = Object.fromEntries((await res.text()).trim().split('\n').map(line => line.split('=')));
        return json({ relay: 'deno-deploy', region: REGION, egressIp: trace.ip, egressColo: trace.colo }, 200);
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
        const upstream = await fetch(target.toString(), { headers: UPSTREAM_HEADERS });
        const body = await upstream.text();
        return json(body, upstream.status, {
            'x-relay-upstream-ms': String(Date.now() - startedAt),
            'x-relay-upstream-cache': upstream.headers.get('cf-cache-status') || '',
            'x-relay-colo': REGION
        });
    } catch (error) {
        return json({ error: 'upstream fetch failed', message: String((error as Error)?.message) }, 502);
    }
});
