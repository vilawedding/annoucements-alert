/**
 * Parameter optimiser for every alert strategy, on historical Binance futures 1m klines.
 *
 *   BINANCE_LISTING (LONG)   BINANCE_DELISTING (SHORT)   BINANCE_NEW_PAIRS (LONG)
 *   UPBIT_LISTING   (LONG)   UPBIT_LISTING_KRW (LONG, KRW market only)
 *   UPBIT_WARNING   (SHORT)  UPBIT_DELISTING   (SHORT)
 *
 * For each strategy: grid over SL% x TP% x time-stop, net of COST_PCT, then a chronological
 * holdout (pick on the first 60% of events, evaluate on the last 40%) to expose overfitting.
 * Entry = open of the 1m candle after (release + latency). Within one candle SL is assumed hit
 * before TP. Klines are cached in data/backtest-cache so re-runs are instant.
 *
 *   node scripts/backtest/optimize.js [costPct=0.2] [s1|next|open0] [upbitLatencySec=5]
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_LIST = 'https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query';
const UPBIT_LIST = 'https://api-manager.upbit.com/api/v1/announcements';
const KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'backtest-cache');
const MIN = 60000;
const HORIZON = 1440;
const COST_PCT = Number(process.argv[2] ?? 0.2);
// next  = open of the 1m candle AFTER release+latency (pessimistic, up to 60s late)
// open0 = open of the candle CONTAINING release+latency (optimistic bound: price just before it)
// s1    = Binance SPOT 1s candle at release+latency (realistic; falls back to `next` if no spot pair)
const ENTRY_MODE = ['next', 'open0'].includes(process.argv[3]) ? process.argv[3] : 's1';          // round-trip fees + slippage, % of price
const LATENCY_S = { BINANCE: 20, UPBIT: Number(process.argv[4] ?? 5) };
const SL_GRID = process.env.SL_GRID ? process.env.SL_GRID.split(',').map(Number) : [2, 3, 5, 7, 10, 15, 0]; // % price, 0 = none
const TP_GRID = [0, 3, 5, 8, 12, 20, 30];
const HOLD_GRID = [5, 15, 30, 60, 120, 240, 480, 1440];
const MIN_TRADES = 15;

const BLACKLIST = new Set(['USDT', 'FDUSD', 'TUSD', 'USD', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB', 'KRW']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- announcements ----------
/** GET with backoff on 429/5xx; announcement lists are cached too (they only change slowly). */
async function getJson(url, cacheKey, gap = 250) {
    const file = path.join(CACHE_DIR, `ann-${cacheKey}.json`);
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 6 * 3600000) return JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let attempt = 0; ; attempt++) {
        try {
            const { data } = await axios.get(url, { timeout: 15000, headers: { Accept: 'application/json' } });
            fs.writeFileSync(file, JSON.stringify(data));
            await sleep(gap);
            return data;
        } catch (e) {
            const st = e.response?.status;
            if (attempt < 6 && (st === 429 || st >= 500 || !st)) { await sleep(5000 * (attempt + 1)); continue; }
            throw e;
        }
    }
}

async function binanceArticles(catalogId) {
    const out = [];
    for (let pageNo = 1; ; pageNo++) {
        const data = await getJson(`${BINANCE_LIST}?type=1&pageNo=${pageNo}&pageSize=50&catalogId=${catalogId}`, `b${catalogId}-${pageNo}`, 150);
        const a = data?.data?.catalogs?.[0]?.articles || [];
        out.push(...a);
        if (a.length < 50) break;
    }
    return out;
}

async function upbitNotices() {
    const out = [];
    for (let page = 1; ; page++) {
        const data = await getJson(`${UPBIT_LIST}?os=web&page=${page}&per_page=20&category=trade`, `u-${page}`, 800);
        const n = data?.data?.notices || [];
        out.push(...n);
        if (n.length === 0) break;
    }
    return out;
}

const uniq = a => [...new Set(a)].filter(t => !BLACKLIST.has(t));

