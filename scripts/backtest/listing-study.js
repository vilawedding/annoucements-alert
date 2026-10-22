// Binance SPOT listing (perp tape) and FUTURES listing (spot tape) around the push, ms resolution.
// Anchor = onset (first trade >= +2% vs the last pre-publish trade within publish-1s..+5s), else publish.
// Then LONG-at-once vs SHORT-after-the-pump grids on 1m candles (price %, no leverage, cost 0.2%).
const REPO = require('path').join(__dirname, '..', '..');
process.argv.push('--exchange', 'binance', '--input', `${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`);
const fs = require('fs');
const bt = require(`${REPO}/scripts/backtest/upbit-alert-backtest`);
const OUT = REPO + '/data/reports/listing-study.json';
const TYPE = process.argv.find(a => /^--type=/.test(a))?.slice(7) || 'all';
const COST = 0.2;
const MIN = 60000;
const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'U', 'BUSD']);
const pct = (a, b) => (b / a - 1) * 100;
const DELAYS = [0.25, 1, 6, 30, 60, 300];

async function spotTape(symbol, from, to) {
    const out = [];
    let start = from;
    for (let i = 0; i < 15 && start < to; i++) {
        const d = await bt.binanceGet(bt.SPOT, `/aggTrades?symbol=${symbol}&startTime=${start}&endTime=${Math.min(to, start + 3600000)}&limit=1000`);
        if (!d || !d.length) break;
        for (const t of d) out.push([t.T, +t.p]);
        if (d.length < 1000) break;
        start = d[d.length - 1].T + 1;
    }
    return out;
}
async function spotKlines(symbol, startTime) {
    const d = await bt.binanceGet(bt.SPOT, `/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=1000`);
    return d && d.length ? d.map(k => [k[0], +k[1], +k[2], +k[3], +k[4]]) : null;
}

async function study(n, token) {
    const pub = n.releaseMs;
    const minute = Math.floor(pub / MIN) * MIN;
    let symbol, tape, path;
    if (n.type === 'FUTURES_LISTING') {
        symbol = `${token}USDT`;
        tape = await spotTape(symbol, pub - 5000, pub + 330000);
        if (!tape.length || !tape.some(t => t[0] < pub)) return { skip: 'no spot pair before' };
        path = await spotKlines(symbol, minute);
    } else {
        const perp = await bt.resolvePerp(token, minute).catch(() => null);
        if (!perp) return { skip: 'no perp' };
        symbol = perp.symbol;
        tape = await bt.trades(symbol, pub - 5000, pub + 330000);
        if (!tape || !tape.some(t => t[0] < pub)) return { skip: 'no perp tape' };
        path = (await bt.klines(symbol, minute))?.c;
    }
    if (!path || path.length < 30) return { skip: 'no path' };
    const pre = tape.filter(t => t[0] < pub).pop()[1];
    const onset = tape.find(t => t[0] >= pub - 1000 && t[0] <= pub + 5000 && t[1] >= pre * 1.02);
    const push = onset ? onset[0] : pub;
    const at = {};
    for (const d of DELAYS) { const t = tape.find(x => x[0] >= push + d * 1000); if (t) at[d] = t; }
    const win = tape.filter(t => t[0] >= push && t[0] <= push + 300000);
    const peak = win.reduce((m, t) => (t[1] > m[1] ? t : m), win[0] || [push, pre]);
    return { symbol, pre, onsetMs: onset ? onset[0] - pub : null, peakPct: pct(pre, peak[1]), peakMs: peak[0] - push, at, path };
}

/** dir 1 LONG / -1 SHORT from (t, price) on 1m candles; stop checked before target inside a candle. */
function sim(path, t, entry, dir, sl, tp, holdMin) {
    const span = path.filter(k => k[0] + MIN > t && k[0] < t + holdMin * MIN);
    if (!span.length) return null;
    for (const k of span.slice(1)) {
        const worst = dir * pct(entry, dir === 1 ? k[3] : k[2]);
        const best = dir * pct(entry, dir === 1 ? k[2] : k[3]);
        if (sl && worst <= -sl) return -sl - COST;
        if (tp && best >= tp) return tp - COST;
    }
    return dir * pct(entry, span[span.length - 1][4]) - COST;
}

function stats(xs) {
    const s = [...xs].sort((a, b) => a - b);
    let eq = 0, peak = 0, dd = 0;
    for (const x of xs) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    return { n: xs.length, sum: eq, mean: eq / xs.length, med: s[Math.floor(s.length / 2)], win: xs.filter(x => x > 0).length / xs.length * 100, worst: s[0], dd };
}
const fmt = s => `n=${s.n} sum ${s.sum.toFixed(0)}% mean ${s.mean.toFixed(2)}% med ${s.med.toFixed(2)}% win ${s.win.toFixed(0)}% worst ${s.worst.toFixed(1)}% DD ${s.dd.toFixed(0)}%`;

