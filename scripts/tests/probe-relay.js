// Evaluate an Upbit announcement relay (relay/cloudflare-worker.js or relay/deno-deploy.ts).
// Run: node scripts/tests/probe-relay.js <relayBaseUrl> <relayKey> [rates=0.2,0.5,1,2,3] [secondsPerStep=60]
//   1) /trace x5      → which egress IP(s) Cloudflare-fronted Upbit sees from the relay
//   2) latency        → total time via relay vs time spent relay→Upbit
//   3) rate steps     → sustained req/s through the relay before Upbit answers 429
const axios = require('axios');
const https = require('https');

const [baseUrl, relayKey] = process.argv.slice(2, 4);
const rates = (process.argv[4] || '0.2,0.5,1,2,3').split(',').map(Number).filter(r => r > 0);
const secondsPerStep = parseInt(process.argv[5] || '60', 10);

if (!baseUrl || !relayKey) {
    console.error('Usage: node scripts/tests/probe-relay.js <relayBaseUrl> <relayKey> [rates] [secondsPerStep]');
    process.exit(1);
}

const client = axios.create({
    baseURL: baseUrl.replace(/\/+$/, ''),
    timeout: 8000,
    headers: { 'x-relay-key': relayKey },
    httpsAgent: new https.Agent({ keepAlive: true }),
    proxy: false,
    validateStatus: () => true
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

let k = 0;
async function announcements() {
    const oses = ['web', 'android', 'ios'];
    const params = { os: oses[k % 3], page: 1, per_page: 3 + Math.floor(k / 3) % 18, category: 'trade' };
    k++;
    const startedAt = Date.now();
    try {
        const res = await client.get('/announcements', { params });
        return {
            status: res.status,
            totalMs: Date.now() - startedAt,
            upstreamMs: Number(res.headers['x-relay-upstream-ms']) || null,
            colo: res.headers['x-relay-colo'] || '',
            ok: res.status === 200 && res.data && res.data.success === true
        };
    } catch (error) {
        return { status: error.code || error.message, totalMs: Date.now() - startedAt };
    }
}

const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

(async () => {
    // 1) Egress IPs
    console.log('== /trace (egress IP seen by Cloudflare-fronted sites)');
    const ips = new Set();
    for (let i = 0; i < 5; i++) {
        const res = await client.get('/trace').catch(e => ({ status: e.code, data: null }));
        if (res.status !== 200) {
            console.log(`  ❌ /trace → ${res.status} ${JSON.stringify(res.data)}`);
            if (res.status === 403) console.log('     wrong relay key?');
            process.exit(1);
        }
        ips.add(res.data.egressIp);
        console.log(`  ${JSON.stringify(res.data)}`);
        await sleep(1000);
    }
    if ([...ips].some(ip => /^2a06:98c0:/i.test(ip))) {
        console.log('  ⚠️ Egress is Cloudflare Workers\' shared subrequest range: likely ONE rate-limit bucket shared by all Workers.');
    }
    console.log(`  distinct egress IPs: ${ips.size}`);

    // 2) Latency
    console.log('\n== latency (bot → relay → Upbit)');
    const first = await announcements();
    if (!first.ok) {
        console.log(`  ❌ first request: ${first.status} (relay works but Upbit refused it?)`);
        process.exit(1);
    }
    const totals = [first.totalMs];
    const ups = [first.upstreamMs];
    for (let i = 0; i < 2; i++) {
        await sleep(3000);
        const r = await announcements();
        if (!r.ok) break;
        totals.push(r.totalMs);
        ups.push(r.upstreamMs);
    }
    console.log(`  total=${totals.join('/')}ms  relay→Upbit=${ups.join('/')}ms  colo=${first.colo}`);

    // 3) Rate limit through the relay
    console.log('\n== rate steps through relay');
    let lastOkRate = null;
    for (const rate of rates) {
        const stepStart = Date.now();
        const latencies = [];
        let sent = 0;
        while (Date.now() - stepStart < secondsPerStep * 1000) {
            const tickStart = Date.now();
            const r = await announcements();
            sent++;
            if (!r.ok) {
                console.log(`  🚫 rate=${rate}/s: ${r.status} after ${sent} requests (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);
                console.log(lastOkRate
                    ? `\n✅ Relay sustains ${lastOkRate} req/s (home IP sustains ~0.1 req/s)`
                    : '\n⚠️ Relay hit the limit at the lowest rate - no better than a single IP');
                process.exit(0);
            }
            latencies.push(r.totalMs);
            await sleep(Math.max(0, 1000 / rate - (Date.now() - tickStart)));
        }
        lastOkRate = rate;
        console.log(`  ✅ rate=${rate}/s: ${sent} OK | total latency p50=${pct(latencies, 0.5)}ms p90=${pct(latencies, 0.9)}ms`);
    }
    console.log(`\n✅ No limit hit up to ${lastOkRate} req/s through the relay (home IP sustains ~0.1 req/s)`);
})();
