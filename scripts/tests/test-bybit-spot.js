// Bybit SPOT route (Upbit KRW listings without a Binance perp) + spot position manager.
// No network: fake Bybit client. Run: node --require ./preload.js scripts/tests/test-bybit-spot.js
const assert = require('assert');
const crypto = require('crypto');
process.env.SEEN_STORE_DISABLED = 'true';
const config = require('../../config/config');
const { BybitSpot } = require('../../modules/trading/bybit-spot');
const { BybitSpotManager } = require('../../modules/trading/bybit-spot-manager');

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

function fakeClient({ pairs = ['MPLXUSDT', 'ABCUSDT'], buyPrice = 0.05 } = {}) {
    const calls = [];
    return {
        calls,
        cfg: { testnet: true },
        price: buyPrice,
        hasPair: symbol => pairs.includes(symbol),
        async marketBuy(symbol, usdt) {
            calls.push(['buy', symbol, usdt]);
            return { orderId: 'b1', status: 'Filled', avgPrice: buyPrice, qty: usdt / buyPrice, value: usdt, fee: 0.1 };
        },
        free: 1000,
        async freeBalance() { return this.free; },
        async lastPrice() { return this.price; },
        async marketSellAll(symbol) {
            calls.push(['sell', symbol]);
            return { orderId: 's1', status: 'Filled', avgPrice: this.price, qty: 1, value: 100 * this.price / buyPrice, fee: 0.1 };
        }
    };
}

const settings = { amount: 100, slPct: 5, maxHoldMin: 15 };

