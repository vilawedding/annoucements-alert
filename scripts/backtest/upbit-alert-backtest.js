/**
 * Backtest LONG/SHORT on Binance USDT-M perpetuals triggered by Upbit announcements, entering
 * LATENCY seconds after Upbit published the notice (first_listed_at — listed_at moves on edits).
 *
 * Input: the export of scripts/report/export-announcements.js (data/reports/announcements-*.json).
 *
 *   LISTING (LONG; KRW market vs BTC/USDT-only reported separately)   DELISTING (SHORT)
 *   WARNING (SHORT)   CAUTION (SHORT)   WARNING_LIFTED (LONG)   WARNING_EXTENDED (SHORT)
 *
 * Entry: Binance SPOT 1s klines (pre = last close before publication, entry = open of the second
 * at publication + LATENCY), converted to perp units; perps without a spot pair use futures
 * aggTrades from data.binance.vision (fapi only serves the last 2 days). Then perp 1m klines up
 * to 24h — removed perps from data.binance.vision. Only perps that existed before the notice count.
 * Requests go over the egress IPs of UPBIT_PROXIES / UPBIT_PROXIES_FILE that can reach fapi
 * (geo-blocked ones answer 451 and are dropped). Responses cached in data/backtest-cache.
 *
 *   node scripts/backtest/upbit-alert-backtest.js [--latency 10] [--cost 0.2] [--input <json>]
 *
 * Output (data/reports/): backtest-upbit-*.csv (one row per trade + skipped events), backtest-upbit-*.md
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const config = require('../../config/config');
const { ProxyPool, createHttpClient, maskProxyUrl } = require('../../modules/monitoring/proxy-pool');

const REPORT_DIR = path.join(__dirname, '..', '..', 'data', 'reports');
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'backtest-cache', 'upbit-alert');
const FAPI = 'https://fapi.binance.com/fapi/v1';
const SPOT = 'https://api.binance.com/api/v3';
const MIN = 60000;
const HORIZON_MIN = 1440;

const args = process.argv.slice(2);
const argValue = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const LATENCY_MS = Number(argValue('--latency', 10)) * 1000;
const COST_PCT = Number(argValue('--cost', 0.2)); // round trip fees + slippage, % of price
const INPUT = argValue('--input', null) || latestExport();

const STRATEGIES = {
    LISTING: 'LONG',
    DELISTING: 'SHORT',
    WARNING: 'SHORT',
    CAUTION: 'SHORT',
    WARNING_LIFTED: 'LONG',
    WARNING_EXTENDED: 'SHORT'
};
// Binance notice types (scripts/report/export-announcements.js binanceType) -> default side.
// Futures listings are absent on purpose: the perp does not exist before the notice.
// PAIR_REMOVAL / PRODUCT_ADD / STOCKS name quote or stock tickers, not a tradable alt.
const BINANCE_STRATEGIES = {
    SPOT_LISTING: 'LONG',
    SPOT_LISTING_SEED: 'LONG',
    HODLER_AIRDROP: 'LONG',
    MARGIN_ADD: 'LONG',
    SPOT_DELIST: 'SHORT',
    FUTURES_DELIST: 'SHORT',
    MARGIN_DELIST: 'SHORT',
    ALPHA_REMOVE: 'SHORT',
    TAG_CHANGE: 'SHORT'
};
const EXCHANGE = String(argValue('--exchange', 'upbit')).toLowerCase(); // upbit | binance | all
const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'U']);
const HORIZONS = [1, 5, 15, 30, 60, 240, 1440];
const SL_GRID = [2, 3, 5, 10, 0]; // % price, 0 = none
const TP_GRID = [3, 5, 10, 20, 0];
const HOLD_GRID = [5, 15, 60, 240, 1440];
const MIN_TRADES_FOR_GRID = 8;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fmtTz = (ms, offsetH) => new Date(ms + offsetH * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const pct = (from, to) => (to / from - 1) * 100;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '');

function latestExport() {
    const files = fs.readdirSync(REPORT_DIR).filter(n => /^announcements-.*\.json$/.test(n)).sort();
    if (!files.length) throw new Error('No data/reports/announcements-*.json — run scripts/report/export-announcements.js first');
    return path.join(REPORT_DIR, files[files.length - 1]);
}

// ==================== HTTP (fapi over the proxy pool) ====================

let pool;

/** Keeps only the egress IPs that both fapi and the spot API answer (451 = region blocked). */
async function buildPool() {
    const usable = [];
    for (const url of config.exchanges.upbit.proxies) {
        try {
            const client = createHttpClient(url, { timeout: 10000 });
            await client.get(`${FAPI}/time`);
            await client.get(`${SPOT}/time`);
            usable.push(url);
        } catch (error) {
            console.warn(`  skip egress ${maskProxyUrl(url)}: ${error.response?.status || error.code}`);
        }
    }
    if (!usable.length) throw new Error('No egress IP can reach fapi.binance.com and api.binance.com');
    console.log(`Binance egress: ${usable.length}/${config.exchanges.upbit.proxies.length} IPs`);
    // aggTrades weight 20, klines(1500) weight 10; 2400 weight/min per IP -> 1 req / 600ms per IP is safe.
    pool = new ProxyPool(usable, { minIntervalMs: 600, backoffMs: 60000, timeout: 20000, headers: { Accept: 'application/json' } });
}

