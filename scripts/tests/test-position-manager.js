// Position manager / trade-engine / ladder tests (fake exchange + fake mark stream, no network).
// Run: node scripts/tests/test-position-manager.js
const assert = require('assert');
process.env.SEEN_STORE_DISABLED = 'true'; // never touch data/seen_*.json from tests
const fs = require('fs');
const os = require('os');
const path = require('path');

const engine = require('../../modules/trading/trade-engine');
const ladder = require('../../modules/trading/ladder');
const { PositionManager, roundToTick } = require('../../modules/trading/position-manager');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==================== FAKES ====================

function apiError(code, msg) {
    const e = new Error(msg);
    e.response = { status: 400, data: { code, msg } };
    return e;
}

function makeFakeBinance() {
    let nextAlgoId = 1000;
    const fake = {
        calls: [],
        conditionalErrors: [], // queue of errors thrown by the next placeConditional calls
        position: null,        // { positionAmt, entryPrice, leverage }
        userTrades: [],
        trading: {
            placeConditional: async (p) => {
                fake.calls.push(['placeConditional', p]);
                const err = fake.conditionalErrors.shift();
                if (err) throw err;
                return { algoId: ++nextAlgoId };
            },
            cancelAlgoOrder: async (id) => { fake.calls.push(['cancelAlgoOrder', id]); return {}; },
            cancelAllSymbolOrders: async (s) => { fake.calls.push(['cancelAllSymbolOrders', s]); return ['ok', 'ok']; },
            marketClose: async (symbol, side, qty) => {
                fake.calls.push(['marketClose', symbol, side, qty]);
                fake.position = null;
                return { orderId: 77 };
            },
            placeOrder: async (p) => { fake.calls.push(['placeOrder', p]); fake.position = null; return { orderId: 78 }; }
        },
        account: {
            getPositionInfo: async (symbol) => {
                const p = fake.position;
                const list = p ? [{ symbol: 'FOOUSDT', positionSide: 'BOTH', positionAmt: String(p.positionAmt), entryPrice: String(p.entryPrice), leverage: String(p.leverage || 20) }] : [];
                return symbol ? list.filter(x => x.symbol === symbol) : list;
            },
            getUserTrades: async () => fake.userTrades
        }
    };
    return fake;
}

function makeFakeStream() {
    const listeners = new Set();
    const prices = new Map();
    return {
        start() {},
        onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        getFreshPrice: (s) => prices.get(s) ?? null,
        set(symbol, price) { prices.set(symbol, price); listeners.forEach(fn => fn()); }
    };
}

function makeManager(overrides = {}) {
    const binance = makeFakeBinance();
    const stream = makeFakeStream();
    const messages = [];
    const pm = new PositionManager({
        binance,
        markStream: stream,
        precisionOf: () => ({ tickSize: 0.0001, stepSize: 1 }),
        notify: (m, ch) => messages.push({ m, ch }),
        settings: {
            enabled: true,
            pollMs: 60000,
            initialSlRoiPct: 20,
            disableTp: false,
            trailing: { activateRoiPct: 50, stepRoiPct: 25, lockBufferPct: 0, firstLockRoiPct: 0, maxGivebackRoiPct: 0 },
            ...overrides
        },
        storageFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')), 'positions.json')
    });
    // what start() wires up, without the poll timer / file load
    stream.onUpdate(() => pm._onMarkTick());
    return { pm, binance, stream, messages };
}

const waitFor = async (cond, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return; await sleep(20); }
    throw new Error('timeout waiting for condition');
};

// ==================== TRADE ENGINE (cross-check with pika) ====================

test('trade-engine matches pika formulas exactly', async () => {
    const pikaPath = path.resolve(__dirname, '../../../../pika/backend/lib/core/trade-engine.js');
    if (!fs.existsSync(pikaPath)) {
        console.log('   (pika source not found, checking known values only)');
    } else {
        const pika = await import(pikaPath);
        for (const side of ['BUY', 'SELL']) {
            for (const lev of [5, 10, 20]) {
                for (const level of [1, 2, 3, 5]) {
                    for (const [buf, step, first, act, give] of [[0, 25, 0, 50, 0], [2, 12, 15, 25, 10], [0, 25, 0, 0, 0]]) {
                        assert.strictEqual(engine.getTrailSlPrice(side, 1.234, lev, level, buf, step, first, act, give),
                            pika.getTrailSlPrice(side, 1.234, lev, level, buf, step, first, act, give));
                    }
                }
                assert.strictEqual(engine.calcInitialSlPrice(side, 2.5, lev, 40), pika.calcInitialSlPrice(side, 2.5, lev, 40));
                assert.strictEqual(engine.calcTpPrice(side, 2.5, lev, 80), pika.calcTpPrice(side, 2.5, lev, 80));
                assert.strictEqual(engine.calcCurrentRoiPct(side, 2.5, 2.6, lev), pika.calcCurrentRoiPct(side, 2.5, 2.6, lev));
            }
        }
    }
    // LONG 20x, SL 20% ROI = 1% price
    assert.strictEqual(Number(engine.calcInitialSlPrice('BUY', 1, 20, 20).toFixed(6)), 0.99);
    assert.strictEqual(Number(engine.calcInitialSlPrice('SELL', 1, 20, 20).toFixed(6)), 1.01);
});