function binanceDelistTokens(title) {
    const m = title.match(/\bwill delist\s+(.+?)\s+on\s+\d{4}-\d{2}-\d{2}/i);
    return m ? uniq(m[1].split(/\s*(?:,|&|\band\b)\s*/i).map(s => s.trim()).filter(s => /^[A-Z0-9]{2,10}$/.test(s))) : [];
}
const binanceListTokens = t => (/^binance will list\b/i.test(t) ? uniq([...t.matchAll(/\(([A-Z0-9]{2,10})\)/g)].map(m => m[1])) : []);
function binanceNewPairTokens(t) {
    if (!/add/i.test(t) || !/pairs/i.test(t)) return [];
    return uniq([...t.matchAll(/\(([A-Z0-9]{2,10})\)/g)].map(m => m[1]));
}

function upbitTokens(title) {
    const tokens = [];
    for (const m of title.matchAll(/\(([^()]+)\)/g)) {
        const items = m[1].split(',').map(s => s.trim());
        if (items.every(i => /^[A-Z0-9]{2,15}$/.test(i))) tokens.push(...items);
    }
    return uniq(tokens);
}
function upbitCategory(title) {
    const c = title.replace(/\s+/g, '');
    if (c.includes('신규거래지원안내') || c.includes('디지털자산추가')) return 'LISTING';
    if (c.includes('거래지원종료안내')) return 'DELISTING';
    if (c.includes('거래유의종목지정') && !c.includes('해제') && !c.includes('연장')) return 'WARNING';
    return null;
}

// ---------- klines ----------
async function klines(symbol, startTime) {
    const file = path.join(CACHE_DIR, `${symbol}-${startTime}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const { data } = await axios.get(KLINES, { params: { symbol, interval: '1m', startTime, limit: HORIZON + 2 }, timeout: 20000 });
            const c = data.map(k => [k[0], +k[1], +k[2], +k[3], +k[4]]); // t,o,h,l,c
            fs.writeFileSync(file, JSON.stringify(c));
            await sleep(280); // fapi weight budget: limit>1000 costs 10/req
            return c;
        } catch (e) {
            const status = e.response?.status;
            if (status === 429 || status === 418) { await sleep(20000 * (attempt + 1)); continue; }
            fs.writeFileSync(file, '[]'); // symbol did not exist
            return [];
        }
    }
    return [];
}

/** Price of the spot pair at `ts` (first 1s candle at/after it), or null. Weight 2 per call. */
async function spotPriceAt(symbol, ts) {
    const file = path.join(CACHE_DIR, `spot1s-${symbol}-${ts}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).p;
    let p = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const { data } = await axios.get('https://api.binance.com/api/v3/klines', { params: { symbol, interval: '1s', startTime: ts, limit: 5 }, timeout: 15000 });
            // skip empty 1s candles (volume 0 = carried price) only if a traded one follows closely
            const k = data.find(x => +x[5] > 0) || data[0];
            p = k && k[0] - ts < 120000 ? +k[1] : null;
            break;
        } catch (e) {
            const st = e.response?.status;
            if (st === 429 || st === 418) { await sleep(15000 * (attempt + 1)); continue; }
            break;
        }
    }
    fs.writeFileSync(file, JSON.stringify({ p }));
    await sleep(120);
    return p;
}

// ---------- simulation ----------
function sim(side, entry, c, sl, tp, hold) {
    const dir = side === 'LONG' ? 1 : -1;
    const n = Math.min(hold, c.length);
    for (let i = 0; i < n; i++) {
        const worst = dir * ((side === 'LONG' ? c[i][3] : c[i][2]) / entry - 1) * 100;
        const best = dir * ((side === 'LONG' ? c[i][2] : c[i][3]) / entry - 1) * 100;
        if (sl > 0 && worst <= -sl) return -sl - COST_PCT;
        if (tp > 0 && best >= tp) return tp - COST_PCT;
    }
    return dir * (c[n - 1][4] / entry - 1) * 100 - COST_PCT;
}

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