const fapi = pathAndQuery => binanceGet(FAPI, pathAndQuery);

async function binanceGet(base, pathAndQuery) {
    const file = path.join(CACHE_DIR, crypto.createHash('md5').update(base === FAPI ? pathAndQuery : base + pathAndQuery).digest('hex') + '.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let attempt = 0; attempt < 10; attempt++) {
        let egress = pool.acquire();
        while (!egress) { await sleep(100); egress = pool.acquire(); }
        try {
            const { data } = await egress.client.get(`${base}${pathAndQuery}`);
            pool.reportSuccess(egress, 0);
            fs.writeFileSync(file, JSON.stringify(data));
            return data;
        } catch (error) {
            const status = error.response?.status;
            pool.reportError(egress, status);
            // -1121 "Invalid symbol" = no such perp (never listed, or removed): a valid, cacheable answer.
            if (error.response?.data?.code === -1121) { fs.writeFileSync(file, 'null'); return null; }
            if (status === 400) throw new Error(`Binance 400 ${JSON.stringify(error.response.data)}: ${base}${pathAndQuery}`);
            console.warn(`  ⚠️ ${egress.id} ${status || error.code} - retry ${attempt + 1}`);
            await sleep(1000);
        }
    }
    throw new Error(`Binance request failed: ${base}${pathAndQuery}`);
}

// ==================== data.binance.vision (history fapi no longer serves) ====================
// fapi aggTrades only answers for the last 2 days (-4166), and removed perps (AERGO, ...) are
// "Invalid symbol" on fapi. Binance's public dumps keep both: daily zips per symbol.

const VISION = 'https://data.binance.vision/data/futures/um/daily';
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
// Dumps can be tens of MB: download from this machine, not through (metered) proxies.
const visionClient = createHttpClient('direct', { timeout: 120000 });

/** Downloads a daily zip; null when Binance has no file (symbol not trading that day). */
async function visionZip(url) {
    const tmp = path.join(CACHE_DIR, `tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}.zip`);
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const { data } = await visionClient.get(url, { responseType: 'arraybuffer' });
            fs.writeFileSync(tmp, Buffer.from(data));
            return tmp;
        } catch (error) {
            const status = error.response?.status;
            if (status === 404) return null;
            console.warn(`  ⚠️ vision ${status || error.code} - retry ${attempt + 1}`);
            await sleep(2000);
        }
    }
    throw new Error(`vision download failed: ${url}`);
}

/** Streams the CSV inside a zip line by line (`unzip -p`), so a 100MB listing-day file is never held in memory. */
function streamZipLines(zipPath, onLine) {
    return new Promise((resolve, reject) => {
        const child = spawn('unzip', ['-p', zipPath]);
        const rl = readline.createInterface({ input: child.stdout });
        let stopped = false;
        rl.on('line', line => {
            if (stopped) return;
            if (onLine(line) === false) { stopped = true; rl.close(); child.kill(); }
        });
        rl.on('close', resolve);
        child.on('error', reject);
    });
}