test('ladder matches pika buildLadderEntries', async () => {
    const pikaPath = path.resolve(__dirname, '../../../../pika/backend/lib/core/ladder.js');
    const signal = { side: 'BUY', signalClose: 100, signalHigh: 104, signalLow: 98, atr: 2, suggestMarketT1: false };
    const args = [signal, 10, [0.5, 1.2, 2.5], [1, 2], [0.2, 0.5, 1], 4.9, 7.9, 0, 1, 0];
    const ours = ladder.buildLadderEntries(...args);
    if (fs.existsSync(pikaPath)) {
        const pika = await import(pikaPath);
        assert.deepStrictEqual(ours, pika.buildLadderEntries(...args));
    }
    assert.strictEqual(ours.length, 3);
    assert.strictEqual(ours[0].price, 100 - 6 * 0.01, 'E1 = close - (high-low)*1%');
    assert.ok(ours[1].price < ours[0].price && ours[2].price < ours[1].price);
});

// ==================== POSITION MANAGER ====================

test('open places SL at -initialSlRoi and TP, rounded to tick', async () => {
    const { pm, binance } = makeManager();
    const summary = await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 0.5, leverage: 20, source: { exchange: 'UPBIT', category: 'LISTING' } });
    // SL: 0.5 * (1 - 20/2000) = 0.495 ; TP: Upbit TP% (config) × 20 ROI
    assert.strictEqual(summary.slPrice, 0.495);
    const sl = binance.calls.find(c => c[0] === 'placeConditional' && c[1].type === 'STOP_MARKET')[1];
    assert.strictEqual(sl.side, 'SELL');
    assert.strictEqual(sl.quantity, 100);
    assert.ok(summary.slAlgoId);
    assert.ok(binance.calls.some(c => c[0] === 'placeConditional' && c[1].type === 'TAKE_PROFIT_MARKET'));
    assert.strictEqual(roundToTick(0.123456, 0.0001), 0.1235);
});

test('trailing: new SL placed before old is cancelled; levels advance with ROI', async () => {
    const { pm, binance, stream, messages } = makeManager({ disableTp: true });
    await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 20, source: {} });
    const firstSl = pm.positions.get('FOOUSDT').slAlgoId;

    stream.set('FOOUSDT', 1.0251); // ROI 50.2% >= 50 → level 1, lock 0% → SL = entry 1.0
    await waitFor(() => pm.positions.get('FOOUSDT').trailLevel === 1);
    const s = pm.positions.get('FOOUSDT');
    assert.strictEqual(s.slPrice, 1);
    const placeIdx = binance.calls.findIndex(c => c[0] === 'placeConditional' && c[1].stopPrice === 1);
    const cancelIdx = binance.calls.findIndex(c => c[0] === 'cancelAlgoOrder' && c[1] === firstSl);
    assert.ok(placeIdx >= 0 && cancelIdx > placeIdx, 'new SL first, then cancel old');
    assert.ok(messages.some(x => x.ch === 'order' && x.m.includes('Level 1')));

    stream.set('FOOUSDT', 1.0376); // ROI 75.2% → level 2, lock 25% → SL 1.0125
    await waitFor(() => pm.positions.get('FOOUSDT').trailLevel === 2);
    assert.strictEqual(pm.positions.get('FOOUSDT').slPrice, 1.0125);
    assert.ok(pm.positions.get('FOOUSDT').peakRoiPct >= 75);
});

