// One-position-per-symbol gate of the trader (no network: the entry itself is stubbed).
// Run: node --require ./preload.js scripts/tests/test-position-per-symbol.js
const assert = require('assert');
process.env.SEEN_STORE_DISABLED = 'true';
const config = require('../../config/config');
config.autoTrade.upbitWarning = true;
config.autoTrade.upbitDelisting = true;

const trader = require('../../modules/automation/lightning-trader');
// Stand-in position manager: only `positions` is read by the gate.
trader.positionManager = { positions: new Map() };

const signal = (tokens, category = 'WARNING') => ({ exchange: 'UPBIT', category, title: `test ${tokens}`, tokens, releaseDate: Date.now() });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`✅ ${name}`);
    } catch (error) {
        failed++;
        console.error(`❌ ${name}\n   ${error.stack}`);
    }
}

(async () => {
    const entries = [];
    trader._executeEntries = async (announcement, exchange, category, tokens) => {
        entries.push(...tokens);
        await sleep(50);
        return tokens.map(token => ({ token, success: true }));
    };

    await test('same symbol while its entry is in flight is skipped, other symbols trade', async () => {
        entries.length = 0;
        const [a, b, c] = await Promise.all([
            trader.executeLight(signal(['AAA'])),
            trader.executeLight(signal(['AAA'], 'DELISTING')),
            trader.executeLight(signal(['BBB']))
        ]);
        assert.deepStrictEqual(entries.sort(), ['AAA', 'BBB']);
        assert.ok(a && c);
        assert.strictEqual(b, null);
    });

    await test('symbol with an open position is skipped, the rest of the notice trades', async () => {
        entries.length = 0;
        trader.positionManager.positions.set('AAAUSDT', { status: 'OPEN' });
        const r = await trader.executeLight(signal(['AAA', 'CCC']));
        assert.deepStrictEqual(entries, ['CCC']);
        assert.strictEqual(r.length, 1);
    });

    await test('notice whose only symbol is open places nothing', async () => {
        entries.length = 0;
        assert.strictEqual(await trader.executeLight(signal(['AAA'])), null);
        assert.deepStrictEqual(entries, []);
    });

    await test('symbol trades again once its position is closed', async () => {
        entries.length = 0;
        trader.positionManager.positions.delete('AAAUSDT');
        assert.ok(await trader.executeLight(signal(['AAA'])));
        assert.deepStrictEqual(entries, ['AAA']);
    });

    await test('a failed entry frees the symbol', async () => {
        const ok = trader._executeEntries;
        trader._executeEntries = async () => { throw new Error('boom'); };
        await assert.rejects(trader.executeLight(signal(['EEE'])));
        trader._executeEntries = ok;
        assert.ok(await trader.executeLight(signal(['EEE'])));
    });

    if (failed > 0) process.exit(1);
    console.log('\nAll one-position-per-symbol tests passed');
    process.exit(0);
})();