function evaluate(side, trades, sl, tp, hold) {
    const v = trades.map(t => sim(side, t.entry, t.c, sl, tp, hold));
    return { sl, tp, hold, n: v.length, mean: mean(v), median: median(v), win: v.filter(x => x > 0).length / v.length * 100, total: v.reduce((a, b) => a + b, 0), worst: Math.min(...v) };
}

function grid(side, trades) {
    const rows = [];
    for (const sl of SL_GRID) for (const tp of TP_GRID) for (const hold of HOLD_GRID) rows.push(evaluate(side, trades, sl, tp, hold));
    return rows;
}

const label = r => `SL ${r.sl || 'none'}% | TP ${r.tp || 'none'}% | hold ${r.hold}m`;

async function runStrategy(name, side, events, venue) {
    console.log(`\n################ ${name} (${side}) ################`);
    const trades = [];
    for (const ev of events) {
        const releaseMinute = Math.floor((ev.releaseDate + LATENCY_S[venue] * 1000) / MIN) * MIN;
        if (releaseMinute > Date.now() - HORIZON * MIN) continue;
        let c = await klines(`${ev.token}USDT`, releaseMinute);
        if (c.length < 62 || c[0][0] - releaseMinute > 2 * MIN) continue; // no perp / no data yet
        // Dead perp (settled/delisted contract): flat candles, no trades -> not tradable, would fake 0% trades.
        if (c.slice(0, 60).filter(k => k[2] === k[3]).length > 45) continue;
        let entry = c[0][1];
        if (ENTRY_MODE === 'next') { c = c.slice(1); entry = c[0][1]; }
        else if (ENTRY_MODE === 's1') {
            const ts = ev.releaseDate + LATENCY_S[venue] * 1000;
            const sp = await spotPriceAt(`${ev.token}USDT`, ts);
            const fut = c.find(k => k[0] + MIN > ts); // futures candle containing ts (reference for basis sanity)
            if (sp && fut && Math.abs(sp / fut[1] - 1) < 0.2) { entry = sp; c = c.slice(1); }
            else { c = c.slice(1); entry = c[0][1]; }  // no spot pair: conservative next-minute open
        }
        trades.push({ ...ev, entry, c });
    }
    trades.sort((a, b) => a.releaseDate - b.releaseDate);
    console.log(`events: ${events.length} | tradable (perp existed): ${trades.length} | ${trades.length ? new Date(trades[0].releaseDate).toISOString().slice(0, 10) + ' .. ' + new Date(trades[trades.length - 1].releaseDate).toISOString().slice(0, 10) : ''}`);
    if (trades.length < MIN_TRADES) { console.log('too few trades for a reliable optimisation — skipped'); return { name, skipped: true, n: trades.length }; }

    const rows = grid(side, trades);
    const ranked = [...rows].sort((a, b) => b.mean - a.mean);
    console.log('\nTop 5 on ALL data (net mean % price per trade):');
    for (const r of ranked.slice(0, 5)) console.log(`  ${label(r).padEnd(34)} mean ${f(r.mean).padStart(6)} | median ${f(r.median).padStart(6)} | win ${f(r.win, 0).padStart(3)}% | worst ${f(r.worst, 1).padStart(6)}`);

    const split = Math.floor(trades.length * 0.6);
    const train = trades.slice(0, split), test = trades.slice(split);
    const trainRows = grid(side, train).sort((a, b) => b.mean - a.mean);
    const best = trainRows[0];
    const oos = evaluate(side, test, best.sl, best.tp, best.hold);
    console.log(`\nHoldout: best on first ${train.length} = ${label(best)} (train mean ${f(best.mean)}) -> last ${test.length}: mean ${f(oos.mean)} | median ${f(oos.median)} | win ${f(oos.win, 0)}%`);

    // Robust pick: best by the WORSE of the two halves' mean, so it must work in both periods.
    const halfA = trades.slice(0, Math.floor(trades.length / 2)), halfB = trades.slice(Math.floor(trades.length / 2));
    let robust = null;
    for (const r of rows) {
        const a = evaluate(side, halfA, r.sl, r.tp, r.hold), b = evaluate(side, halfB, r.sl, r.tp, r.hold);
        const score = Math.min(a.mean, b.mean);
        if (!robust || score > robust.score) robust = { ...r, score, a: a.mean, b: b.mean };
    }
    console.log(`Robust pick (best worst-half): ${label(robust)} | all ${f(robust.mean)} (half1 ${f(robust.a)}, half2 ${f(robust.b)}) | win ${f(robust.win, 0)}% | worst trade ${f(robust.worst, 1)}%`);

    const slForLev = robust.sl || 10;
    console.log(`Leverage hint: SL ${slForLev}% x lev -> ROI loss; lev<=${Math.max(1, Math.floor(40 / slForLev))} keeps a stop-out under 40% of margin`);
    return { name, side, n: trades.length, robust, best, oos, all: ranked[0] };
}