test('trailing SL rejected as already passed keeps the old SL and the level', async () => {
    const { pm, binance, stream } = makeManager({ disableTp: true });
    await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 20, source: {} });
    binance.conditionalErrors.push(apiError(-2021, 'Order would immediately trigger.'));
    stream.set('FOOUSDT', 1.0251);
    await sleep(100);
    const s = pm.positions.get('FOOUSDT');
    assert.strictEqual(s.trailLevel, 0);
    assert.strictEqual(s.slPrice, 0.99);
    assert.ok(!binance.calls.some(c => c[0] === 'cancelAlgoOrder'));
});

test('initial SL already passed (-2021) → emergency close + PnL message', async () => {
    const { pm, binance, messages } = makeManager({ disableTp: true });
    binance.position = { positionAmt: 100, entryPrice: 1 };
    binance.conditionalErrors.push(apiError(-2021, 'Order would immediately trigger.'));
    binance.userTrades = [
        { side: 'BUY', price: '1', qty: '100', realizedPnl: '0', commission: '0.04', commissionAsset: 'USDT' },
        { side: 'SELL', price: '0.98', qty: '100', realizedPnl: '-2', commission: '0.04', commissionAsset: 'USDT' }
    ];
    await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 20, source: {} });
    assert.ok(binance.calls.some(c => c[0] === 'marketClose' && c[2] === 'SELL' && c[3] === 100));
    assert.ok(!pm.positions.has('FOOUSDT'));
    const pnl = messages.find(x => x.ch === 'pnl');
    assert.ok(pnl && pnl.m.includes('-2.0800 USDT'), pnl && pnl.m);
    assert.ok(messages.some(x => x.ch === 'order' && x.m.includes('EMERGENCY CLOSE')));
});

test('poll: flat position confirmed → cancel leftovers, PnL from fills with fees', async () => {
    const { pm, binance, messages } = makeManager();
    binance.position = { positionAmt: 100, entryPrice: 1 };
    await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 20, source: { exchange: 'UPBIT', category: 'LISTING' } });
    binance.position = null; // SL / TP filled on the exchange
    binance.userTrades = [
        { side: 'BUY', price: '1', qty: '100', realizedPnl: '0', commission: '0.04', commissionAsset: 'USDT' },
        { side: 'SELL', price: '1.03', qty: '100', realizedPnl: '3', commission: '0.0412', commissionAsset: 'USDT' }
    ];
    await pm._poll();
    await waitFor(() => !pm.positions.has('FOOUSDT'));
    assert.ok(binance.calls.some(c => c[0] === 'cancelAllSymbolOrders'));
    const pnl = messages.find(x => x.ch === 'pnl');
    assert.ok(pnl.m.includes('+2.9188 USDT'), pnl.m);          // 3 - 0.0812 fees
    assert.ok(pnl.m.includes('+58.38% ROI'), pnl.m);           // 2.9188 / (100*1/20) margin
    assert.ok(pnl.m.includes('Signal: UPBIT LISTING'));
});

test('take-profit already passed is skipped without an error alert', async () => {
    const { pm, binance, messages } = makeManager();
    binance.conditionalErrors.push(null, apiError(-2021, 'Order would immediately trigger.')); // SL ok, TP passed
    const summary = await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 20, source: { exchange: 'UPBIT' } });
    assert.strictEqual(summary.tpPrice, null);
    assert.ok(summary.slAlgoId);
    assert.ok(!messages.some(x => x.m.includes('TP ĐẶT THẤT BẠI')));
});

test('software SL: mark past SL while the position is still open → close', async () => {
    const { pm, binance, stream } = makeManager({ disableTp: true });
    binance.position = { positionAmt: 100, entryPrice: 1 };
    await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 20, source: {} });
    stream.set('FOOUSDT', 0.985); // below SL 0.99, exchange SL "didn't fire"
    await waitFor(() => binance.calls.some(c => c[0] === 'marketClose'), 6000);
    await waitFor(() => !pm.positions.has('FOOUSDT'));
});

test('recommended setting (x10): SL -5% price, trail from +10% locks +5%, then follows', async () => {
    const { pm, binance, stream } = makeManager({
        initialSlRoiPct: 50, disableTp: true,
        trailing: { activateRoiPct: 100, stepRoiPct: 20, lockBufferPct: 0, firstLockRoiPct: 0, maxGivebackRoiPct: 50 }
    });
    const summary = await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 10, source: {} });
    assert.strictEqual(summary.slPrice, 0.95, 'SL 5% below entry');
    assert.strictEqual(summary.tpPrice, null, 'no TP');
    assert.ok(!binance.calls.some(c => c[1] && c[1].type === 'TAKE_PROFIT_MARKET'));

    stream.set('FOOUSDT', 1.101); // +10.1% → level 1, lock trigger(100)-50 = +50% ROI = +5% price
    await waitFor(() => pm.positions.get('FOOUSDT').trailLevel === 1);
    assert.strictEqual(pm.positions.get('FOOUSDT').slPrice, 1.05);

    stream.set('FOOUSDT', 1.121); // +12.1% → level 2 (trigger 120), lock 70% ROI = +7%
    await waitFor(() => pm.positions.get('FOOUSDT').trailLevel === 2);
    assert.strictEqual(pm.positions.get('FOOUSDT').slPrice, 1.07);
});

