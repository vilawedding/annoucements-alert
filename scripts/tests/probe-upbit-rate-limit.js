// Measure Upbit announcement API rate limit for ONE egress IP (direct or a proxy).
// Run on a clean IP (a bot already polling from it skews the result):
//   node scripts/tests/probe-upbit-rate-limit.js [proxyUrl|direct] [rates=0.2,0.5,1,2,3] [secondsPerStep=60]
// Steps up the request rate; at the first 429/418 it stops and measures how long the
// penalty lasts. Prints a suggested UPBIT_PER_IP_MIN_INTERVAL_MS for that IP.
// NOTE: hitting the limit gets this IP penalized for a while - don't run it on the bot's IP while trading.
const { createHttpClient, maskProxyUrl } = require('../../modules/monitoring/proxy-pool');

const proxyUrl = process.argv[2] || 'direct';
const rates = (process.argv[3] || '0.2,0.5,1,2,3').split(',').map(Number).filter(r => r > 0);
const secondsPerStep = parseInt(process.argv[4] || '60', 10);
const API = 'https://api-manager.upbit.com/api/v1/announcements';
const PENALTY_CHECK_EVERY_MS = 15000;

const client = createHttpClient(proxyUrl, { timeout: 5000, headers: { Accept: 'application/json' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Same cache-key rotation as the bot (real params only, so requests reach the origin).
let k = 0;
async function request() {
    const oses = ['web', 'android', 'ios'];
    const os = oses[k % 3];
    const perPage = 3 + Math.floor(k / 3) % 18;
    k++;
    const startedAt = Date.now();
    try {
        const res = await client.get(`${API}?os=${os}&page=1&per_page=${perPage}&category=trade`);
        return { status: res.status, ms: Date.now() - startedAt, cache: res.headers['cf-cache-status'] };
    } catch (error) {
        return { status: error?.response?.status || error.code || error.message, ms: Date.now() - startedAt };
    }
}

function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

(async () => {
    console.log(`Probing ${maskProxyUrl(proxyUrl)} | rates=${rates.join(',')} req/s | ${secondsPerStep}s per step`);

    const first = await request();
    if (first.status !== 200) {
        console.log(`❌ Already blocked/failed before probing: ${first.status}. Wait for the penalty to expire (or check the proxy).`);
        process.exit(1);
    }

    let lastOkRate = null;
    for (const rate of rates) {
        const latencies = [];
        const stepStart = Date.now();
        let sent = 0;

        while (Date.now() - stepStart < secondsPerStep * 1000) {
            const tickStart = Date.now();
            const r = await request();
            sent++;

            if (r.status !== 200) {
                const atSec = ((Date.now() - stepStart) / 1000).toFixed(1);
                console.log(`🚫 rate=${rate}/s: got ${r.status} after ${sent} requests (${atSec}s into the step)`);

                const penaltyStart = Date.now();
                for (;;) {
                    await sleep(PENALTY_CHECK_EVERY_MS);
                    const check = await request();
                    if (check.status === 200) break;
                }
                const penaltySec = Math.round((Date.now() - penaltyStart) / 1000);
                console.log(`⏱️  penalty lasted ~${penaltySec}s (checked every ${PENALTY_CHECK_EVERY_MS / 1000}s)`);

                if (lastOkRate) {
                    const suggested = Math.ceil((1000 / lastOkRate) * 1.25);
                    console.log(`\n✅ Sustained OK: ${lastOkRate} req/s for ${secondsPerStep}s`);
                    console.log(`👉 Suggested UPBIT_PER_IP_MIN_INTERVAL_MS=${suggested} (25% safety margin)`);
                } else {
                    console.log(`\n⚠️ Even the lowest rate (${rates[0]}/s) hit the limit. Try lower rates, e.g. 0.05,0.1`);
                }
                process.exit(0);
            }

            latencies.push(r.ms);
            await sleep(Math.max(0, 1000 / rate - (Date.now() - tickStart)));
        }

        lastOkRate = rate;
        console.log(`✅ rate=${rate}/s: ${sent} requests OK | latency p50=${percentile(latencies, 0.5)}ms p90=${percentile(latencies, 0.9)}ms`);
    }

    console.log(`\n✅ No limit hit up to ${lastOkRate} req/s. Try higher rates to find the ceiling.`);
    console.log(`👉 At least UPBIT_PER_IP_MIN_INTERVAL_MS=${Math.ceil(1000 / lastOkRate)} is safe for this IP`);
    process.exit(0);
})();
