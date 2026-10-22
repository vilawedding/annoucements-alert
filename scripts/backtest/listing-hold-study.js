// "Hold through the dip" for Binance spot-listing LONGs: wider / no SL, longer hold, lower leverage.
// Entry = first perp trade at push + 0.25s (ms tape); path = 1m perp candles (1500 min). Stops and
// liquidation trigger on the 1m LOW (pessimistic), exit at the level; liquidation = whole margin.
// Margin 10u isolated, notional 10u x lev, cost 0.2%. Needs data/reports/listing-study.json.
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
process.argv.push('--exchange', 'binance', '--input', `${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`);
const bt = require('./upbit-alert-backtest');
const MIN = 60000, MARGIN = 10, MMR = 1, COST = 0.2;
const pct = (a, b) => (b / a - 1) * 100;

function sim(c, entryAt, entry, lev, sl, holdMin) {
    const liq = 100 / lev - MMR;
    const span = c.filter(k => k[0] >= entryAt && k[0] < entryAt + holdMin * MIN);
    for (const k of span) {
        const low = pct(entry, k[3]);
        if (low <= -liq && !(sl && sl < liq)) return { pnl: -100 / lev, exit: 'LIQ' };
        if (sl && low <= -sl) return { pnl: -sl, exit: 'SL' };
    }
    return { pnl: pct(entry, span[span.length - 1][4]), exit: 'time' };
}

/**
 * Averaging down: half the margin at entry, the other half once the price is `addAt`% below the first
 * fill (same leverage). SL / liquidation measured from the average price after the add.
 */
function simDca(c, entryAt, entry, lev, addAt, sl, holdMin) {
    let avg = entry, size = 0.5, added = false;
    const span = c.filter(k => k[0] >= entryAt && k[0] < entryAt + holdMin * MIN);
    for (const k of span) {
        if (!added && pct(entry, k[3]) <= -addAt) {
            const fill = entry * (1 - addAt / 100);
            avg = (entry + fill) / 2; size = 1; added = true;
        }
        const liq = 100 / lev - MMR;
        const low = pct(avg, k[3]);
        if (low <= -liq && !(sl && sl < liq)) return { pnl: -100 / lev * size, exit: 'LIQ', added };
        if (sl && low <= -sl) return { pnl: -sl * size, exit: 'SL', added };
    }
    return { pnl: pct(avg, span[span.length - 1][4]) * size, exit: 'time', added };
}