(async () => {
    const { binance } = JSON.parse(fs.readFileSync(`${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`, 'utf8'));
    const notices = binance.filter(n => ['SPOT_LISTING', 'SPOT_LISTING_SEED', 'FUTURES_LISTING'].includes(n.type))
        .filter(n => TYPE === 'all' || n.type === TYPE)
        .filter(n => n.type !== 'FUTURES_LISTING' || (!/COIN-M|BUSD-Margined|Delivery|Quarterly/i.test(n.title)));
    await bt.buildPool();
    const rows = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
    const done = new Set(rows.map(r => `${r.type}:${r.token}:${r.pub}`));
    let i = 0;
    for (const n of notices) {
        for (const token of (n.tokens || []).filter(t => !MAJORS.has(t))) {
            const key = `${n.type}:${token}:${n.releaseMs}`;
            if (done.has(key)) continue;
            const r = await study(n, token).catch(e => ({ skip: e.message }));
            rows.push({ type: n.type === 'FUTURES_LISTING' ? 'FUTURES_LISTING' : 'SPOT_LISTING', token, pub: n.releaseMs, date: bt.fmtTz(n.releaseMs, 7), ...r });
            if (++i % 20 === 0) { fs.writeFileSync(OUT, JSON.stringify(rows)); console.log(`  ${i} done`); }
        }
    }
    fs.writeFileSync(OUT, JSON.stringify(rows));

    for (const type of ['SPOT_LISTING', 'FUTURES_LISTING']) {
        const ok = rows.filter(r => r.type === type && !r.skip);
        const skipped = rows.filter(r => r.type === type && r.skip);
        console.log(`\n# ${type}: ${ok.length} usable, ${skipped.length} skipped (${[...new Set(skipped.map(r => r.skip))].join(', ')})`);
        if (!ok.length) continue;
        const on = ok.map(r => r.onsetMs).filter(x => x !== null).sort((a, b) => a - b);
        console.log(`onset >= +2% found ${on.length}/${ok.length}; ms after publish: median ${on[Math.floor(on.length / 2)]} | ${on.slice(0, 40).join(',')}`);
        const pk = ok.map(r => r.peakPct).sort((a, b) => a - b), pt = ok.map(r => r.peakMs / 1000).sort((a, b) => a - b);
        console.log(`peak within 5m vs pre: median ${pk[Math.floor(pk.length / 2)].toFixed(1)}% | peak time median ${pt[Math.floor(pt.length / 2)].toFixed(1)}s (p25 ${pt[Math.floor(pt.length / 4)].toFixed(1)}s, p75 ${pt[Math.floor(pt.length * 3 / 4)].toFixed(1)}s)`);
        console.log('price vs pre at push + D (median / mean):');
        for (const d of DELAYS) {
            const xs = ok.filter(r => r.at[d]).map(r => pct(r.pre, r.at[d][1])).sort((a, b) => a - b);
            if (xs.length) console.log(`  +${d}s: ${xs[Math.floor(xs.length / 2)].toFixed(2)}% / ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)}% (n=${xs.length})`);
        }
        const grid = [];
        for (const d of [0.25, 1, 6]) for (const sl of [2, 3, 5, 0]) for (const tp of [5, 10, 20, 0]) for (const h of [5, 60, 240]) {
            const xs = ok.filter(r => r.at[d]).map(r => sim(r.path, r.at[d][0], r.at[d][1], 1, sl, tp, h)).filter(x => x !== null);
            grid.push({ k: `LONG +${d}s SL ${sl || '-'} TP ${tp || '-'} hold ${h}m`, s: stats(xs) });
        }
        for (const d of [6, 30, 60, 300]) for (const sl of [3, 5, 8, 0]) for (const tp of [5, 10, 0]) for (const h of [60, 240, 1440]) {
            const xs = ok.filter(r => r.at[d]).map(r => sim(r.path, r.at[d][0], r.at[d][1], -1, sl, tp, h)).filter(x => x !== null);
            grid.push({ k: `SHORT +${d}s SL ${sl || '-'} TP ${tp || '-'} hold ${h}m`, s: stats(xs) });
        }
        const best = side => grid.filter(g => g.k.startsWith(side)).sort((a, b) => b.s.mean - a.s.mean);
        for (const side of ['LONG', 'SHORT']) {
            console.log(`top ${side} by mean:`);
            best(side).slice(0, 5).forEach(g => console.log(`  ${g.k.padEnd(36)} ${fmt(g.s)}`));
            const robust = best(side).filter(g => g.s.med > 0).sort((a, b) => b.s.med - a.s.med).slice(0, 3);
            console.log(`top ${side} by median (>0): ${robust.length ? '' : 'none'}`);
            robust.forEach(g => console.log(`  ${g.k.padEnd(36)} ${fmt(g.s)}`));
        }
        // per-year for the best SHORT and LONG by mean
        for (const side of ['LONG', 'SHORT']) {
            const g = best(side)[0];
            const [, dir, d, sl, tp, h] = g.k.match(/^(\w+) \+([\d.]+)s SL (\S+) TP (\S+) hold (\d+)m/);
            const byYear = {};
            for (const r of ok) {
                const e = r.at[d]; if (!e) continue;
                const x = sim(r.path, e[0], e[1], dir === 'LONG' ? 1 : -1, sl === '-' ? 0 : +sl, tp === '-' ? 0 : +tp, +h);
                if (x !== null) (byYear[r.date.slice(0, 4)] ||= []).push(x);
            }
            console.log(`${g.k} per year: ${Object.entries(byYear).map(([y, xs]) => `${y} ${fmt(stats(xs))}`).join(' || ')}`);
        }
    }
})().catch(e => { console.error(e); process.exit(1); });
