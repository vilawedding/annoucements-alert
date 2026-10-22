// SL x leverage grid for the Binance futures delist SHORT, entry anchored on the push (crash) time.
// push = cryptolisting detection (2026, = crash onset -1..3ms); older notices: crash onset if any, else publish.
// Margin fixed 10u -> notional 10 x lev. BE trail at +5% price (live), hold 240m, cost 0.2%, 1s closes,
// LIQ when the move reaches 100/lev - MMR (checked before the stop on each close, as live-config-backtest).
const REPO = require('path').join(__dirname, '..', '..');
process.argv.push('--exchange', 'binance', '--input', `${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`);
const bt = require(`${REPO}/scripts/backtest/upbit-alert-backtest`);
const config = require(`${REPO}/config/config`);
const { trailingFromPricePct, getTrailLockRoiPct } = require(`${REPO}/modules/trading/trade-engine`);

const MARGIN = 10;
const LEVS = [5, 10, 15, 20];
const SLS = [2, 3, 3.5, 4, 5, 7];
const MMRS = [1, 2];
const DELAYS = [0.25, 6];
const p = config.strategies.binanceDelisting;
const PUSH = { // publishDate -> cryptolisting detection (UTC ms)
    [Date.UTC(2026, 3, 23, 15, 0, 37, 768)]: Date.UTC(2026, 3, 23, 15, 0, 38, 668),
    [Date.UTC(2026, 3, 24, 11, 15, 13, 345)]: Date.UTC(2026, 3, 24, 11, 15, 14, 213),
    [Date.UTC(2026, 5, 25, 17, 0, 6, 669)]: Date.UTC(2026, 5, 25, 17, 0, 7, 589),
    [Date.UTC(2026, 6, 21, 14, 15, 14, 244)]: Date.UTC(2026, 6, 21, 14, 15, 15, 189),
    [Date.UTC(2026, 9, 1, 2, 45, 13, 435)]: Date.UTC(2026, 9, 1, 2, 45, 14, 329),
    [Date.UTC(2026, 9, 21, 9, 30, 3, 7)]: Date.UTC(2026, 9, 21, 9, 30, 3, 7)
};
const pct = (a, b) => (b / a - 1) * 100;

function sim(sec, entryAt, entry, lev, sl, mmr) {
    const liqPct = 100 / lev - mmr;
    const trail = trailingFromPricePct(p.trail, lev);
    const end = entryAt + p.maxHoldMin * 60000;
    let stop = -sl; let level = 0, last = null;
    for (const k of sec) {
        if (k[0] < entryAt - (entryAt % 1000)) continue;
        if (k[0] >= end) break;
        last = k;
        const r = -pct(entry, k[4]);
        if (r <= -liqPct && !(stop > -liqPct)) return { pnl: -100 / lev, exit: 'LIQ' };
        if (r <= stop) return { pnl: r, exit: stop > -sl ? 'BE' : 'SL' };
        if (trail && r * lev >= trail.activateRoiPct + level * trail.stepRoiPct) {
            level++;
            stop = Math.max(stop, getTrailLockRoiPct(level, trail.lockBufferPct, trail.stepRoiPct, trail.firstLockRoiPct, trail.activateRoiPct, trail.maxGivebackRoiPct) / lev);
        }
    }
    return { pnl: -pct(entry, last[4]), exit: 'time' };
}

(async () => {
    const { events } = bt.loadEvents();
    const evs = events.filter(e => e.strategy === 'BINANCE_FUTURES_DELIST');
    evs.push({ token: 'PTB', releaseMs: Date.UTC(2026, 9, 21, 9, 30, 3, 7) }, { token: 'MITO', releaseMs: Date.UTC(2026, 9, 21, 9, 30, 3, 7) });
    await bt.buildPool();
    const trades = [];
    for (const ev of evs) {
        const perp = await bt.resolvePerp(ev.token, Math.floor(ev.releaseMs / 60000) * 60000).catch(() => null);
        if (!perp) continue;
        const tape = await bt.trades(perp.symbol, ev.releaseMs - 5000, ev.releaseMs + 20000);
        if (!tape || tape.length < 20) continue;
        const sec = await bt.secondCandles(perp.symbol, ev.releaseMs - 30000, ev.releaseMs + (p.maxHoldMin + 5) * 60000);
        if (!sec) continue;
        const pre = (tape.filter(t => t[0] < ev.releaseMs).pop() || tape[0])[1];
        const onset = tape.find(t => t[0] >= ev.releaseMs - 2000 && t[1] <= pre * 0.97);
        const push = PUSH[ev.releaseMs] || (onset ? onset[0] : ev.releaseMs);
        const entries = {};
        for (const d of DELAYS) {
            const t = tape.find(x => x[0] >= push + d * 1000);
            if (t) entries[d] = t;
        }
        trades.push({ sym: perp.symbol, year: bt.fmtTz(ev.releaseMs, 7).slice(0, 4), sec, entries });
    }
    console.log(`${trades.length} trades, margin ${MARGIN}u, BE trail ${p.trail.activatePct}%, hold ${p.maxHoldMin}m, cost ${bt.COST_PCT}%`);
    for (const mmr of MMRS) for (const d of DELAYS) {
        console.log(`\n## entry push+${d}s, MMR ${mmr}%  (cells: total USDT | win/n | LIQ | SL | maxDD USDT)`);
        console.log('lev\\SL | ' + SLS.map(s => `${s}%`.padEnd(30)).join(' | '));
        for (const lev of LEVS) {
            const cells = SLS.map(sl => {
                let tot = 0, win = 0, n = 0, liq = 0, sls = 0, eq = 0, peak = 0, dd = 0;
                for (const t of trades) {
                    const e = t.entries[d]; if (!e) continue;
                    const s = sim(t.sec, e[0], e[1], lev, sl, mmr);
                    const usdt = MARGIN * lev * (s.pnl - bt.COST_PCT) / 100;
                    tot += usdt; n++; if (usdt > 0) win++; if (s.exit === 'LIQ') liq++; if (s.exit === 'SL') sls++;
                    eq += usdt; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
                }
                return `${tot.toFixed(0).padStart(5)}u ${win}/${n} L${liq} S${sls} DD${dd.toFixed(0)}`.padEnd(30);
            });
            console.log(`x${String(lev).padEnd(5)} | ${cells.join(' | ')}`);
        }
    }
})().catch(e => { console.error(e); process.exit(1); });