(async () => {
    const rows = require(`${REPO}/data/reports/listing-study.json`).filter(r => r.type === 'SPOT_LISTING' && !r.skip);
    await bt.buildPool();
    const ev = [];
    for (const r of rows.sort((a, b) => a.pub - b.pub)) {
        const push = r.pub + (r.onsetMs || 0);
        const tape = await bt.trades(r.symbol, r.pub - 5000, r.pub + 330000);
        const e = tape && tape.find(x => x[0] >= push + 250);
        const k = await bt.klines(r.symbol, Math.floor(push / MIN) * MIN);
        if (!e || !k || k.c.length < 60) continue;
        // Path after the fill only: the entry minute's 1m low still holds the pre-jump prices. Ms trades
        // until the first full minute past the tape, 1m candles from there.
        const cut = Math.floor((r.pub + 330000) / MIN) * MIN;
        const c = [...tape.filter(t => t[0] >= e[0] && t[0] < cut).map(t => [t[0], t[1], t[1], t[1], t[1]]), ...k.c.filter(x => x[0] >= cut)];
        ev.push({ sym: r.symbol.replace('USDT', ''), year: r.date.slice(0, 4), e, c });
    }
    console.log(`${ev.length} spot listings with 1m path (entry push+0.25s)`);

    // what the losers of the live profile did afterwards
    console.log('\nlosers of the live profile (x10 SL5 60m): later path vs entry');
    console.log('sym | live | low 1h | low 4h | low 24h | close 1h | close 4h | close 24h');
    for (const x of ev) {
        const live = sim(x.c, x.e[0], x.e[1], 10, 5, 60);
        if (live.pnl > 0) continue;
        const w = m => x.c.filter(k => k[0] >= x.e[0] && k[0] < x.e[0] + m * MIN);
        const low = m => w(m).reduce((lo, k) => Math.min(lo, pct(x.e[1], k[3])), Infinity);
        const close = m => { const s = w(m); return s.length ? pct(x.e[1], s[s.length - 1][4]) : NaN; };
        console.log(`${x.sym.padEnd(10)} | ${live.exit} | ${low(60).toFixed(1)} | ${low(240).toFixed(1)} | ${low(1440).toFixed(1)} | ${close(60).toFixed(1)} | ${close(240).toFixed(1)} | ${close(1440).toFixed(1)}`);
    }

    console.log('\ngrid (margin 10u): total u | win | LIQ | worst u | maxDD u   — per year for the best rows below');
    const res = [];
    for (const lev of [2, 3, 5, 10]) for (const sl of [5, 10, 15, 20, 30, 0]) for (const hold of [60, 240, 1440]) {
        if (sl && sl >= 100 / lev - MMR && sl !== 5) continue; // stop beyond liquidation = same as no stop
        let tot = 0, win = 0, liq = 0, worst = 0, eq = 0, peak = 0, dd = 0;
        const years = {};
        for (const x of ev) {
            const s = sim(x.c, x.e[0], x.e[1], lev, sl, hold);
            const u = MARGIN * lev * (s.pnl - COST) / 100;
            tot += u; if (u > 0) win++; if (s.exit === 'LIQ') liq++; worst = Math.min(worst, u);
            eq += u; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
            years[x.year] = (years[x.year] || 0) + u;
        }
        res.push({ k: `x${lev} SL ${sl || 'none'} hold ${hold}m`, tot, win, liq, worst, dd, years });
    }
    for (const lev of [3, 5, 10]) for (const addAt of [5, 8, 10, 15]) for (const sl of [10, 15, 20, 0]) for (const hold of [60, 240]) {
        let tot = 0, win = 0, liq = 0, worst = 0, eq = 0, peak = 0, dd = 0, adds = 0;
        const years = {};
        for (const x of ev) {
            const s = simDca(x.c, x.e[0], x.e[1], lev, addAt, sl, hold);
            const u = MARGIN * lev * (s.pnl - COST) / 100;
            tot += u; if (u > 0) win++; if (s.exit === 'LIQ') liq++; if (s.added) adds++; worst = Math.min(worst, u);
            eq += u; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
            years[x.year] = (years[x.year] || 0) + u;
        }
        res.push({ k: `DCA x${lev} add -${addAt}% SL ${sl || 'none'} ${hold}m`, tot, win, liq, worst, dd, years, adds });
    }
    const line = r =>`${r.k.padEnd(24)} ${r.tot.toFixed(0).padStart(5)}u | win ${r.win}/${ev.length} | LIQ ${r.liq} | worst ${r.worst.toFixed(1)}u | DD ${r.dd.toFixed(0)}u | ${Object.entries(r.years).map(([y, v]) => `${y} ${v.toFixed(0)}`).join(' ')}`;
    const live = res.find(r => r.k === 'x10 SL 5 hold 60m');
    console.log('live   ' + line(live));
    for (const lev of [2, 3, 5, 10]) {
        console.log(`-- x${lev}`);
        res.filter(r => r.k.startsWith(`x${lev} `)).sort((a, b) => b.tot - a.tot).slice(0, 6).forEach(r => console.log('       ' + line(r)));
    }
    console.log('\nDCA (5u at entry + 5u at -addAt%, SL from the average):');
    for (const lev of [3, 5, 10]) {
        console.log(`-- x${lev}`);
        res.filter(r => r.k.startsWith(`DCA x${lev} `)).sort((a, b) => b.tot - a.tot).slice(0, 5).forEach(r => console.log(`       ${line(r)} | added ${r.adds}`));
    }
})().catch(e => { console.error(e); process.exit(1); });