(async () => {
    console.log(`entry=${ENTRY_MODE} | cost=${COST_PCT}% round trip | latency Binance=${LATENCY_S.BINANCE}s Upbit=${LATENCY_S.UPBIT}s | grid ${SL_GRID.length * TP_GRID.length * HOLD_GRID.length} combos`);

    const delist = await binanceArticles(161);
    const list48 = await binanceArticles(48);
    const upbit = await upbitNotices();
    console.log(`articles: binance delist ${delist.length}, binance listing-catalog ${list48.length}, upbit trade notices ${upbit.length}`);

    const bEv = (arts, fn) => arts.flatMap(a => fn(a.title).map(token => ({ token, title: a.title, releaseDate: a.releaseDate })));
    const uEv = (cat, krwOnly) => upbit.flatMap(n => {
        if (upbitCategory(n.title) !== cat) return [];
        if (krwOnly && !/KRW/.test(n.title)) return [];
        const t = new Date(n.listed_at).getTime();
        return upbitTokens(n.title).map(token => ({ token, title: n.title, releaseDate: t }));
    });

    const results = [];
    results.push(await runStrategy('BINANCE_LISTING', 'LONG', bEv(list48, binanceListTokens), 'BINANCE'));
    results.push(await runStrategy('BINANCE_DELISTING', 'SHORT', bEv(delist, binanceDelistTokens), 'BINANCE'));
    results.push(await runStrategy('BINANCE_NEW_PAIRS', 'LONG', bEv(list48, binanceNewPairTokens), 'BINANCE'));
    results.push(await runStrategy('UPBIT_LISTING', 'LONG', uEv('LISTING', false), 'UPBIT'));
    results.push(await runStrategy('UPBIT_LISTING_KRW', 'LONG', uEv('LISTING', true), 'UPBIT'));
    results.push(await runStrategy('UPBIT_WARNING', 'SHORT', uEv('WARNING', false), 'UPBIT'));
    results.push(await runStrategy('UPBIT_DELISTING', 'SHORT', uEv('DELISTING', false), 'UPBIT'));

    console.log('\n================ SUMMARY (robust pick, net of cost) ================');
    console.log('strategy             side  n    SL    TP    hold   mean%   win%  holdout-mean%');
    for (const r of results) {
        if (r.skipped) { console.log(`${r.name.padEnd(20)} skipped (n=${r.n})`); continue; }
        const p = r.robust;
        console.log(`${r.name.padEnd(20)} ${r.side.padEnd(5)} ${String(r.n).padStart(3)}  ${String(p.sl || '-').padStart(3)}%  ${String(p.tp || '-').padStart(3)}%  ${String(p.hold).padStart(5)}m  ${f(p.mean).padStart(6)}  ${f(p.win, 0).padStart(3)}%  ${f(r.oos.mean).padStart(6)}`);
    }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
