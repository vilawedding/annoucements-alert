// Measure the Upbit announcement API limit as a request BUDGET per time window (one IP).
// Run: node scripts/tests/probe-upbit-burst.js [proxyUrl|direct] [rounds=3] [spacingMs=250]
// Each round: wait until the IP is unblocked and quiet, fire requests every spacingMs until
// the first 429 → budget = requests that passed. Then measure how long until requests pass
// again (recovery) and how many pass right after recovery (refill size).
const { createHttpClient, maskProxyUrl } = require('../../modules/monitoring/proxy-pool');

const proxyUrl = process.argv[2] || 'direct';
const rounds = parseInt(process.argv[3] || '3', 10);
const spacingMs = parseInt(process.argv[4] || '250', 10);
const QUIET_BEFORE_ROUND_MS = 70000;
const RECOVERY_CHECK_EVERY_MS = 2000;
const API = 'https://api-manager.upbit.com/api/v1/announcements';

const client = createHttpClient(proxyUrl, { timeout: 5000, headers: { Accept: 'application/json' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let k = 0;
async function request() {
    const oses = ['web', 'android', 'ios'];
    const os = oses[k % 3];
    const perPage = 3 + Math.floor(k / 3) % 18;
    k++;
    const startedAt = Date.now();
    try {
        const res = await client.get(`${API}?os=${os}&page=1&per_page=${perPage}&category=trade`);
        return { status: res.status, ms: Date.now() - startedAt };
    } catch (error) {
        return { status: error?.response?.status || error.code || error.message, ms: Date.now() - startedAt };
    }
}

async function burstUntilLimited(maxRequests = 60) {
    let passed = 0;
    const latencies = [];
    const startedAt = Date.now();
    for (let i = 0; i < maxRequests; i++) {
        const tickStart = Date.now();
        const r = await request();
        if (r.status !== 200) {
            return { passed, status: r.status, elapsedMs: Date.now() - startedAt, latencies };
        }
        passed++;
        latencies.push(r.ms);
        await sleep(Math.max(0, spacingMs - (Date.now() - tickStart)));
    }
    return { passed, status: 'NO_LIMIT', elapsedMs: Date.now() - startedAt, latencies };
}

(async () => {
    console.log(`Burst probe ${maskProxyUrl(proxyUrl)} | ${rounds} rounds | spacing ${spacingMs}ms | ${QUIET_BEFORE_ROUND_MS / 1000}s quiet before each round`);
    console.log('Make sure nothing else (bot, browser tab on upbit.com/notice) uses this IP meanwhile.\n');

    const results = [];
    for (let round = 1; round <= rounds; round++) {
        console.log(`Round ${round}: waiting ${QUIET_BEFORE_ROUND_MS / 1000}s quiet...`);
        await sleep(QUIET_BEFORE_ROUND_MS);

        const burst = await burstUntilLimited();
        const p50 = [...burst.latencies].sort((a, b) => a - b)[burst.latencies.length >> 1];
        console.log(`  burst: ${burst.passed} requests OK in ${(burst.elapsedMs / 1000).toFixed(1)}s, then ${burst.status} | latency p50=${p50}ms`);
        if (burst.status === 'NO_LIMIT') {
            results.push({ budget: burst.passed, recoveryMs: 0, refill: null });
            continue;
        }

        const limitedAt = Date.now();
        for (;;) {
            await sleep(RECOVERY_CHECK_EVERY_MS);
            const r = await request();
            if (r.status === 200) break;
        }
        const recoveryMs = Date.now() - limitedAt;
        console.log(`  recovered after ~${(recoveryMs / 1000).toFixed(0)}s (checked every ${RECOVERY_CHECK_EVERY_MS / 1000}s)`);

        const refill = await burstUntilLimited();
        console.log(`  right after recovery: ${refill.passed} more requests OK before ${refill.status}`);
        results.push({ budget: burst.passed, recoveryMs, refill: refill.passed });

        // let the refill burst's own limit expire before the next quiet period counts
        await sleep(RECOVERY_CHECK_EVERY_MS);
    }

    console.log('\nSummary:');
    results.forEach((r, i) => console.log(`  round ${i + 1}: budget=${r.budget} recovery=${Math.round(r.recoveryMs / 1000)}s refill=${r.refill}`));
    const minBudget = Math.min(...results.map(r => r.budget));
    console.log(`\n👉 Fresh budget per IP ≈ ${minBudget} requests (min over rounds)`);
})();
