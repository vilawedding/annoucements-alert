// Margin sized to the futures wallet: configured margin, or all available USDT when there is less.
// Run: node --require ./preload.js scripts/tests/test-balance-sizing.js
const assert = require('assert');
process.env.SEEN_STORE_DISABLED = 'true';
const trader = require('../../modules/automation/lightning-trader');

let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
    } catch (error) {
        failed++;
        console.error(`❌ ${name}\n   ${error.stack}`);
    }
}

const profile = { name: 'upbitWarning', leverage: 20, amount: 200 }; // 10u margin

test('enough balance: configured margin, reserved', () => {
    trader.availableUsdt = 100;
    const r = trader._sizeToBalance(profile, 'AUSDT');
    assert.strictEqual(r.profile.amount, 200);
    assert.strictEqual(r.reservedMargin, 10);
    assert.strictEqual(trader.availableUsdt, 90);
});

test('less than the margin: whole available balance (x0.97), notional = that x leverage', () => {
    trader.availableUsdt = 6;
    const r = trader._sizeToBalance(profile, 'BUSDT');
    assert.ok(Math.abs(r.reservedMargin - 5.82) < 1e-9);
    assert.strictEqual(r.profile.amount, 116.4);
    assert.ok(Math.abs(trader.availableUsdt - 0.18) < 1e-9);
});

test('parallel tokens share the balance: second one gets the rest', () => {
    trader.availableUsdt = 15;
    const a = trader._sizeToBalance(profile, 'AUSDT');
    const b = trader._sizeToBalance(profile, 'BUSDT');
    assert.strictEqual(a.profile.amount, 200);
    assert.ok(b.profile.amount < 200 && b.profile.amount > 90);
});

test('dust balance (notional < 5 USDT): rejected', () => {
    trader.availableUsdt = 0.2;
    assert.throws(() => trader._sizeToBalance(profile, 'CUSDT'), /insufficient balance/);
});

test('failed entry gives the margin back', () => {
    trader.availableUsdt = 20;
    const r = trader._sizeToBalance(profile, 'DUSDT');
    trader._releaseMargin(r.reservedMargin);
    assert.strictEqual(trader.availableUsdt, 20);
});

test('unknown balance: as configured', () => {
    trader.availableUsdt = null;
    const r = trader._sizeToBalance(profile, 'EUSDT');
    assert.strictEqual(r.profile.amount, 200);
    assert.strictEqual(r.reservedMargin, 0);
});

// prepareMargin: a spot profile (Bybit, no leverage) once made the target NaN -> every preset failed.
(async () => {
    const config = require('../../config/config');
    const b = trader.binance;
    const real = { load: b.loadSymbolConfig, iso: b.isIsolatedCached, ens: b.ensureIsolated, get: b.getLeverageCached, set: b.changeInitialLeverage, max: b.getMaxLeverageCached };
    const calls = [];
    const lev = new Map([['AUSDT', 50], ['BUSDT', 20]]);
    b.loadSymbolConfig = async () => 2;
    b.isIsolatedCached = () => true;
    b.ensureIsolated = async () => {};
    b.getLeverageCached = s => lev.get(s);
    b.getMaxLeverageCached = () => 125;
    b.changeInitialLeverage = async (s, l) => { calls.push([s, l]); lev.set(s, l); return { leverage: l }; };
    trader.tradableSymbols = ['AUSDT', 'BUSDT'];
    const want = Math.max(config.autoTrade.leverage, ...Object.values(config.strategies).filter(p => p.leverage > 0).map(p => p.leverage));
    const real_ = setTimeout;
    global.setTimeout = (fn) => real_(fn, 0); // no spacing in the test
    try {
        await trader.prepareMargin();
        test('prepareMargin sets a numeric leverage, only where it differs', () => {
            assert.deepStrictEqual(calls, [['AUSDT', want]]);
            assert.ok(Number.isFinite(want) && want > 0);
        });
    } finally {
        global.setTimeout = real_;
        Object.assign(b, { loadSymbolConfig: real.load, isIsolatedCached: real.iso, ensureIsolated: real.ens, getLeverageCached: real.get, changeInitialLeverage: real.set, getMaxLeverageCached: real.max });
    }
    if (failed > 0) process.exit(1);
    console.log('\nAll balance-sizing tests passed');
    process.exit(0);
})();