test('max hold time closes the position as TIME without an emergency alert', async () => {
    const { pm, binance, messages } = makeManager({ disableTp: true, maxHoldMin: 60 });
    binance.position = { positionAmt: 100, entryPrice: 1 };
    await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 20, source: {} });
    pm.positions.get('FOOUSDT').openedAt -= 61 * 60000;
    binance.userTrades = [{ side: 'SELL', price: '1.01', qty: '100', realizedPnl: '1', commission: '0', commissionAsset: 'USDT' }];
    await pm._poll();
    await waitFor(() => !pm.positions.has('FOOUSDT'));
    assert.ok(binance.calls.some(c => c[0] === 'marketClose'));
    assert.ok(messages.some(x => x.ch === 'pnl' && x.m.includes('TIME')));
    assert.ok(!messages.some(x => x.m.includes('EMERGENCY')));
});

test('short with per-strategy risk: SL above entry, no TP, no trailing, own max hold', async () => {
    const { pm, binance, stream, messages } = makeManager({ maxHoldMin: 60 });
    binance.position = { positionAmt: -100, entryPrice: 1 };
    const risk = { name: 'upbitWarning', initialSlRoiPct: 25, tpRoiPct: 0, trailing: null, maxHoldMin: 1440 };
    const summary = await pm.open({ symbol: 'FOOUSDT', side: 'SELL', quantity: 100, entryPrice: 1, leverage: 5, source: { exchange: 'UPBIT', category: 'WARNING' }, risk });
    assert.strictEqual(summary.slPrice, 1.05, 'short SL 5% above entry');
    assert.strictEqual(summary.tpPrice, null);
    const sl = binance.calls.find(c => c[0] === 'placeConditional')[1];
    assert.strictEqual(sl.side, 'BUY');
    assert.ok(!binance.calls.some(c => c[1] && c[1].type === 'TAKE_PROFIT_MARKET'));

    stream.set('FOOUSDT', 0.8); // +100% ROI for the short: profile has no trailing
    await sleep(100);
    assert.strictEqual(pm.positions.get('FOOUSDT').trailLevel, 0);

    pm.positions.get('FOOUSDT').openedAt -= 61 * 60000; // past the GLOBAL 60m, within the profile's 24h
    await pm._poll();
    await sleep(50);
    assert.ok(pm.positions.has('FOOUSDT'), 'profile max hold (24h) wins over global 60m');

    pm.positions.get('FOOUSDT').openedAt -= 1440 * 60000;
    binance.userTrades = [{ side: 'BUY', price: '0.9', qty: '100', realizedPnl: '10', commission: '0', commissionAsset: 'USDT' }];
    await pm._poll();
    await waitFor(() => !pm.positions.has('FOOUSDT'));
    const pnl = messages.find(x => x.ch === 'pnl');
    assert.ok(pnl.m.includes('TIME') && pnl.m.includes('SHORT') && pnl.m.includes('(upbitWarning)'), pnl.m);
});

test('state persists and a new manager resumes it', async () => {
    const { pm } = makeManager({ disableTp: true });
    await pm.open({ symbol: 'FOOUSDT', side: 'BUY', quantity: 100, entryPrice: 1, leverage: 20, source: {} });
    await pm.saveChain;
    const saved = JSON.parse(fs.readFileSync(pm.storageFile, 'utf8'));
    assert.strictEqual(saved[0].symbol, 'FOOUSDT');
    assert.strictEqual(saved[0].slPrice, 0.99);

    const { pm: pm2 } = makeManager();
    pm2.storageFile = pm.storageFile;
    await pm2._load();
    assert.strictEqual(pm2.positions.get('FOOUSDT').slPrice, 0.99);
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`✅ ${name}`);
        } catch (error) {
            failed++;
            console.log(`❌ ${name}\n   ${error.stack.split('\n').slice(0, 3).join('\n   ')}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
