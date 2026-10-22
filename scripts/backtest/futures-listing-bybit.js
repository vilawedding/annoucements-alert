// Binance FUTURES listing ("Binance Futures Will Launch USDⓈ-M X Perpetual") measured on the BYBIT perp
// (public.bybit.com trade dumps, 0.1ms timestamps). Anchor = onset (first trade >= +2% vs last pre-publish
// trade within publish-1s..+5s), else publish. Moves at push + D, peak, then a LONG/SHORT grid on 1s candles.
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');
const REPO = require('path').join(__dirname, '..', '..');
const CACHE = path.join(REPO, 'data', 'backtest-cache', 'bybit');
fs.mkdirSync(CACHE, { recursive: true });
const OUT = REPO + '/data/reports/futures-listing-bybit.json';
const MIN = 60000, COST = 0.2, MARGIN = 10, MMR = 1;
const HOLD_MAX = 240;
const DELAYS = [0.25, 1, 6, 30, 60, 300];
const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'U', 'BUSD']);
const pct = (a, b) => (b / a - 1) * 100;
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
const fmt7 = ms => new Date(ms + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

function tokensOf(n) {
    if (n.tokens && n.tokens.length) return n.tokens;
    const m = n.title.match(/USDⓈ-M\s+(.+?)\s+Perpetual/i) || n.title.match(/Launch\s+(.+?)\s+(?:USDⓈ-M\s+)?Perpetual/i);
    if (!m) return [];
    return m[1].replace(/USDⓈ-Margined|USDⓈ-M|Multiple/gi, '').split(/\s*(?:,|&|\band\b)\s*/i)
        .map(s => s.trim().replace(/USDT$|USDC$/, '')).filter(s => /^[A-Z0-9]{2,15}$/.test(s));
}

function get(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
            if (res.statusCode === 404) { res.resume(); return resolve(null); }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode} ${url}`)); }
            resolve(res);
        }).on('error', reject);
    });
}

/** [[ms, price]] of the Bybit linear perp between from..to (cached per window). null = no dump. */
async function bybitTrades(symbol, from, to) {
    const file = path.join(CACHE, `${symbol}-${from}-${to}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = [];
    let any = false;
    for (let day = Date.parse(utcDay(from)); day <= to; day += 86400000) {
        const res = await get(`https://public.bybit.com/trading/${symbol}/${symbol}${utcDay(day)}.csv.gz`);
        if (!res) continue;
        any = true;
        const rl = readline.createInterface({ input: res.pipe(zlib.createGunzip()) });
        for await (const line of rl) {
            const c = line.split(',');
            const t = Math.round(Number(c[0]) * 1000);
            if (!Number.isFinite(t) || t < from || t > to) continue;
            out.push([t, Number(c[4])]);
        }
    }
    const v = any ? out.sort((a, b) => a[0] - b[0]) : null;
    fs.writeFileSync(file, JSON.stringify(v));
    return v;
}

function seconds(tape, from) {
    const out = []; let cur = null;
    for (const [t, p] of tape) {
        if (t < from) continue;
        const s = t - (t % 1000);
        if (!cur || cur[0] !== s) { cur = [s, p, p, p, p]; out.push(cur); }
        else { if (p > cur[2]) cur[2] = p; if (p < cur[3]) cur[3] = p; cur[4] = p; }
    }
    return out;
}

function sim(sec, entryAt, entry, dir, lev, sl, tp, hold, be) {
    const liq = 100 / lev - MMR;
    let stop = sl ? -sl : -Infinity, armed = false, last = null;
    const end = entryAt + hold * MIN;
    for (const k of sec) {
        if (k[0] < entryAt - (entryAt % 1000)) continue;
        if (k[0] >= end) break;
        last = k;
        const r = dir * pct(entry, k[4]);
        if (r <= -liq && !(stop > -liq)) return { pnl: -100 / lev, exit: 'LIQ' };
        if (r <= stop) return { pnl: r, exit: armed ? 'BE' : 'SL' };
        if (tp && r >= tp) return { pnl: r, exit: 'TP' };
        if (be && !armed && r >= 5) { armed = true; stop = Math.max(stop, 0); }
    }
    return last ? { pnl: dir * pct(entry, last[4]), exit: 'time' } : null;
}

