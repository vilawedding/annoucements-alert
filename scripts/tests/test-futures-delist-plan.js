// Binance futures delist entry plan: A (race, before the crash) or B (wait for the bounce).
// No network: _executeBinance is stubbed. Run: node --require ./preload.js scripts/tests/test-futures-delist-plan.js
const assert = require('assert');
process.env.SEEN_STORE_DISABLED = 'true';
const config = require('../../config/config');
config.autoTrade.enabled = true;
const p = config.strategies.binanceDelisting;
p.futuresRaceMaxMs = 850;
p.futuresRaceAfterPushMs = 50;
p.futuresDelaySec = 0.4;

const trader = require('../../modules/automation/lightning-trader');
const calls = [];
trader._executeBinance = async (a, opts) => { calls.push({ plan: a._entryPlan, at: Date.now(), opts }); return [{ success: true }]; };

let failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`✅ ${name}`); } catch (error) { failed++; console.error(`❌ ${name}\n   ${error.stack}`); }
}
const delist = (elapsedMs, extra = {}) => ({ exchange: 'BINANCE', category: 'DELISTING', delistScope: 'FUTURES', title: 'Binance Futures Will Delist USDⓈ-M XUSDT Perpetual Contract', tokens: ['X'], releaseDate: Date.now() - elapsedMs, ...extra });

(async () => {
    await test('official source, +300ms after publish -> plan A, immediately', async () => {
        calls.length = 0;
        const t = Date.now();
        await trader.executeLight(delist(300));
        assert.strictEqual(calls[0].plan, 'A');
        assert.ok(calls[0].at - t < 50);
        assert.ok(calls[0].opts.freshnessChecked);
    });
    await test('official source, +1500ms -> plan B at publish + delay', async () => {
        calls.length = 0;
        const a = delist(100);
        a.releaseDate = Date.now() - 1500 + 1500 - 1000; // 1000ms ago, over 850
        await trader.executeLight(a);
        assert.strictEqual(calls[0].plan, 'B');
        assert.ok(calls[0].at >= a.releaseDate + 400 - 5, `entered at +${calls[0].at - a.releaseDate}ms`);
    });
    await test('cryptolisting, +30ms after its push -> plan A; +300ms -> plan B', async () => {
        calls.length = 0;
        await trader.executeLight(delist(30, { _source: 'CRYPTOLISTING' }));
        await trader.executeLight(delist(300, { _source: 'CRYPTOLISTING' }));
        assert.deepStrictEqual(calls.map(c => c.plan), ['A', 'B']);
    });
    await test('spot delist and delay 0 keep the normal immediate path', async () => {
        calls.length = 0;
        await trader.executeLight({ ...delist(2000), delistScope: 'SPOT' });
        p.futuresDelaySec = 0;
        await trader.executeLight(delist(2000));
        assert.deepStrictEqual(calls.map(c => c.plan), [undefined, undefined]);
    });
    if (failed > 0) process.exit(1);
    console.log('\nAll futures-delist plan tests passed');
    process.exit(0);
})();
