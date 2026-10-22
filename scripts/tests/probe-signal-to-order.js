// Full path of a fake Binance spot-listing WS frame on the DEMO account, real orders:
// frame -> processWsMessage -> executeLight -> (leverage check) -> marketEntry (price + MARKET order + fill price)
// -> position manager places the SL -> then the probe closes the position and cancels its orders.
// Side effects cut: telegram, announcement storage, positions file (-> /tmp). Refuses unless DEMO.
// Run inside the bot container: docker compose exec announcement-bot node scripts/tests/probe-signal-to-order.js [rounds=3] [token=TIA] [--warmup]
// (--warmup runs the bot's own warmup first, as in production). Positions are closed and SLs cancelled after each round.
process.chdir('/app');
const config = require('/app/config/config');
if (config.binanceFutures.mode !== 'DEMO') { console.error('refusing: not DEMO'); process.exit(1); }
const ROUNDS = Number(process.argv[2] || 3);
const TOKEN = process.argv[3] || 'TIA';
const SYMBOL = `${TOKEN}USDT`;

const telegram = require('/app/modules/notifications');
for (const k of Object.keys(telegram)) if (typeof telegram[k] === 'function' && /send|notify/i.test(k)) telegram[k] = async () => true;
const storage = require('/app/modules/storage');
storage.add = () => {}; storage.has = () => false; storage.recordOrderExecution = () => {};
storage.saveBinance = storage.saveBithumb = storage.saveUpbit = async () => {};
const binanceMonitor = require('/app/modules/monitoring/binance-monitor');
const trader = require('/app/modules/automation/lightning-trader');
const b = trader.binance;
const pm = trader.positionManager;
if (!pm) { console.error('position manager disabled'); process.exit(1); }
pm.storageFile = '/tmp/probe-positions.json';
pm.notify = () => {};
trader.queueTelegramMessage = () => {};
config.autoTrade.enabled = true;
config.autoTrade.binanceListing = true;

const hr = () => Number(process.hrtime.bigint()) / 1e6;
let T = {};
const wrap = (obj, name, before, after) => {
    const real = obj[name].bind(obj);
    obj[name] = async (...args) => { before && before(...args); const r = await real(...args); after && after(r, ...args); return r; };
};
wrap(b, 'changeInitialLeverage', () => { T.levStart = hr(); }, () => { T.levEnd = hr(); });
wrap(b.trading, 'marketEntry', () => { T.entryCall = hr(); }, r => { T.entryDone = hr(); T.fillAt = Number((r.order || r).updateTime) || null; T.entry = r.entryPrice; T.qty = r.quantity; });
wrap(b.trading, 'placeOrder', p => { if (p.type === 'MARKET' && !T.sendAt) { T.send = hr(); T.sendAt = b.binanceNow(); } }, () => { if (!T.ack) T.ack = hr(); });
wrap(pm, 'open', () => { T.pmStart = hr(); }, r => { T.pmEnd = hr(); T.sl = r && r.slPrice; T.slId = r && r.slAlgoId; });

(async () => {
    const log = console.log, warn = console.warn;
    try { require('fs').unlinkSync(pm.storageFile); } catch (_) {}
    if (process.argv.includes('--warmup')) {
        // the bot's own warmup (precision of every perp, leverage brackets, streams, margin preset)
        console.log = console.warn = () => {};
        await trader.warmup();
        console.log = log; console.warn = warn;
    } else {
        b.priceStream.start();
        b.wsOrder.start();
        b.syncServerTime();
        await b.loadSymbolConfig();
        await b.getSymbolPrecision(SYMBOL);
    }
    await new Promise(r => setTimeout(r, 7000));
    log(`${SYMBOL}: isolated=${b.isIsolatedCached(SYMBOL)} leverage=${b.getLeverageCached(SYMBOL)} (listing profile ${config.strategies.binanceListing.leverage}x, preset ${trader.presetProfile().leverage}x) ws-order=${b.wsOrder.isReady()}`);
    const rows = [];
    for (let i = 0; i < ROUNDS; i++) {
        T = {};
        const frame = JSON.stringify({ type: 'DATA', topic: 'com_announcement_en', data: JSON.stringify({
            catalogId: 48, catalogName: 'New Cryptocurrency Listing', publishDate: Date.now(),
            title: `Binance Will List Probe Coin (${TOKEN}) with Seed Tag Applied #${Date.now()}`, body: '<p>probe</p>' }) });
        console.log = console.warn = () => {};
        T.frame = hr();
        const a = await binanceMonitor.processWsMessage(JSON.parse(frame));
        T.signal = hr();
        const res = a ? await trader.executeLight(a).catch(e => ({ error: e.message })) : null;
        T.done = hr();
        console.log = log; console.warn = warn;
        if (!T.ack) { log(`round ${i}: no order (${JSON.stringify(res).slice(0, 200)})`); continue; }
        const d = (x, y) => (T[x] && T[y] ? (T[y] - T[x]).toFixed(1) : '-');
        const row = {
            parse: d('frame', 'signal'), toEntryCall: d('signal', 'entryCall'), leverage: T.levStart ? d('levStart', 'levEnd') : 'none',
            priceToSend: d('entryCall', 'send'), frameToSend: d('frame', 'send'), sendToAck: d('send', 'ack'),
            sendToFillBinance: T.fillAt ? (T.fillAt - T.sendAt) : '-', ackToEntryPrice: d('ack', 'entryDone'), slPlace: d('pmStart', 'pmEnd'), total: d('frame', 'done')
        };
        rows.push(row);
        log(`round ${i}: ${JSON.stringify(row)} entry=${T.entry} sl=${T.sl}`);
        // cleanup: close the position and cancel its protective orders
        console.log = console.warn = () => {};
        try {
            await b.trading.marketClose(SYMBOL, 'SELL', T.qty);
            await b.trading.cancelAllSymbolOrders(SYMBOL).catch(() => {});
            if (T.slId) await b.trading.cancelAlgoOrder(T.slId).catch(() => {});
        } finally { console.log = log; console.warn = warn; }
        pm.positions.delete(SYMBOL);
        await new Promise(r => setTimeout(r, 1500));
    }
    const pos = (await b.account.getPositionInfo(SYMBOL)).find(p => p.symbol === SYMBOL);
    log(`cleanup check: ${SYMBOL} positionAmt=${pos ? pos.positionAmt : 'n/a'}`);
    process.exit(0);
})().catch(e => { console.error('probe failed', e); process.exit(1); });
