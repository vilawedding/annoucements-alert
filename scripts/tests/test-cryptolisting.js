// cryptolisting.ws mapping + cross-source dedup tests (no network, no writes to data/ files).
// Run: node scripts/tests/test-cryptolisting.js
const assert = require('assert');
process.env.SEEN_STORE_DISABLED = 'true';
process.env.UPBIT_PROXIES = 'direct';
process.env.UPBIT_PROXIES_FILE = '';
process.env.UPBIT_SSH_TUNNELS = '';
const config = require('../../config/config');
config.exchanges.upbit.enabled = true;
config.exchanges.bithumb.enabled = true;
config.exchanges.binance.enabled = true;
// Delist pages must never be fetched here
config.autoTrade.enabled = false;

const storage = require('../../modules/storage');
storage.saveUpbit = async () => {};
storage.saveBithumb = async () => {};
storage.saveBinance = async () => {};

const cl = require('../../modules/monitoring/cryptolisting-monitor');
const { CrossSourceDedup } = require('../../modules/monitoring/cross-source-dedup');

const nowUs = () => Date.now() * 1000;
const msg = (fields) => ({
    type: 'announcement',
    detectedTimestampUs: nowUs(),
    dispatchTimestampUs: nowUs(),
    abnormalDetectionLatency: false,
    ...fields
});

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
    await test('Binance spot delist -> DELISTING SPOT, tradable', async () => {
        const a = await cl.toAnnouncement(msg({
            title: 'Binance Will Delist EPIC, QUICK on 2026-10-28', ticker: 'EPIC,QUICK',
            publisher: 'binance', listingType: 'spot_delisting'
        }));
        assert.strictEqual(a.exchange, 'BINANCE');
        assert.strictEqual(a.category, 'DELISTING');
        assert.strictEqual(a.delistScope, 'SPOT');
        assert.deepStrictEqual(a.tokens, ['EPIC', 'QUICK']);
        assert.strictEqual(a._shouldTrade, true);
        assert.strictEqual(a._source, 'CRYPTOLISTING');
        assert.ok(Date.now() - a.releaseDate < 1000);
    });

    await test('Binance futures delist keeps the multiplier from the title', async () => {
        const a = await cl.toAnnouncement(msg({
            title: 'Binance Futures Will Delist USDⓈ-M 1000000BOBUSDT Perpetual Contract', ticker: 'BOB',
            publisher: 'binance', listingType: 'futures_delisting'
        }));
        assert.strictEqual(a.delistScope, 'FUTURES');
        assert.deepStrictEqual(a.tokens, ['1000000BOB']);
    });

    await test('Binance delist without tickers in the title falls back to socket ticker (no page fetch)', async () => {
        const a = await cl.toAnnouncement(msg({
            title: 'Notice of Removal of Spot Trading Pairs - 2026-10-24', ticker: 'XYZ',
            publisher: 'binance', listingType: 'spot_delisting'
        }));
        assert.deepStrictEqual(a.tokens, ['XYZ']);
    });

    await test('Binance hodler airdrop / not_listing are ignored', async () => {
        assert.strictEqual(await cl.toAnnouncement(msg({ title: 'Binance HODLer Airdrops: FOO', ticker: 'FOO', publisher: 'binance', listingType: 'hodler_airdrop' })), null);
        assert.strictEqual(await cl.toAnnouncement(msg({ title: 'Wallet maintenance', ticker: '', publisher: 'binance', listingType: 'not_listing' })), null);
    });

    await test('Binance bStocks pairs are neither alerted nor traded (socket and REST)', async () => {
        const title = 'Binance Exchange Adds RoboStrategy Inc (BOTB), Berkshire Hathaway (BRKBB), KraneShares STAR Market 50 ETF (KSTRB), Direxion Daily 20 Year Treasury Bull 3X ETF (TMFB) and Vistra Corp (VSTB) bStocks Trading Pairs on Binance Spot/Convert - 2026-10-21';
        assert.strictEqual(await cl.toAnnouncement(msg({ title, ticker: 'BOTB,BRKBB,KSTRB,TMFB,VSTB', publisher: 'binance', listingType: 'spot_listing' })), null);
        const binance = require('../../modules/monitoring/binance-monitor');
        assert.strictEqual(await binance.processAnnouncement({ id: 1, code: 'x', title, releaseDate: Date.now(), catalogId: 48, url: '' }, 'test-bstocks'), null);
        // a normal "Adds ... Trading Pairs" notice still goes through
        assert.ok(await binance.processAnnouncement({ id: 2, code: 'y', title: 'Binance Will Add ABC (ABC) Trading Pairs', releaseDate: Date.now(), catalogId: 48, url: '' }, 'test-pairs'));
    });

    // ---------- Binance official announcement WebSocket (com_announcement_en) ----------
    const binanceWs = require('../../modules/monitoring/binance-monitor');
    const push = d => ({ type: 'DATA', topic: 'com_announcement_en', data: JSON.stringify({ disclaimer: '', ...d }) });

    await test('Binance WS: spot delist with tokens only in the body -> tokens read from the body, no page fetch', async () => {
        const a = await binanceWs.processWsMessage(push({
            catalogId: 161, catalogName: 'Delisting', publishDate: Date.now(),
            title: 'Notice of Removal of Spot Trading Pairs - 2026-10-30',
            body: '<p>Binance will remove and cease trading on the following spot trading pairs: FOO/USDT, BAR/BTC</p>'
        }));
        assert.strictEqual(a.category, 'DELISTING');
        assert.ok(a.tokens.includes('FOO'), JSON.stringify(a.tokens));
        assert.strictEqual(a._source, 'WS');
    });

    await test('Binance WS: futures delist keeps the multiplier perp, title tokens win', async () => {
        const a = await binanceWs.processWsMessage(push({
            catalogId: 161, catalogName: 'Delisting', publishDate: Date.now(),
            title: 'Binance Futures Will Delist USDⓈ-M 1000000QQQUSDT Perpetual Contract', body: 'x'
        }));
        assert.strictEqual(a.delistScope, 'FUTURES');
        assert.deepStrictEqual(a.tokens, ['1000000QQQ']);
    });

    await test('Binance WS: other catalogs, COMMAND replies and bStocks are ignored', async () => {
        assert.strictEqual(await binanceWs.processWsMessage(push({ catalogId: 49, title: 'Binance Launchpool XYZ', publishDate: Date.now() })), null);
        assert.strictEqual(await binanceWs.processWsMessage({ type: 'COMMAND', data: 'SUCCESS', subType: 'SUBSCRIBE' }), null);
        assert.strictEqual(await binanceWs.processWsMessage(push({ catalogId: 48, publishDate: Date.now(), title: 'Binance Exchange Adds Vistra Corp (VSTB) bStocks Trading Pairs on Binance Spot/Convert' })), null);
    });

    await test('Binance WS: same push twice -> second is null (stored hash)', async () => {
        const msg = push({ catalogId: 161, publishDate: 1790000000000, title: 'Binance Will Delist ZZZ on 2026-11-02', body: '' });
        assert.ok(await binanceWs.processWsMessage(msg));
        assert.strictEqual(await binanceWs.processWsMessage(msg), null);
    });

    await test('Upbit delist -> DELISTING via Upbit categorize', async () => {
        const a = await cl.toAnnouncement(msg({
            title: '고트세우스 막시무스(GOAT) 거래지원 종료 안내', ticker: 'GOAT',
            publisher: 'upbit', listingType: 'spot_delisting'
        }));
        assert.strictEqual(a.exchange, 'UPBIT');
        assert.strictEqual(a.category, 'DELISTING');
        assert.deepStrictEqual(a.tokens, ['GOAT']);
        assert.strictEqual(a._shouldTrade, true);
    });

    await test('abnormalDetectionLatency -> alert only', async () => {
        const a = await cl.toAnnouncement(msg({
            title: '아무거나(ABC) 거래지원 종료 안내', ticker: 'ABC',
            publisher: 'upbit', listingType: 'spot_delisting', abnormalDetectionLatency: true
        }));
        assert.strictEqual(a._shouldTrade, false);
    });

    await test('disabled exchange is ignored', async () => {
        config.exchanges.bithumb.enabled = false;
        const a = await cl.toAnnouncement(msg({ title: '토큰(TKN) 원화 마켓 추가', ticker: 'TKN', publisher: 'bithumb', listingType: 'spot_listing' }));
        config.exchanges.bithumb.enabled = true;
        assert.strictEqual(a, null);
    });

    await test('Bithumb listing -> LISTING with token', async () => {
        const a = await cl.toAnnouncement(msg({ title: '토큰(TKN) 원화 마켓 추가', ticker: 'TKN', publisher: 'bithumb', listingType: 'spot_listing' }));
        assert.strictEqual(a.category, 'LISTING');
        assert.deepStrictEqual(a.tokens, ['TKN']);
    });

    await test('dedup: socket first, REST copy with spacing difference is dropped', async () => {
        const d = new CrossSourceDedup(null);
        const a = { exchange: 'BINANCE', category: 'DELISTING', delistScope: 'SPOT', title: 'Binance Will Delist EPIC, QUICK on 2026-10-28', tokens: ['EPIC', 'QUICK'] };
        assert.strictEqual(d.claim(a, 'CRYPTOLISTING'), null);
        const dup = d.claim({ ...a, title: 'Binance  Will Delist EPIC, QUICK on 2026-10-28 ' }, 'REST');
        assert.strictEqual(dup.source, 'CRYPTOLISTING');
    });

    await test('dedup: different title, same exchange/category/scope/tokens is dropped', async () => {
        const d = new CrossSourceDedup(null);
        d.claim({ exchange: 'UPBIT', category: 'DELISTING', title: 'A(GOAT) 거래지원 종료', tokens: ['GOAT'] }, 'CRYPTOLISTING');
        assert.ok(d.claim({ exchange: 'UPBIT', category: 'DELISTING', title: '[거래] A(GOAT) 거래지원 종료 안내', tokens: ['GOAT'] }, 'WS'));
    });

    await test('dedup: spot and futures delist of the same token are both kept', async () => {
        const d = new CrossSourceDedup(null);
        assert.strictEqual(d.claim({ exchange: 'BINANCE', category: 'DELISTING', delistScope: 'SPOT', title: 'Binance Will Delist FOO on 2026-10-28', tokens: ['FOO'] }, 'REST'), null);
        assert.strictEqual(d.claim({ exchange: 'BINANCE', category: 'DELISTING', delistScope: 'FUTURES', title: 'Binance Futures Will Delist USDⓈ-M FOOUSDT Perpetual Contract', tokens: ['FOO'] }, 'REST'), null);
    });

    await test('dedup: same title on another exchange is kept', async () => {
        const d = new CrossSourceDedup(null);
        d.claim({ exchange: 'UPBIT', category: 'LISTING', title: 'X', tokens: [] }, 'WS');
        assert.strictEqual(d.claim({ exchange: 'BITHUMB', category: 'LISTING', title: 'X', tokens: [] }, 'REST'), null);
    });

    if (failed > 0) {
        console.error(`\n${failed} test(s) failed`);
        process.exit(1);
    }
    console.log('\nAll cryptolisting tests passed');
    process.exit(0);
})();
