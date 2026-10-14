/**
 * Backtest of the Binance announcement strategies on historical futures klines.
 *   DELISTING ("Binance Will Delist X, Y on <date>") -> SHORT the token's USDT perp
 *   LISTING   ("Binance Will List X (X)")             -> LONG  the token's USDT perp
 *
 * Entry = open of the 1m candle after (release + LATENCY_S), i.e. a realistic detection delay.
 * Only events whose perp already traded at that moment are used. Public endpoints only.
 *
 *   node scripts/backtest/binance-backtest.js [delist|list|both] [latencySec] [maxEvents]
 */
const axios = require('axios');

const LIST_URL = 'https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query';
const KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines';
const BLACKLIST = new Set(['USDT', 'FDUSD', 'TUSD', 'USD', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB']);
const MIN = 60000;
const HORIZON_MIN = 1440;
const CHECKPOINTS = [1, 5, 15, 30, 60, 240];
const SL_GRID = [3, 5, 10, 0];            // % of price, 0 = no SL
const HOLD_GRID = [30, 60, 240, 1440];    // minutes (time stop)

const mode = process.argv[2] || 'both';
const latencyS = Number(process.argv[3] ?? 20);
const maxEvents = Number(process.argv[4] || 0);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchArticles(catalogId) {
    const out = [];
    for (let pageNo = 1; ; pageNo++) {
        const { data } = await axios.get(`${LIST_URL}?type=1&pageNo=${pageNo}&pageSize=50&catalogId=${catalogId}`, { timeout: 15000 });
        const articles = data?.data?.catalogs?.[0]?.articles || [];
        out.push(...articles);
        if (articles.length < 50) break;
        await sleep(150);
    }
    return out;
}

function parseDelistTokens(title) {
    const m = title.match(/\bwill delist\s+(.+?)\s+on\s+\d{4}-\d{2}-\d{2}/i);
    if (!m) return [];
    return m[1].split(/\s*(?:,|&|\band\b)\s*/i).map(s => s.trim()).filter(s => /^[A-Z0-9]{2,10}$/.test(s));
}

function parseListTokens(title) {
    if (!/^binance will list\b/i.test(title)) return [];
    return [...title.matchAll(/\(([A-Z0-9]{2,10})\)/g)].map(m => m[1]);
}

async function klines(symbol, startTime) {
    try {
        const { data } = await axios.get(KLINES_URL, {
            params: { symbol, interval: '1m', startTime, limit: HORIZON_MIN + 2 },
            timeout: 15000
        });
        return data.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
    } catch (e) {
        return null; // symbol never existed / delisted
    }
}

/** Side-adjusted % move of `price` vs entry (positive = profit). */
const pnlPct = (side, entry, price) => (side === 'LONG' ? 1 : -1) * (price / entry - 1) * 100;

function simulate(side, entry, candles, slPct, holdMin) {
    for (let i = 0; i < Math.min(holdMin, candles.length); i++) {
        const k = candles[i];
        if (slPct > 0) {
            const worst = side === 'LONG' ? k.l : k.h;
            if (pnlPct(side, entry, worst) <= -slPct) return -slPct; // SL first (conservative)
        }
    }
    const last = candles[Math.min(holdMin, candles.length) - 1];
    return pnlPct(side, entry, last.c);
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');

async function runStrategy(name, side, events) {
    console.log(`\n==================== ${name} (${side}) | latency=${latencyS}s | events with tokens: ${events.length} ====================`);
    const trades = [];
    let i = 0;
    for (const ev of events) {
        i++;
        const symbol = `${ev.token}USDT`;
        const entryMinute = Math.floor((ev.releaseDate + latencyS * 1000) / MIN) * MIN + MIN;
        if (entryMinute > Date.now() - HORIZON_MIN * MIN) continue; // not enough forward data
        const candles = await klines(symbol, entryMinute);
        await sleep(120);
        if (!candles || candles.length < 61 || candles[0].t - entryMinute > 2 * MIN) continue; // no perp yet
        const entry = candles[0].o;
        trades.push({ ...ev, symbol, entry, candles });
        if (i % 25 === 0) process.stderr.write(`  ${name}: ${i}/${events.length}\n`);
    }
    console.log(`tradable (perp existed, full 1m data): ${trades.length}`);
    if (trades.length === 0) return;

    console.log('\nPrice move after entry, side-adjusted % (positive = profit)');
    console.log('horizon | mean   | median | win%  | worst  | best');
    for (const m of CHECKPOINTS) {
        const v = trades.map(t => pnlPct(side, t.entry, t.candles[Math.min(m, t.candles.length) - 1].c));
        const win = (v.filter(x => x > 0).length / v.length) * 100;
        console.log(`${String(m).padStart(4)}m   | ${f(mean(v)).padStart(6)} | ${f(median(v)).padStart(6)} | ${f(win, 0).padStart(4)}% | ${f(Math.min(...v)).padStart(6)} | ${f(Math.max(...v))}`);
    }

    console.log('\nMax adverse excursion in first 60m (% against position): median / p90');
    const mae = trades.map(t => -Math.min(...t.candles.slice(0, 60).map(k => pnlPct(side, t.entry, side === 'LONG' ? k.l : k.h))));
    console.log(`  ${f(median(mae))} / ${f([...mae].sort((a, b) => a - b)[Math.floor(mae.length * 0.9)])}`);

    console.log('\nStrategy grid (price %, no fees/slippage): SL x time-stop');
    console.log('SL%   hold |  n  | win%  | mean   | median | total');
    const rows = [];
    for (const sl of SL_GRID) {
        for (const hold of HOLD_GRID) {
            const v = trades.map(t => simulate(side, t.entry, t.candles, sl, hold));
            rows.push({ sl, hold, win: (v.filter(x => x > 0).length / v.length) * 100, mean: mean(v), median: median(v), total: v.reduce((a, b) => a + b, 0), n: v.length });
        }
    }
    rows.sort((a, b) => b.total - a.total);
    for (const r of rows) {
        console.log(`${String(r.sl || 'none').padStart(4)} ${String(r.hold).padStart(5)}m | ${String(r.n).padStart(3)} | ${f(r.win, 0).padStart(4)}% | ${f(r.mean).padStart(6)} | ${f(r.median).padStart(6)} | ${f(r.total, 1)}`);
    }

    console.log('\nLatest 8 events:');
    for (const t of trades.slice(0, 8)) {
        console.log(`  ${new Date(t.releaseDate).toISOString().slice(0, 16)} ${t.symbol.padEnd(12)} 5m=${f(pnlPct(side, t.entry, t.candles[4].c), 1)}% 60m=${f(pnlPct(side, t.entry, t.candles[59].c), 1)}% | ${t.title.slice(0, 70)}`);
    }
}

(async () => {
    if (mode === 'delist' || mode === 'both') {
        const articles = await fetchArticles(161);
        let events = articles.flatMap(a => parseDelistTokens(a.title).filter(t => !BLACKLIST.has(t)).map(token => ({ token, title: a.title, releaseDate: a.releaseDate })));
        if (maxEvents) events = events.slice(0, maxEvents);
        console.log(`delisting articles: ${articles.length}`);
        await runStrategy('DELISTING', 'SHORT', events);
    }
    if (mode === 'list' || mode === 'both') {
        const articles = await fetchArticles(48);
        let events = articles.flatMap(a => parseListTokens(a.title).filter(t => !BLACKLIST.has(t)).map(token => ({ token, title: a.title, releaseDate: a.releaseDate })));
        if (maxEvents) events = events.slice(0, maxEvents);
        console.log(`listing articles: ${articles.length}`);
        await runStrategy('LISTING', 'LONG', events);
    }
})().catch(e => { console.error(e.message); process.exit(1); });