(async () => {
    const { binance } = JSON.parse(fs.readFileSync(`${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`, 'utf8'));
    const notices = binance.filter(n => n.type === 'FUTURES_LISTING' && !/COIN-M|BUSD-Margined|Delivery|Quarterly|USDC-M/i.test(n.title));
    const rows = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
    const done = new Set(rows.map(r => `${r.token}:${r.pub}`));
    const jobs = [];
    for (const n of notices) for (const token of tokensOf(n).filter(t => !MAJORS.has(t))) if (!done.has(`${token}:${n.releaseMs}`)) jobs.push({ n, token });
    console.log(`${notices.length} notices, ${jobs.length} token jobs to fetch (${rows.length} cached rows)`);
    let next = 0, cnt = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const { n, token } = jobs[next++];
            const pub = n.releaseMs;
            const row = { token, pub, date: fmt7(pub), title: n.title.slice(0, 90) };
            try {
                const symbol = `${token}USDT`;
                const tape = await bybitTrades(symbol, pub - 30000, pub + (HOLD_MAX + 5) * MIN);
                const before = tape && tape.filter(t => t[0] < pub);
                if (!tape || !before.length || before[before.length - 1][0] < pub - 600000) row.skip = 'no bybit perp before';
                else {
                    row.symbol = symbol;
                    row.pre = before[before.length - 1][1];
                    const onset = tape.find(t => t[0] >= pub - 1000 && t[0] <= pub + 5000 && t[1] >= row.pre * 1.02);
                    row.onsetMs = onset ? onset[0] - pub : null;
                    row.push = onset ? onset[0] : pub;
                    row.at = {};
                    for (const d of DELAYS) { const t = tape.find(x => x[0] >= row.push + d * 1000); if (t) row.at[d] = t; }
                    const w = tape.filter(t => t[0] >= row.push && t[0] <= row.push + 300000);
                    const pk = w.reduce((m, t) => (t[1] > m[1] ? t : m), w[0] || [row.push, row.pre]);
                    row.peakPct = pct(row.pre, pk[1]); row.peakMs = pk[0] - row.push;
                    row.sec = seconds(tape, row.push - 1000);
                }
            } catch (e) { row.skip = e.message; }
            rows.push(row);
            if (++cnt % 25 === 0) { fs.writeFileSync(OUT, JSON.stringify(rows)); console.log(`  ${cnt}/${jobs.length}`); }
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    fs.writeFileSync(OUT, JSON.stringify(rows));

    const ok = rows.filter(r => !r.skip && r.at);
    console.log(`\n# FUTURES_LISTING on Bybit perp: ${ok.length} usable / ${rows.length} (skips: ${JSON.stringify(rows.filter(r => r.skip).reduce((m, r) => (m[r.skip.slice(0, 30)] = (m[r.skip.slice(0, 30)] || 0) + 1, m), {}))})`);
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const on = ok.map(r => r.onsetMs).filter(x => x !== null);
    console.log(`onset >= +2% in ${on.length}/${ok.length}, median ${med(on)}ms after publish; peak 5m median ${med(ok.map(r => r.peakPct)).toFixed(1)}% at ${(med(ok.map(r => r.peakMs)) / 1000).toFixed(1)}s`);
    for (const y of ['all', '2023', '2024', '2025', '2026']) {
        const s = ok.filter(r => y === 'all' || r.date.startsWith(y));
        if (!s.length) continue;
        console.log(`  ${y} n=${s.length}: ` + DELAYS.map(d => { const xs = s.filter(r => r.at[d]).map(r => pct(r.pre, r.at[d][1])); return `+${d}s ${med(xs).toFixed(1)}%`; }).join(' | ') + ` | peak ${med(s.map(r => r.peakPct)).toFixed(1)}%`);
    }
    const run = (dir, d, lev, sl, tp, hold, be, filt = () => true) => {
        const xs = [];
        for (const r of ok.filter(filt)) {
            const e = r.at[d]; if (!e) continue;
            const s = sim(r.sec, e[0], e[1], dir, lev, sl, tp, hold, be); if (!s) continue;
            xs.push({ usdt: MARGIN * lev * (s.pnl - COST) / 100, exit: s.exit, year: r.date.slice(0, 4) });
        }
        let eq = 0, peak = 0, dd = 0; for (const x of xs) { eq += x.usdt; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
        return { xs, tot: eq, dd, med: med(xs.map(x => x.usdt)), win: xs.filter(x => x.usdt > 0).length, n: xs.length, liq: xs.filter(x => x.exit === 'LIQ').length };
    };
    const f = r => `${r.tot.toFixed(0).padStart(5)}u med ${r.med.toFixed(1).padStart(5)}u win ${r.win}/${r.n} LIQ ${r.liq} DD ${r.dd.toFixed(0)}u`;
    const grid = [];
    for (const d of [0.25, 1, 6]) for (const sl of [2, 3, 5]) for (const tp of [0, 5, 10, 20]) for (const hold of [5, 15, 60, 240]) for (const be of [false, true])
        grid.push({ k: `LONG +${d}s x10 SL ${sl} TP ${tp || '-'} hold ${hold}m${be ? ' BE5' : ''}`, a: [1, d, 10, sl, tp, hold, be] });
    for (const d of [30, 60, 300]) for (const sl of [3, 5, 8]) for (const tp of [0, 5, 10]) for (const hold of [60, 240])
        grid.push({ k: `SHORT +${d}s x10 SL ${sl} TP ${tp || '-'} hold ${hold}m`, a: [-1, d, 10, sl, tp, hold, false] });
    for (const g of grid) g.r = run(...g.a);
    for (const side of ['LONG', 'SHORT']) {
        console.log(`\ntop ${side} (x10, margin 10u) by total/DD:`);
        const best = grid.filter(g => g.k.startsWith(side)).sort((a, b) => b.r.tot / Math.max(b.r.dd, 1) - a.r.tot / Math.max(a.r.dd, 1)).slice(0, 6);
        best.forEach(g => console.log(`  ${g.k.padEnd(40)} ${f(g.r)}`));
        const g = best[0];
        const years = {}; for (const x of g.r.xs) (years[x.year] ||= []).push(x.usdt);
        console.log(`  per year (${g.k}): ` + Object.entries(years).map(([y, a]) => `${y} n=${a.length} ${a.reduce((s, v) => s + v, 0).toFixed(0)}u win ${a.filter(v => v > 0).length}`).join(' | '));
    }
})().catch(e => { console.error(e); process.exit(1); });