(async () => {
    await test('V5 signature = HMAC_SHA256(timestamp + apiKey + recvWindow + payload)', () => {
        const c = new BybitSpot({ apiKey: 'KEY', apiSecret: 'SECRET', baseUrl: 'https://x' });
        const expected = crypto.createHmac('sha256', 'SECRET').update('1700000000000KEY5000{"a":1}').digest('hex');
        assert.strictEqual(c._sign('1700000000000', '{"a":1}'), expected);
    });

    await test('manager: buy, SL on last price, sell all', async () => {
        let now = 1_000_000;
        const client = fakeClient();
        const m = new BybitSpotManager({ client, settings, now: () => now });
        const r = await m.open({ symbol: 'MPLXUSDT', token: 'MPLX', source: { exchange: 'UPBIT', category: 'LISTING' } });
        assert.ok(r.success && r.notified && r.venue === 'BYBIT_SPOT');
        assert.ok(Math.abs(m.positions.get('MPLXUSDT').slPrice - 0.0475) < 1e-12);
        client.price = 0.048; await m.tick();
        assert.ok(m.positions.has('MPLXUSDT'), 'above SL: still open');
        client.price = 0.047; await m.tick();
        assert.ok(!m.positions.has('MPLXUSDT'), 'SL hit: closed');
        assert.deepStrictEqual(client.calls.map(c => c[0]), ['buy', 'sell']);
    });

    await test('manager: less USDT than configured -> buys with the whole free balance; too little -> no order', async () => {
        const client = fakeClient();
        client.free = 40;
        const m = new BybitSpotManager({ client, settings, now: () => 1 });
        await m.open({ symbol: 'MPLXUSDT', token: 'MPLX' });
        assert.deepStrictEqual(client.calls[0], ['buy', 'MPLXUSDT', 39.6]);
        client.free = 3;
        await assert.rejects(m.open({ symbol: 'ABCUSDT', token: 'ABC' }), /insufficient/);
    });

    await test('manager: time stop closes after maxHoldMin', async () => {
        let now = 1_000_000;
        const client = fakeClient();
        const m = new BybitSpotManager({ client, settings, now: () => now });
        await m.open({ symbol: 'MPLXUSDT', token: 'MPLX' });
        client.price = 0.09;
        now += 14 * 60000; await m.tick();
        assert.ok(m.positions.has('MPLXUSDT'));
        now += 61000; await m.tick();
        assert.ok(!m.positions.has('MPLXUSDT'));
    });

    await test('manager: failed sell keeps the position for the next tick', async () => {
        const client = fakeClient();
        const m = new BybitSpotManager({ client, settings, now: () => 1 });
        await m.open({ symbol: 'MPLXUSDT', token: 'MPLX' });
        client.marketSellAll = async () => { throw new Error('network'); };
        client.price = 0.01; await m.tick();
        assert.strictEqual(m.positions.get('MPLXUSDT').status, 'OPEN');
        assert.strictEqual(m.positions.get('MPLXUSDT').sellFails, 1);
    });

    // ---------- routing in the trader ----------
    const trader = require('../../modules/automation/lightning-trader');
    const real = { enabled: config.autoTrade.enabled, spot: config.autoTrade.upbitListingBybitSpot, listing: config.autoTrade.upbitListing };
    config.autoTrade.enabled = true;
    config.autoTrade.upbitListingBybitSpot = true;
    config.autoTrade.upbitListing = false; // Binance listing path off, as live
    const client = fakeClient();
    trader.bybitSpot = new BybitSpotManager({ client, settings });
    trader.tradableSymbolSet = new Set(['BTCUSDT', '1000PEPEUSDT', 'ETHUSDT']);
    const listing = (tokens, title) => ({ exchange: 'UPBIT', category: 'LISTING', tokens, title, releaseDate: Date.now() });

    await test('KRW listing without Binance perp and with a Bybit pair buys on Bybit spot', async () => {
        client.calls.length = 0;
        const r = await trader.executeLight(listing(['MPLX'], '메타플렉스(MPLX) KRW 마켓 디지털 자산 추가'));
        assert.deepStrictEqual(client.calls, [['buy', 'MPLXUSDT', 100]]);
        assert.strictEqual(r.length, 1);
        assert.ok(r[0].success);
    });

    await test('same symbol already open on Bybit spot is skipped', async () => {
        client.calls.length = 0;
        assert.strictEqual(await trader.executeLight(listing(['MPLX'], '메타플렉스(MPLX) KRW 마켓 디지털 자산 추가')), null);
        assert.deepStrictEqual(client.calls, []);
        trader.bybitSpot.positions.clear();
    });

    await test('token with a Binance perp (incl. 1000x) is never bought on Bybit', async () => {
        client.calls.length = 0;
        await trader.executeLight(listing(['PEPE'], '페페(PEPE) KRW 마켓 디지털 자산 추가'));
        assert.deepStrictEqual(client.calls, []);
    });

    await test('BTC/USDT-only listing, stablecoin, missing Bybit pair or stale notice: no buy', async () => {
        client.calls.length = 0;
        await trader.executeLight(listing(['ABC'], '에이비씨(ABC) BTC, USDT 마켓 디지털 자산 추가'));
        await trader.executeLight(listing(['USDE'], '(USDE) KRW 마켓 디지털 자산 추가'));
        await trader.executeLight(listing(['ZZZ'], '(ZZZ) KRW 마켓 디지털 자산 추가'));
        await trader.executeLight({ ...listing(['ABC'], '(ABC) KRW 마켓 디지털 자산 추가'), releaseDate: Date.now() - 3600e3 });
        assert.deepStrictEqual(client.calls, []);
    });

    await test('Binance symbols not loaded: nothing routed', async () => {
        client.calls.length = 0;
        trader.tradableSymbolSet = new Set();
        await trader.executeLight(listing(['ABC'], '(ABC) KRW 마켓 디지털 자산 추가'));
        assert.deepStrictEqual(client.calls, []);
    });

    config.autoTrade.enabled = real.enabled;
    config.autoTrade.upbitListingBybitSpot = real.spot;
    config.autoTrade.upbitListing = real.listing;
    if (failed > 0) process.exit(1);
    console.log('\nAll Bybit spot tests passed');
    process.exit(0);
})();
