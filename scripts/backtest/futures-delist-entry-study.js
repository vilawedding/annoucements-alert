// Futures delist entry timing study (ms tape from Binance Vision aggTrades).
// For every BINANCE_FUTURES_DELIST event: crash onset vs publish (ms), bottom, and the live profile's
// result (SL / BE trail / max hold, 1s closes, LIQ as in live-config-backtest) for entry at publish + D.
const REPO = require('path').join(__dirname, '..', '..');
process.argv.push('--exchange', 'binance', '--input', `${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`);
const bt = require(`${REPO}/scripts/backtest/upbit-alert-backtest`);
const config = require(`${REPO}/config/config`);
const { trailingFromPricePct, getTrailLockRoiPct } = require(`${REPO}/modules/trading/trade-engine`);

const DELAYS = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 6, 10];
const p = config.strategies.binanceDelisting;
const MMR = 1;
const pct = (a, b) => (b / a - 1) * 100;

function sim(sec, entryAt, entry) {
    const lev = p.leverage, marginPct = 100 / lev, liqPct = marginPct - MMR;
    const trail = trailingFromPricePct(p.trail, lev);
    const end = entryAt + p.maxHoldMin * 60000;
    let stop = p.slPct > 0 ? -p.slPct : -Infinity; const initial = stop;
    let level = 0, last = null;
    for (const k of sec) {
        if (k[0] < entryAt - (entryAt % 1000)) continue;
        if (k[0] >= end) break;
        last = k;
        const r = -pct(entry, k[4]); // SHORT
        if (r <= -liqPct) return { pnl: -marginPct, exit: 'LIQ', at: k[0] };
        if (r <= stop) return { pnl: r, exit: stop > initial ? 'BE' : 'SL', at: k[0] };
        if (trail && r * lev >= trail.activateRoiPct + level * trail.stepRoiPct) {
            level++;
            stop = Math.max(stop, getTrailLockRoiPct(level, trail.lockBufferPct, trail.stepRoiPct, trail.firstLockRoiPct, trail.activateRoiPct, trail.maxGivebackRoiPct) / lev);
        }
    }
    return { pnl: -pct(entry, last[4]), exit: 'time', at: last[0] };
}

(async () => {
    const { events } = bt.loadEvents();
    const evs = events.filter(e => e.strategy === 'BINANCE_FUTURES_DELIST');
    evs.push({ token: 'PTB', releaseMs: 1792575003007, title: 'PTB/MITO 2026-10-21' }, { token: 'MITO', releaseMs: 1792575003007, title: 'PTB/MITO 2026-10-21' });
    await bt.buildPool();
    console.log(`profile ${p.amount}u x${p.leverage} SL ${p.slPct}% trail ${JSON.stringify(p.trail)} hold ${p.maxHoldMin}m cost ${bt.COST_PCT}% | events ${evs.length}`);
    const rows = [];
    for (const ev of evs) {
        const minute = Math.floor(ev.releaseMs / 60000) * 60000;
        const perp = await bt.resolvePerp(ev.token, minute).catch(() => null);
        if (!perp) { console.log(`skip ${ev.token} no perp`); continue; }
        const tape = await bt.trades(perp.symbol, ev.releaseMs - 5000, ev.releaseMs + 15000);
        if (!tape || tape.length < 20) { console.log(`skip ${perp.symbol} no tape`); continue; }
        const pre = (tape.filter(t => t[0] < ev.releaseMs).pop() || tape[0])[1];
        const onset = tape.find(t => t[0] >= ev.releaseMs - 2000 && t[1] <= pre * 0.97);
        const win = tape.filter(t => t[0] >= ev.releaseMs && t[0] <= ev.releaseMs + 15000);
        const bottom = win.reduce((m, t) => (t[1] < m[1] ? t : m), win[0] || [0, pre]);
        const sec = await bt.secondCandles(perp.symbol, ev.releaseMs - 30000, ev.releaseMs + (p.maxHoldMin + 5) * 60000);
        if (!sec) { console.log(`skip ${perp.symbol} no 1s`); continue; }
        const res = {};
        for (const d of DELAYS) {
            const t = tape.find(x => x[0] >= ev.releaseMs + d * 1000);
            if (!t) continue;
            const s = sim(sec, t[0], t[1]);
            res[d] = { entryPct: pct(pre, t[1]), net: s.pnl - bt.COST_PCT, exit: s.exit };
        }
        const row = { date: bt.fmtTz(ev.releaseMs, 7), symbol: perp.symbol, onsetMs: onset ? onset[0] - ev.releaseMs : null, bottomPct: pct(pre, bottom[1]), bottomMs: bottom[0] - ev.releaseMs, res };
        rows.push(row);
        console.log(`${row.date} ${row.symbol.padEnd(14)} onset ${String(row.onsetMs).padStart(6)}ms bottom ${row.bottomPct.toFixed(1)}% @${row.bottomMs}ms | ` +
            DELAYS.map(d => res[d] ? `${d}s:${res[d].entryPct.toFixed(1)}/${res[d].net.toFixed(1)}${res[d].exit[0]}` : `${d}s:-`).join(' '));
    }
    console.log('\nSummary (net price % per trade incl. cost; USDT = x notional ' + p.amount + 'u)');
    for (const d of DELAYS) {
        const xs = rows.map(r => r.res[d]).filter(Boolean);
        const sum = xs.reduce((s, x) => s + x.net, 0);
        const wins = xs.filter(x => x.net > 0).length;
        const ex = xs.reduce((m, x) => (m[x.exit] = (m[x.exit] || 0) + 1, m), {});
        console.log(`  +${String(d).padEnd(5)}s n=${xs.length} sum ${sum.toFixed(1)}% = ${(sum * p.amount / 100).toFixed(1)}u | mean ${(sum / xs.length).toFixed(2)}% | win ${wins}/${xs.length} | entry vs pre median ${bt.median(xs.map(x => x.entryPct)).toFixed(1)}% | exits ${JSON.stringify(ex)}`);
    }
    const on = rows.map(r => r.onsetMs).filter(x => x !== null);
    console.log(`onset (<= -3% vs pre) ms after publish: ${on.sort((a, b) => a - b).join(', ')}`);
    require('fs').writeFileSync(REPO + '/data/reports/futures-delist-entry-study.json', JSON.stringify(rows, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