async function cachedJson(key, produce) {
    const file = path.join(CACHE_DIR, crypto.createHash('md5').update(key).digest('hex') + '.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = await produce();
    fs.writeFileSync(file, JSON.stringify(value));
    return value;
}

/** aggTrades [T, price] with from <= T <= to, from the daily dump(s); null when no file exists. */
async function trades(symbol, from, to) {
    return cachedJson(`vision-aggTrades:${symbol}:${from}:${to}`, async () => {
        const out = [];
        let anyFile = false;
        for (const day of [...new Set([utcDay(from), utcDay(to)])]) {
            const zip = await visionZip(`${VISION}/aggTrades/${symbol}/${symbol}-aggTrades-${day}.zip`);
            if (!zip) continue;
            anyFile = true;
            try {
                // agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
                await streamZipLines(zip, line => {
                    const cols = line.split(',');
                    const T = Number(cols[5]);
                    if (!Number.isFinite(T)) return true; // header
                    if (T > to) return false;            // rows are chronological: stop reading
                    if (T >= from) out.push([T, Number(cols[1])]);
                    return true;
                });
            } finally {
                fs.rmSync(zip, { force: true });
            }
        }
        return anyFile ? out : null;
    });
}

/**
 * 1s candles [t, o, h, l, c] of a perp built from its aggTrades dumps (last-trade price; seconds
 * without trades are absent), from <= t <= to. null when no dump exists. Futures have no 1s klines.
 */
async function secondCandles(symbol, from, to) {
    return cachedJson(`vision-1s:${symbol}:${from}:${to}`, async () => {
        const out = [];
        let anyFile = false;
        let cur = null;
        for (let day = Date.parse(utcDay(from)); day <= to; day += 86400000) {
            const zip = await visionZip(`${VISION}/aggTrades/${symbol}/${symbol}-aggTrades-${utcDay(day)}.zip`);
            if (!zip) continue;
            anyFile = true;
            try {
                // agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
                await streamZipLines(zip, line => {
                    const cols = line.split(',');
                    const T = Number(cols[5]);
                    if (!Number.isFinite(T)) return true; // header
                    if (T > to) return false;
                    if (T < from) return true;
                    const p = Number(cols[1]);
                    const s = T - (T % 1000);
                    if (!cur || cur[0] !== s) {
                        cur = [s, p, p, p, p];
                        out.push(cur);
                    } else {
                        if (p > cur[2]) cur[2] = p;
                        if (p < cur[3]) cur[3] = p;
                        cur[4] = p;
                    }
                    return true;
                });
            } finally {
                fs.rmSync(zip, { force: true });
            }
        }
        return anyFile ? out : null;
    });
}

/** Daily 1m klines of a (possibly removed) perp from the dump; [] when no file. */
async function visionKlines(symbol, day) {
    return cachedJson(`vision-klines:${symbol}:${day}`, async () => {
        const zip = await visionZip(`${VISION}/klines/${symbol}/1m/${symbol}-1m-${day}.zip`);
        if (!zip) return [];
        const out = [];
        try {
            await streamZipLines(zip, line => {
                const k = line.split(',');
                if (Number.isFinite(Number(k[0])) && k[0] !== '') out.push([Number(k[0]), +k[1], +k[2], +k[3], +k[4]]);
                return true;
            });
        } finally {
            fs.rmSync(zip, { force: true });
        }
        return out;
    });
}

/**
 * 1m klines [t, o, h, l, c] from `startTime` (~25h), null when the symbol never had a perp.
 * fapi first; removed perps (Invalid symbol) fall back to the daily dumps.
 */
async function klines(symbol, startTime) {
    const data = await fapi(`/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=1500`);
    if (data) return { source: 'fapi', c: data.map(k => [k[0], +k[1], +k[2], +k[3], +k[4]]) };
    const days = [0, 1, 2].map(d => utcDay(startTime + d * 86400000));
    const c = [];
    for (const day of days) c.push(...await visionKlines(symbol, day));
    const from = c.filter(k => k[0] >= startTime).slice(0, 1500);
    return from.length ? { source: 'vision (perp removed later)', c: from } : null;
}

// ==================== events ====================

function loadEvents() {
    const { upbit, binance, from, to } = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
    const events = [];
    if (EXCHANGE === 'binance' || EXCHANGE === 'all') {
        for (const n of binance) {
            const side = BINANCE_STRATEGIES[n.type];
            if (!side) continue;
            for (const token of n.tokens.filter(t => !MAJORS.has(t))) {
                events.push({ strategy: `BINANCE_${n.type}`, side, token, releaseMs: n.releaseMs, title: n.title, url: n.url, markets: '', cancelled: false });
            }
        }
    }
    for (const n of (EXCHANGE === 'binance' ? [] : upbit)) {
        const side = STRATEGIES[n.type];
        if (!side) continue;
        const krw = (n.markets || []).includes('KRW');
        const strategy = n.type === 'LISTING' ? (krw ? 'LISTING_KRW' : 'LISTING_BTC_USDT') : n.type;
        for (const token of n.tokens) {
            events.push({
                strategy, side, token, releaseMs: n.releaseMs, title: n.title, url: n.url,
                markets: (n.markets || []).join('/'),
                cancelled: (n.cancelledTokens || []).includes(token)
            });
        }
    }
    // Same token + strategy announced twice within 1h (re-posts) -> keep the first.
    events.sort((a, b) => a.releaseMs - b.releaseMs);
    const seen = new Map();
    return {
        from, to, events: events.filter(e => {
            const key = `${e.strategy}:${e.token}`;
            if (seen.has(key) && e.releaseMs - seen.get(key) < 3600000) return false;
            seen.set(key, e.releaseMs);
            return true;
        })
    };
}

// ==================== per event ====================

/** Binance lists low-priced tokens as 1000X / 1000000X perps (BONK -> 1000BONKUSDT). */
async function resolvePerp(token, minute) {
    for (const prefix of ['', '1000', '1000000']) {
        const symbol = `${prefix}${token}USDT`;
        const k = await klines(symbol, minute - 5 * MIN);
        // mult converts a spot price into the perp's units (1000BONKUSDT = 1000 x BONKUSDT).
        if (k && k.c.length) return { symbol, c: k.c, klineSource: k.source, mult: Number(prefix || 1) };
    }
    return null;
}

/**
 * Entry from Binance SPOT 1s klines (history kept, unlike fapi aggTrades): pre = last close
 * before publication, entry = open of the second at publication + latency, then the 1s path
 * to the end of that minute. Prices converted to perp units. null when there is no spot pair.
 */
async function spotEntry(token, mult, releaseMs, entryTs, entryMinuteEnd) {
    const data = await binanceGet(SPOT, `/klines?symbol=${token}USDT&interval=1s&startTime=${releaseMs - 30000}&limit=1000`);
    if (!data || !data.length) return null;
    const s = data.map(k => [k[0], k[1] * mult, k[2] * mult, k[3] * mult, k[4] * mult, +k[5]]);
    const before = s.filter(k => k[0] < releaseMs);
    const traded = before.filter(k => k[5] > 0);
    const after = s.filter(k => k[0] >= entryTs && k[0] < entryMinuteEnd);
    if (!before.length || !after.length || after[0][0] - entryTs > 2000) return null;
    return {
        pre: (traded.length ? traded[traded.length - 1] : before[before.length - 1])[4],
        entryAt: after[0][0],
        entry: after[0][1],
        partial: [after[0][0], after[0][1], Math.max(...after.map(k => k[2])), Math.min(...after.map(k => k[3])), after[after.length - 1][4]]
    };
}

/** Fallback for perps without a spot pair: futures aggTrades from the daily dump. */
async function futuresEntry(symbol, releaseMs, entryTs, entryMinuteEnd) {
    const window = await trades(symbol, releaseMs - 30000, entryMinuteEnd - 1);
    if (!window) return null;
    const before = window.filter(t => t[0] < releaseMs);
    const after = window.filter(t => t[0] >= entryTs);
    if (!before.length || !after.length) return null;
    return {
        pre: before[before.length - 1][1],
        entryAt: after[0][0],
        entry: after[0][1],
        partial: [after[0][0], after[0][1], Math.max(...after.map(t => t[1])), Math.min(...after.map(t => t[1])), after[after.length - 1][1]]
    };
}

/** `latencyMs` overrides --latency for this event (e.g. a random lag per trade). */
async function analyse(ev, latencyMs = LATENCY_MS) {
    const entryTs = ev.releaseMs + latencyMs;
    if (entryTs + HORIZON_MIN * MIN > Date.now()) return { skip: 'less than 24h of data yet' };
    const minute = Math.floor(ev.releaseMs / MIN) * MIN;

    const perp = await resolvePerp(ev.token, minute);
    if (!perp) return { skip: 'no Binance USDT-M perp' };
    const { symbol, c, klineSource, mult } = perp;
    if (c[0][0] > minute) return { skip: `perp launched after the notice (${fmtTz(c[0][0], 9)} KST)` };
    // Settled/delisted contract: flat candles without trades would fake 0% results.
    if (c.slice(5, 65).filter(k => k[2] === k[3]).length > 45) return { skip: 'perp not trading (flat candles)' };

    const entryMinuteEnd = Math.floor(entryTs / MIN) * MIN + MIN;
    // Futures close of the minute before publication: basis reference for the spot price.
    const futPreClose = c.filter(k => k[0] + MIN <= ev.releaseMs).pop()?.[4];
    let entrySource = 'spot 1s';
    let e = await spotEntry(ev.token, mult, ev.releaseMs, entryTs, entryMinuteEnd);
    const basisPre = e && futPreClose ? pct(futPreClose, e.pre) : NaN;
    // A spot pair far from the perp (different asset behind the same ticker) is not a proxy for it.
    if (e && Math.abs(basisPre) > 5) e = null;
    if (!e) {
        entrySource = 'futures aggTrades';
        e = await futuresEntry(symbol, ev.releaseMs, entryTs, entryMinuteEnd);
    }
    if (!e) return { skip: 'no spot pair and no futures trades around entry' };
    const { pre, entryAt, entry, partial } = e;

    // Price path from entry: rest of the entry minute (1s spot / trades) + the following perp 1m candles.
    const path = [partial, ...c.filter(k => k[0] >= entryMinuteEnd && k[0] < entryTs + HORIZON_MIN * MIN)];
    if (path.length < HORIZON_MIN * 0.9) return { skip: `only ${path.length} minutes of data after entry` };

    const dir = ev.side === 'LONG' ? 1 : -1;
    const ret = price => dir * pct(entry, price);
    const at = minutes => { const target = entryTs + minutes * MIN; const k = [...path].reverse().find(x => x[0] <= target); return k ? ret(k[4]) : NaN; };
    const excursion = minutes => {
        const span = path.filter(k => k[0] < entryTs + minutes * MIN);
        const favourable = span.map(k => ret(dir === 1 ? k[2] : k[3]));
        const adverse = span.map(k => ret(dir === 1 ? k[3] : k[2]));
        const best = Math.max(...favourable);
        return { mfe: best, mae: Math.min(...adverse), peakMin: (span[favourable.indexOf(best)][0] - entryTs) / MIN };
    };
    const e1 = excursion(60), e4 = excursion(240);

    return {
        symbol, pre, entry, entryAt, path,
        // How much of the move already happened during the latency (in the trade's direction).
        moveBeforeEntry: pre ? dir * pct(pre, entry) : NaN,
        returns: Object.fromEntries(HORIZONS.map(h => [h, at(h)])),
        mfe1h: e1.mfe, mae1h: e1.mae, mfe4h: e4.mfe, mae4h: e4.mae, peakMin4h: e4.peakMin,
        entrySource, klineSource, basisPre
    };
}

// ==================== simulation ====================

/** Net % of price. Within one candle the stop is assumed hit before the target (pessimistic). */
function sim(t, sl, tp, hold) {
    const dir = t.side === 'LONG' ? 1 : -1;
    const span = t.path.filter(k => k[0] < t.entryAt + hold * MIN);
    for (const k of span) {
        const worst = dir * pct(t.entry, dir === 1 ? k[3] : k[2]);
        const best = dir * pct(t.entry, dir === 1 ? k[2] : k[3]);
        if (sl > 0 && worst <= -sl) return -sl - COST_PCT;
        if (tp > 0 && best >= tp) return tp - COST_PCT;
    }
    return dir * pct(t.entry, span[span.length - 1][4]) - COST_PCT;
}

function evaluate(trades, sl, tp, hold) {
    const v = trades.map(t => sim(t, sl, tp, hold));
    return { sl, tp, hold, n: v.length, mean: mean(v), median: median(v), win: v.filter(x => x > 0).length / v.length * 100, total: v.reduce((a, b) => a + b, 0), worst: Math.min(...v) };
}

function gridReport(trades) {
    if (trades.length < MIN_TRADES_FOR_GRID) return null;
    const rows = [];
    for (const sl of SL_GRID) for (const tp of TP_GRID) for (const hold of HOLD_GRID) rows.push(evaluate(trades, sl, tp, hold));
    const best = [...rows].sort((a, b) => b.mean - a.mean)[0];
    // Robust: must work in both chronological halves (guards against one lucky period).
    const half = Math.floor(trades.length / 2);
    const [a, b] = [trades.slice(0, half), trades.slice(half)];
    let robust = null;
    for (const r of rows) {
        const ra = evaluate(a, r.sl, r.tp, r.hold).mean, rb = evaluate(b, r.sl, r.tp, r.hold).mean;
        if (!robust || Math.min(ra, rb) > robust.score) robust = { ...r, score: Math.min(ra, rb), half1: ra, half2: rb };
    }
    return { best, robust, top: [...rows].sort((x, y) => y.mean - x.mean).slice(0, 5) };
}

const label = r => `SL ${r.sl || '-'}% / TP ${r.tp || '-'}% / hold ${r.hold}m`;

// ==================== report ====================

function writeCsv(file, rows) {
    const cols = ['strategy', 'side', 'published_kst', 'published_gmt7', 'token', 'symbol', 'markets', 'cancelled',
        'entry_source', 'kline_source', 'basis_spot_vs_perp_pre_%', 'pre_price', 'entry_price', 'entry_delay_s', 'move_before_entry_%',
        ...HORIZONS.map(h => `ret_${h}m_%`), 'mfe_1h_%', 'mae_1h_%', 'mfe_4h_%', 'mae_4h_%', 'peak_min_4h', 'skip_reason', 'title', 'url'];
    const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = rows.map(({ ev, r }) => [
        ev.strategy, ev.side, fmtTz(ev.releaseMs, 9), fmtTz(ev.releaseMs, 7), ev.token, r.symbol || '', ev.markets, ev.cancelled ? 'yes' : '',
        r.entrySource || '', r.klineSource || '', f(r.basisPre), r.pre ?? '', r.entry ?? '', r.entryAt ? f((r.entryAt - ev.releaseMs) / 1000, 1) : '', f(r.moveBeforeEntry),
        ...HORIZONS.map(h => f(r.returns?.[h])), f(r.mfe1h), f(r.mae1h), f(r.mfe4h), f(r.mae4h), f(r.peakMin4h, 0),
        r.skip || '', ev.title, ev.url
    ].map(cell).join(','));
    fs.writeFileSync(file, '﻿' + [cols.join(','), ...lines].join('\n') + '\n');
}

function markdown(byStrategy, skipped, meta) {
    const lines = [`# Upbit alert backtest — Binance USDT-M perps, entry ${LATENCY_MS / 1000}s after publication`, '',
        `Notices ${meta.from} → ${meta.to}. Cost ${COST_PCT}% round trip in the grid (horizon returns are gross).`,
        'Returns are in the trade direction (+ = profit), % of price, no leverage. ROI on margin = % × leverage.', '',
        '## Returns by horizon (mean / median / % positive)', '',
        `| Strategy | Side | n | Move during ${LATENCY_MS / 1000}s | ${HORIZONS.map(h => h >= 60 ? `${h / 60}h` : `${h}m`).join(' | ')} | MFE 1h | MAE 1h |`,
        `|---|---|---:|---:|${HORIZONS.map(() => '---').join('|')}|---:|---:|`];
    for (const [name, trades] of Object.entries(byStrategy)) {
        if (!trades.length) continue;
        const cellFor = h => { const v = trades.map(t => t.returns[h]).filter(Number.isFinite); return `${f(mean(v), 1)} / ${f(median(v), 1)} / ${f(v.filter(x => x > 0).length / v.length * 100, 0)}%`; };
        lines.push(`| ${name} | ${trades[0].side} | ${trades.length} | ${f(median(trades.map(t => t.moveBeforeEntry).filter(Number.isFinite)), 2)}% (median) | ${HORIZONS.map(cellFor).join(' | ')} | ${f(mean(trades.map(t => t.mfe1h)), 1)} | ${f(mean(trades.map(t => t.mae1h)), 1)} |`);
    }
    lines.push('', `## SL / TP / time-stop grid (net of ${COST_PCT}% cost)`, '',
        `Grid: SL ${SL_GRID.join('/')}% × TP ${TP_GRID.join('/')}% × hold ${HOLD_GRID.join('/')}m (0 = none). "Robust" = best worst-half mean.`, '',
        '| Strategy | n | Best (all data) | mean | win | Robust pick | mean | half1 / half2 | worst trade |', '|---|---:|---|---:|---:|---|---:|---|---:|');
    for (const [name, trades] of Object.entries(byStrategy)) {
        const g = gridReport(trades);
        if (!g) { lines.push(`| ${name} | ${trades.length} | too few trades | | | | | | |`); continue; }
        lines.push(`| ${name} | ${trades.length} | ${label(g.best)} | ${f(g.best.mean)}% | ${f(g.best.win, 0)}% | ${label(g.robust)} | ${f(g.robust.mean)}% | ${f(g.robust.half1)} / ${f(g.robust.half2)} | ${f(g.robust.worst, 1)}% |`);
    }
    for (const [name, trades] of Object.entries(byStrategy)) {
        if (!trades.length) continue;
        lines.push('', `## ${name} trades`, '', `| Published (KST) | Symbol | Move ${LATENCY_MS / 1000}s | 5m | 1h | 4h | MFE 4h (min) | MAE 4h | Title |`, '|---|---|---:|---:|---:|---:|---|---:|---|');
        for (const t of [...trades].sort((a, b) => b.releaseMs - a.releaseMs)) {
            lines.push(`| ${fmtTz(t.releaseMs, 9)} | ${t.symbol}${t.cancelled ? ' (cancelled)' : ''} | ${f(t.moveBeforeEntry)} | ${f(t.returns[5])} | ${f(t.returns[60])} | ${f(t.returns[240])} | ${f(t.mfe4h, 1)} (${f(t.peakMin4h, 0)}m) | ${f(t.mae4h, 1)} | [${t.title.replace(/\|/g, '/')}](${t.url}) |`);
        }
    }
    lines.push('', '## Skipped events', '', '| Published (KST) | Strategy | Token | Reason |', '|---|---|---|---|',
        ...skipped.map(({ ev, r }) => `| ${fmtTz(ev.releaseMs, 9)} | ${ev.strategy} | ${ev.token} | ${r.skip} |`));
    return lines.join('\n') + '\n';
}

async function main() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const { from, to, events } = loadEvents();
    console.log(`Input ${path.basename(INPUT)}: ${events.length} token events | latency ${LATENCY_MS / 1000}s | cost ${COST_PCT}%`);
    await buildPool();

    const results = [];
    let done = 0;
    const queue = [...events];
    await Promise.all(Array.from({ length: pool.size * 2 }, async () => {
        while (queue.length) {
            const ev = queue.shift();
            let r;
            try { r = await analyse(ev); } catch (error) { r = { skip: `error: ${error.message}` }; }
            results.push({ ev, r });
            if (++done % 25 === 0 || done === events.length) console.log(`  ${done}/${events.length}`);
        }
    }));
    results.sort((a, b) => a.ev.releaseMs - b.ev.releaseMs);

    const traded = results.filter(x => !x.r.skip);
    const skipped = results.filter(x => x.r.skip);
    const byStrategy = {};
    for (const name of [...new Set(traded.map(x => x.ev.strategy))]) {
        byStrategy[name] = traded.filter(x => x.ev.strategy === name).map(({ ev, r }) => ({ ...ev, ...r }));
    }

    const base = `backtest-${EXCHANGE}-${from}_${to}-lat${LATENCY_MS / 1000}s`;
    writeCsv(path.join(REPORT_DIR, `${base}.csv`), results);
    fs.writeFileSync(path.join(REPORT_DIR, `${base}.md`), markdown(byStrategy, skipped, { from, to }));

    console.log(`\n✅ traded ${traded.length} | skipped ${skipped.length}`);
    for (const [name, trades] of Object.entries(byStrategy)) {
        if (!trades.length) continue;
        const g = gridReport(trades);
        console.log(`${name.padEnd(17)} n=${String(trades.length).padStart(3)} | move during latency ${f(median(trades.map(t => t.moveBeforeEntry).filter(Number.isFinite)))}% | 1h mean ${f(mean(trades.map(t => t.returns[60])))}% | ${g ? `robust ${label(g.robust)} → ${f(g.robust.mean)}% net, win ${f(g.robust.win, 0)}%` : 'too few trades'}`);
    }
    console.log(`Output: ${REPORT_DIR}/${base}.{csv,md}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error('❌', error.stack || error.message);
        process.exit(1);
    });
}

// Reused by the per-strategy studies (same data sources and cache).
module.exports = {
    buildPool, loadEvents, analyse, resolvePerp, klines, binanceGet, trades, secondCandles, sim, mean, median, pct, fmtTz,
    SPOT, MIN, CACHE_DIR, REPORT_DIR, INPUT, COST_PCT, EXCHANGE,
    poolSize: () => pool.size
};
