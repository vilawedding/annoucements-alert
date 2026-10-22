// Binance SPOT listing LONG on the perp, 1s candles (from aggTrades) for the whole hold.
// Events/anchors from listing-study.json (push = onset, else publish). Margin 10u, LIQ at 100/lev - MMR,
// stop on the 1s close (mark-price proxy) or --wick (any trade in the second, filled at the level).
const REPO = require('path').join(__dirname, '..', '..');
process.argv.push('--exchange', 'binance', '--input', `${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`);
const fs = require('fs');
const bt = require(`${REPO}/scripts/backtest/upbit-alert-backtest`);
const MARGIN = 10, MMR = 1, COST = 0.2, MIN = 60000;
const DELAYS = [0.25, 1, 6];
const LEVS = [5, 10, 15, 20];
const SLS = [3, 5, 8];
const TPS = [0, 10, 20];
const HOLDS = [15, 60, 240];
const pct = (a, b) => (b / a - 1) * 100;

function sim(sec, entryAt, entry, lev, sl, tp, hold, be, wick) {
    const liq = 100 / lev - MMR;
    let stop = -sl, armed = false, last = null;
    const end = entryAt + hold * MIN;
    for (const k of sec) {
        if (k[0] < entryAt - (entryAt % 1000)) continue;
        if (k[0] >= end) break;
        const first = !last; last = k;
        const r = pct(entry, k[4]);
        const lo = wick && !first ? pct(entry, k[3]) : r;
        const hi = wick && !first ? pct(entry, k[2]) : r;
        if (lo <= -liq && !(stop > -liq)) return { pnl: -100 / lev, exit: 'LIQ' };
        if (lo <= stop) return { pnl: wick ? stop : r, exit: armed ? 'BE' : 'SL' };
        if (tp && hi >= tp) return { pnl: wick ? tp : r, exit: 'TP' };
        if (be && !armed && r >= 5) { armed = true; stop = Math.max(stop, 0); }
    }
    return { pnl: pct(entry, last[4]), exit: 'time' };
}

(async () => {
    const rows = JSON.parse(fs.readFileSync(REPO + '/data/reports/listing-study.json', 'utf8')).filter(r => r.type === 'SPOT_LISTING' && !r.skip);
    await bt.buildPool();
    const ev = [];
    for (const r of rows) {
        const push = r.pub + (r.onsetMs || 0);
        const tape = await bt.trades(r.symbol, r.pub - 5000, r.pub + 330000);
        const sec = await bt.secondCandles(r.symbol, push - 30000, push + (240 + 5) * MIN);
        if (!tape || !sec || !sec.length) { console.log(`skip ${r.symbol}`); continue; }
        const entries = {};
        for (const d of DELAYS) { const t = tape.find(x => x[0] >= push + d * 1000); if (t) entries[d] = t; }
        ev.push({ sym: r.symbol, year: r.date.slice(0, 4), sec, entries });
    }
    console.log(`${ev.length} events with 1s data`);
    const run = (d, lev, sl, tp, hold, be, wick) => {
        const xs = [];
        for (const e of ev) {
            const t = e.entries[d]; if (!t) continue;
            const s = sim(e.sec, t[0], t[1], lev, sl, tp, hold, be, wick);
            xs.push({ usdt: MARGIN * lev * (s.pnl - COST) / 100, exit: s.exit, year: e.year, sym: e.sym, pnl: s.pnl });
        }
        let eq = 0, peak = 0, dd = 0;
        for (const x of xs) { eq += x.usdt; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
        const s = xs.map(x => x.usdt).sort((a, b) => a - b);
        return { xs, tot: eq, dd, med: s[Math.floor(s.length / 2)], win: xs.filter(x => x.usdt > 0).length, n: xs.length, liq: xs.filter(x => x.exit === 'LIQ').length };
    };
    const f = r => `${r.tot.toFixed(0).padStart(5)}u med ${r.med.toFixed(1).padStart(5)}u win ${r.win}/${r.n} LIQ ${r.liq} DD ${r.dd.toFixed(0)}u`;
    const grid = [];
    for (const wick of [false, true]) for (const d of DELAYS) for (const lev of LEVS) for (const sl of SLS) for (const tp of TPS) for (const hold of HOLDS) for (const be of [false, true]) {
        grid.push({ k: { wick, d, lev, sl, tp, hold, be }, r: run(d, lev, sl, tp, hold, be, wick) });
    }
    const label = k => `+${k.d}s x${k.lev} SL ${k.sl} TP ${k.tp || '-'} hold ${k.hold}m${k.be ? ' BE5' : ''}`;
    for (const wick of [false, true]) {
        console.log(`\n=== stop on ${wick ? 'WICK (pessimistic)' : '1s CLOSE'} ===`);
        const live = grid.find(g => g.k.wick === wick && g.k.d === 0.25 && g.k.lev === 10 && g.k.sl === 5 && !g.k.tp && g.k.hold === 60 && !g.k.be);
        console.log(`live profile  ${label(live.k).padEnd(36)} ${f(live.r)}`);
        for (const d of DELAYS) {
            const g = grid.find(x => x.k.wick === wick && x.k.d === d && x.k.lev === 10 && x.k.sl === 5 && !x.k.tp && x.k.hold === 60 && !x.k.be);
            console.log(`  delay        ${label(g.k).padEnd(36)} ${f(g.r)}`);
        }
        console.log('top 8 by total/DD (x10 only, n>=30):');
        grid.filter(g => g.k.wick === wick && g.k.lev === 10).sort((a, b) => b.r.tot / Math.max(b.r.dd, 1) - a.r.tot / Math.max(a.r.dd, 1)).slice(0, 8)
            .forEach(g => console.log(`  ${label(g.k).padEnd(36)} ${f(g.r)}`));
        console.log('by leverage (best SL/TP/hold per lev, +0.25s):');
        for (const lev of LEVS) {
            const g = grid.filter(x => x.k.wick === wick && x.k.lev === lev && x.k.d === 0.25).sort((a, b) => b.r.tot - a.r.tot)[0];
            console.log(`  ${label(g.k).padEnd(36)} ${f(g.r)}`);
        }
    }
    // per year + trade list for the live profile on the close
    const live = run(0.25, 10, 5, 0, 60, false, false);
    const years = {};
    for (const x of live.xs) (years[x.year] ||= []).push(x.usdt);
    console.log('\nlive profile per year (close): ' + Object.entries(years).map(([y, a]) => `${y} n=${a.length} ${a.reduce((s, v) => s + v, 0).toFixed(0)}u win ${a.filter(v => v > 0).length}`).join(' | '));
    console.log('trades: ' + live.xs.map(x => `${x.sym.replace('USDT', '')} ${x.pnl.toFixed(1)}%${x.exit[0]}`).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
