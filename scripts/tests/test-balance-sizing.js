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

if (failed > 0) process.exit(1);
console.log('\nAll balance-sizing tests passed');
process.exit(0);
