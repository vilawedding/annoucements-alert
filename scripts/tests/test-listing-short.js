// Delayed SHORT of Upbit BTC/USDT-only listings (no network: the order itself is stubbed).
// Run: node --require ./preload.js scripts/tests/test-listing-short.js
const assert = require('assert');
process.env.SEEN_STORE_DISABLED = 'true';
const config = require('../../config/config');
config.autoTrade.enabled = true;
config.autoTrade.upbitListing = false;            // long listing path off, as live
config.autoTrade.upbitListingBybitSpot = false;
config.strategies.upbitListingShort.delaySec = 0.2;

const trader = require('../../modules/automation/lightning-trader');
trader.positionManager = { positions: new Map() };

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

const listing = (title, releaseDate = Date.now()) => ({ exchange: 'UPBIT', category: 'LISTING', title, tokens: ['ABC'], releaseDate });
const BTC_USDT = '에이비씨(ABC) 신규 거래지원 안내 (BTC, USDT 마켓)';
const KRW = '에이비씨(ABC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)';

(async () => {
    const entries = [];
    trader._executeEntries = async (announcement, exchange, category, tokens) => {
        entries.push({ category, tokens, at: Date.now(), profile: trader.strategyProfile(exchange, category) });
        return tokens.map(token => ({ token, success: true, side: 'SHORT' }));
    };

    await test('flag off: nothing', async () => {
        config.autoTrade.upbitListingShort = false;
        entries.length = 0;
        assert.strictEqual(await trader.executeLight(listing(BTC_USDT)), null);
        assert.strictEqual(entries.length, 0);
    });

    config.autoTrade.upbitListingShort = true;

    await test('BTC/USDT-only listing is shorted after the delay with the listing-short profile', async () => {
        entries.length = 0;
        const start = Date.now();
        const r = await trader.executeLight(listing(BTC_USDT, start));
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].category, 'LISTING_SHORT');
        assert.ok(entries[0].at - start >= 180, `waited ${entries[0].at - start}ms`);
        assert.strictEqual(entries[0].profile.name, 'upbitListingShort');
        assert.strictEqual(entries[0].profile.risk.maxHoldMin, 240);
        assert.ok(r && r[0].success);
    });

    await test('the delay counts from the notice, not from detection', async () => {
        entries.length = 0;
        const start = Date.now();
        await trader.executeLight(listing(BTC_USDT, start - 150));
        assert.ok(entries[0].at - start < 150, `waited ${entries[0].at - start}ms`);
    });

    await test('KRW listing is never shorted', async () => {
        entries.length = 0;
        assert.strictEqual(await trader.executeLight(listing(KRW)), null);
        assert.strictEqual(entries.length, 0);
    });

    await test('stale notice is not shorted', async () => {
        entries.length = 0;
        assert.strictEqual(await trader.executeLight(listing(BTC_USDT, Date.now() - 3600e3)), null);
        assert.strictEqual(entries.length, 0);
    });

    if (failed > 0) process.exit(1);
    console.log('\nAll listing-short tests passed');
    process.exit(0);
})();
