/**
 * Replays the CURRENT live trading config (config/config.js + .env) on the exported notices,
 * with a random detection+order lag per trade, to check what the enabled strategies would
 * have done. Mirrors the trader: one position per symbol at a time (a signal on a symbol
 * already open is skipped), SL / TP / time stop of the strategy profile, size = profile
 * amount (USDT notional). Net of cost and of the funding paid/received while open.
 *
 *   Upbit WARNING / DELISTING         -> config.strategies.upbitWarning / upbitDelisting
 *   Binance spot + futures delist     -> config.strategies.binanceDelisting (same scope filter as the bot)
 *
 *   node scripts/backtest/live-config-backtest.js [--lag-min 10] [--lag-max 20] [--runs 30] [--seed 1] [--cost 0.2]
 *
 * Output: data/reports/live-config-backtest-*.md (trade list of seed --seed + distribution over --runs seeds)
 */
const fs = require('fs');
const path = require('path');
process.argv.push('--exchange', 'all'); // the backtest module reads its CLI args at load
const bt = require('./upbit-alert-backtest');
const config = require('../../config/config');
const { trailingFromPricePct, getTrailLockRoiPct } = require('../../modules/trading/trade-engine');

const { MIN, pct, mean, median, fmtTz } = bt;
const args = process.argv.slice(2);
const argValue = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const LAG_MIN = Number(argValue('--lag-min', 10));
const LAG_MAX = Number(argValue('--lag-max', 20));
const RUNS = Number(argValue('--runs', 30));
const SEED = Number(argValue('--seed', 1));
// 1s = whole holding period on 1s perp candles built from aggTrades (falls back to 1m when no dump).
const RES = argValue('--res', '1m');
// Live SL/TP trigger on MARK_PRICE (no 1s history exists). Default 1s mode: trigger on the second's
// close and fill there (mark-price proxy, includes gap slippage). --wick: any trade in the second
// triggers, filled at the level (pessimistic bound).
const WICK = args.includes('--wick');
const PREFETCH_CONCURRENCY = 3;
// Maintenance margin rate, % of notional (Binance first bracket of small-cap perps is ~1-2.5%).
const MMR_PCT = Number(argValue('--mmr', 1));
const COST = bt.COST_PCT;
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');

// Export notice type -> live profile + enable flag (same routing as lightning-trader).
const ROUTES = {
    WARNING: { profile: 'upbitWarning', enabled: () => config.autoTrade.upbitWarning },
    DELISTING: { profile: 'upbitDelisting', enabled: () => config.autoTrade.upbitDelisting },
    BINANCE_SPOT_DELIST: { profile: 'binanceDelisting', enabled: () => config.autoTrade.binanceDelisting },
    BINANCE_FUTURES_DELIST: { profile: 'binanceDelisting', enabled: () => config.autoTrade.binanceDelisting }
};

/** Deterministic PRNG so a run can be reproduced (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function fundingOf(symbol, fromMs) {
    const data = await bt.binanceGet('https://fapi.binance.com/fapi/v1', `/fundingRate?symbol=${symbol}&startTime=${fromMs}&endTime=${fromMs + 26 * 3600e3}&limit=1000`);
    return (data || []).map(x => [x.fundingTime, Number(x.fundingRate) * 100]);
}

/** SHORT/LONG with the profile's SL / TP / time stop; stop assumed hit first inside a candle. */
function simulate(t, p) {
    const dir = t.side === 'LONG' ? 1 : -1;
    const span = t.path.filter(k => k[0] < t.entryAt + p.maxHoldMin * MIN);
    let pnl = null, exitAt = span[span.length - 1][0] + MIN, exit = 'time';
    for (const k of span) {
        const worst = dir * pct(t.entry, dir === 1 ? k[3] : k[2]);
        const best = dir * pct(t.entry, dir === 1 ? k[2] : k[3]);
        if (p.slPct > 0 && worst <= -p.slPct) { pnl = -p.slPct; exitAt = k[0] + MIN; exit = 'SL'; break; }
        if (p.tpPct > 0 && best >= p.tpPct) { pnl = p.tpPct; exitAt = k[0] + MIN; exit = 'TP'; break; }
    }
    if (pnl === null) pnl = dir * pct(t.entry, span[span.length - 1][4]);
    const funding = t.funding.filter(([time]) => time > t.entryAt && time <= exitAt).reduce((s, [, r]) => s + r, 0);
    const netPct = pnl - dir * funding - COST;
    return { netPct, usdt: p.amount * netPct / 100, exitAt, exit, fundingPct: -dir * funding };
}

/** Same as simulate() on a flat Float64Array of 1s candles [t, o, h, l, c]*n, from index t.secIdx. */
function simulate1s(t, p) {
    const dir = t.side === 'LONG' ? 1 : -1;
    const c = t.sec;
    const end = t.entryAt + p.maxHoldMin * MIN;
    // Isolated margin: liquidated (whole margin lost) once the move reaches 1/leverage minus the maintenance margin.
    const marginPct = 100 / p.leverage;
    const liqPct = marginPct - MMR_PCT;
    // Stop level in price % of the trade's direction (negative = loss); trailing raises it.
    const initialStop = p.slPct > 0 ? -p.slPct : -Infinity;
    let stop = initialStop;
    // Same ladder as the position manager (trade-engine), one level per mark tick (~1s) on the close.
    const trail = trailingFromPricePct(p.trail, p.leverage);
    let trailLevel = 0;
    let pnl = null, exitAt = null, exit = 'time', last = t.secIdx;
    for (let i = t.secIdx; i * 5 < c.length && c[i * 5] < end; i++) {
        last = i;
        const o = i * 5;
        const r = dir * pct(t.entry, c[o + 4]);
        const stopExit = stop > initialStop ? 'TRAIL' : 'SL';
        if (WICK) {
            const worst = dir * pct(t.entry, dir === 1 ? c[o + 3] : c[o + 2]);
            const best = dir * pct(t.entry, dir === 1 ? c[o + 2] : c[o + 3]);
            if (worst <= -liqPct && !(stop > -liqPct)) { pnl = -marginPct; exit = 'LIQ'; }
            else if (worst <= stop) { pnl = stop; exit = stopExit; }
            else if (p.tpPct > 0 && best >= p.tpPct) { pnl = p.tpPct; exit = 'TP'; }
        } else {
            // A jump past the liquidation price within one second beats the stop-market order.
            if (r <= -liqPct) { pnl = -marginPct; exit = 'LIQ'; }
            else if (r <= stop) { pnl = r; exit = stopExit; }
            else if (p.tpPct > 0 && r >= p.tpPct) { pnl = r; exit = 'TP'; }
        }
        if (pnl !== null) { exitAt = c[o] + 1000; break; }
        if (trail && r * p.leverage >= trail.activateRoiPct + trailLevel * trail.stepRoiPct) {
            trailLevel++;
            const lockRoi = getTrailLockRoiPct(trailLevel, trail.lockBufferPct, trail.stepRoiPct,
                trail.firstLockRoiPct, trail.activateRoiPct, trail.maxGivebackRoiPct);
            stop = Math.max(stop, lockRoi / p.leverage);
        }
    }
    if (pnl === null) { pnl = dir * pct(t.entry, c[last * 5 + 4]); exitAt = c[last * 5] + 1000; }
    const funding = t.funding.filter(([time]) => time > t.entryAt && time <= exitAt).reduce((s, [, r]) => s + r, 0);
    const netPct = pnl - dir * funding - COST;
    return { netPct, usdt: p.amount * netPct / 100, exitAt, exit, fundingPct: -dir * funding };
}

const eventKey = ev => `${ev.strategy}:${ev.token}:${ev.releaseMs}`;

/** Downloads/caches the 1s candles of every signal once (the lag only moves the entry inside them). */
async function prefetchSeconds(events) {
    if (LAG_MAX > 240) throw new Error('--res 1s fetches 5 minutes past the hold: keep --lag-max <= 240');
    const out = new Map();
    let next = 0, done = 0;
    const worker = async () => {
        while (next < events.length) {
            const ev = events[next++];
            const r = await bt.analyse(ev, LAG_MAX * 1000);
            if (!r.skip) {
                const p = config.strategies[ROUTES[ev.strategy].profile];
                const c = await bt.secondCandles(r.symbol, ev.releaseMs - 30000, ev.releaseMs + (p.maxHoldMin + 5) * MIN);
                if (c && c.length) out.set(eventKey(ev), Float64Array.from(c.flat()));
            }
            if (++done % 10 === 0) console.log(`  1s candles ${done}/${events.length}`);
        }
    };
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
    return out;
}

async function runOnce(events, seed, fundingCache, secondsCache) {
    const random = rng(seed);
    const trades = [];
    const skipped = [];
    const openUntil = new Map(); // symbol -> exit time of the open position
    for (const ev of events) {
        const lagMs = Math.round((LAG_MIN + random() * (LAG_MAX - LAG_MIN)) * 1000);
        let r = await bt.analyse(ev, lagMs);
        if (r.skip) { skipped.push({ ev, reason: r.skip }); continue; }
        const sec = secondsCache && secondsCache.get(eventKey(ev));
        if (sec) {
            // Market order at release + lag: filled at the first perp trade from then on.
            const entryTs = ev.releaseMs + lagMs;
            let idx = 0;
            while (idx * 5 < sec.length && sec[idx * 5] < entryTs) idx++;
            if (idx * 5 < sec.length && sec[idx * 5] - entryTs < 10000) {
                r = { ...r, sec, secIdx: idx, entryAt: sec[idx * 5], entry: sec[idx * 5 + 1], res: '1s' };
            }
        }
        if ((openUntil.get(r.symbol) || 0) > r.entryAt) { skipped.push({ ev, reason: `${r.symbol} already open` }); continue; }
        const p = config.strategies[ROUTES[ev.strategy].profile];
        if (!fundingCache.has(r.symbol + ev.releaseMs)) fundingCache.set(r.symbol + ev.releaseMs, await fundingOf(r.symbol, ev.releaseMs));
        const s = (r.res === '1s' ? simulate1s : simulate)({ ...r, side: ev.side, funding: fundingCache.get(r.symbol + ev.releaseMs) }, p);
        openUntil.set(r.symbol, s.exitAt);
        trades.push({ ev, r, p, lagMs, ...s });
    }
    trades.sort((a, b) => a.r.entryAt - b.r.entryAt);

    let eq = 0, peak = 0, maxDd = 0, streak = 0, maxStreak = 0;
    for (const t of trades) {
        eq += t.usdt; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq);
        streak = t.usdt < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
    }
    // Peak number of simultaneously open positions -> margin needed.
    const edges = trades.flatMap(t => [[t.r.entryAt, 1], [t.exitAt, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0, maxOpen = 0;
    for (const [, d] of edges) { open += d; maxOpen = Math.max(maxOpen, open); }
    return { seed, trades, skipped, total: eq, maxDd, maxStreak, maxOpen };
}

async function main() {
    const { from, to, events: all } = bt.loadEvents();
    const events = all.filter(e => ROUTES[e.strategy] && ROUTES[e.strategy].enabled())
        // the live trader shorts these; make the side explicit
        .map(e => ({ ...e, side: 'SHORT' }));
    await bt.buildPool();

    const profiles = [...new Set(events.map(e => ROUTES[e.strategy].profile))]
        .map(name => ({ name, ...config.strategies[name] }));
    console.log(`Live config: ${profiles.map(p => `${p.name} ${p.amount}u x${p.leverage} SL ${p.slPct} TP ${p.tpPct || '-'} hold ${p.maxHoldMin}m`).join(' | ')}`);
    console.log(`${events.length} signals ${from} → ${to}, lag random ${LAG_MIN}-${LAG_MAX}s, ${RUNS} runs`);

    const fundingCache = new Map();
    const secondsCache = RES === '1s' ? await prefetchSeconds(events) : null;
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        runs.push(await runOnce(events, SEED + i, fundingCache, secondsCache));
        if ((i + 1) % 5 === 0) console.log(`  run ${i + 1}/${RUNS}`);
    }
    const main = runs[0];

    const L = [];
    const w = (...s) => L.push(...s);
    const resLabel = RES === '1s' ? (WICK ? '1s candles, wick trigger' : '1s candles, close trigger') : '1m candles';
    w(`# Live config backtest — lag random ${LAG_MIN}–${LAG_MAX}s per trade, ${resLabel}`, '');
    if (RES === '1s') {
        const on1s = main.trades.filter(t => t.r.res === '1s').length;
        w(`Price path: 1s perp candles from aggTrades for ${on1s}/${main.trades.length} trades (others 1m). ` +
            (WICK ? 'SL/TP triggered by any trade in the second, filled at the level (pessimistic).'
                : 'SL/TP triggered when a second closes past the level and filled at that close (mark-price proxy, gap slippage included).'), '');
    }
    w(`Notices ${from} → ${to}. Config read from config/config.js + .env at ${new Date().toISOString().slice(0, 16)}Z. Net of ${COST}% cost and funding. One position per symbol at a time.`, '');
    w('| Profile | Size | SL / TP / hold | Trailing (price %) |', '|---|---|---|---|');
    for (const p of profiles) {
        const trailText = p.trail?.activatePct > 0 ? `activate ${p.trail.activatePct}% step ${p.trail.stepPct || p.trail.activatePct}% giveback ${p.trail.givebackPct || '-'}%` : 'off';
        w(`| ${p.name} | ${p.amount}u notional × ${p.leverage}x (margin ${f(p.amount / p.leverage, 1)}u) | ${p.slPct}% / ${p.tpPct || '-'}% / ${p.maxHoldMin}m | ${trailText} |`);
    }

    w('', `## Distribution over ${RUNS} random-lag runs (seeds ${SEED}–${SEED + RUNS - 1})`, '');
    const dist = key => { const v = runs.map(r => r[key]); return `${f(mean(v))} (min ${f(Math.min(...v))}, median ${f(median(v))}, max ${f(Math.max(...v))})`; };
    w(`- Total P&L: **${dist('total')} USDT**`);
    w(`- Max drawdown: ${dist('maxDd')} USDT`);
    w(`- Longest losing streak: ${dist('maxStreak')}`);
    const peakOpen = Math.max(...runs.map(r => r.maxOpen));
    const maxMargin = Math.max(...profiles.map(p => p.amount / p.leverage));
    w(`- Trades: ${f(mean(runs.map(r => r.trades.length)), 0)} per run; max open at once: ${peakOpen} (margin needed ≈ ${f(peakOpen * maxMargin, 0)}u)`);

    w('', `## Per strategy (mean over runs)`, '');
    w('| Signal | trades / run | total USDT | avg / trade | win | worst trade | SL / TRAIL / TP / time / LIQ exits |', '|---|---:|---:|---:|---:|---:|---|');
    for (const name of Object.keys(ROUTES)) {
        const per = runs.map(r => r.trades.filter(t => t.ev.strategy === name));
        if (!per[0] || !per.some(x => x.length)) continue;
        const flat = per.flat();
        const exits = ['SL', 'TRAIL', 'TP', 'time', 'LIQ'].map(x => `${f(flat.filter(t => t.exit === x).length / flat.length * 100, 0)}%`).join(' / ');
        w(`| ${name} | ${f(mean(per.map(x => x.length)), 1)} | ${f(mean(per.map(x => x.reduce((s, t) => s + t.usdt, 0))))} | ${f(mean(flat.map(t => t.usdt)))} | ${f(flat.filter(t => t.usdt > 0).length / flat.length * 100, 0)}% | ${f(Math.min(...flat.map(t => t.usdt)))} | ${exits} |`);
    }

    // By year: the live settings were picked on 2026 data, so earlier years are out-of-sample.
    const yearOf = t => fmtTz(t.r.entryAt, 7).slice(0, 4);
    const years = [...new Set(main.trades.map(yearOf))].sort();
    if (years.length > 1) {
        w('', '## By year (mean over runs) — settings were chosen on 2026, earlier years are out-of-sample', '');
        w('| Year | Signal | trades / run | total USDT | avg / trade | win | max DD in year |', '|---|---|---:|---:|---:|---:|---:|');
        for (const y of years) {
            for (const name of [...Object.keys(ROUTES), 'ALL']) {
                const per = runs.map(r => r.trades.filter(t => yearOf(t) === y && (name === 'ALL' || t.ev.strategy === name)));
                const flat = per.flat();
                if (!flat.length) continue;
                const dd = per.map(ts => { let eq = 0, pk = 0, m = 0; for (const t of ts) { eq += t.usdt; pk = Math.max(pk, eq); m = Math.max(m, pk - eq); } return m; });
                w(`| ${y} | ${name === 'ALL' ? '**ALL**' : name} | ${f(mean(per.map(x => x.length)), 1)} | ${f(mean(per.map(x => x.reduce((s, t) => s + t.usdt, 0))))} | ${f(mean(flat.map(t => t.usdt)))} | ${f(flat.filter(t => t.usdt > 0).length / flat.length * 100, 0)}% | ${f(mean(dd))} |`);
            }
        }
    }

    w('', `## Monthly P&L (seed ${SEED})`, '', '| Month | trades | USDT |', '|---|---:|---:|');
    const months = {};
    for (const t of main.trades) { const m = fmtTz(t.r.entryAt, 7).slice(0, 7); months[m] = months[m] || [0, 0]; months[m][0]++; months[m][1] += t.usdt; }
    for (const [m, [n, u]] of Object.entries(months).sort()) w(`| ${m} | ${n} | ${f(u)} |`);

    w('', `## Trades (seed ${SEED}: total ${f(main.total)}u, max DD ${f(main.maxDd)}u)`, '');
    w('| Published (GMT+7) | Signal | Symbol | Lag | Entry | Exit | Net % | Funding % | USDT | Cum. |', '|---|---|---|---:|---:|---|---:|---:|---:|---:|');
    let cum = 0;
    for (const t of main.trades) {
        cum += t.usdt;
        w(`| ${fmtTz(t.ev.releaseMs, 7)} | ${t.ev.strategy} | ${t.r.symbol} | ${f(t.lagMs / 1000, 1)}s | ${t.r.entry} | ${t.exit} | ${f(t.netPct)} | ${f(t.fundingPct)} | ${f(t.usdt)} | ${f(cum)} |`);
    }
    w('', `## Skipped signals (seed ${SEED})`, '', '| Published (GMT+7) | Signal | Token | Reason |', '|---|---|---|---|');
    for (const s of main.skipped) w(`| ${fmtTz(s.ev.releaseMs, 7)} | ${s.ev.strategy} | ${s.ev.token} | ${s.reason} |`);

    const resSuffix = RES === '1s' ? (WICK ? '-1s-wick' : '-1s') : '';
    const file = path.join(bt.REPORT_DIR, `live-config-backtest-${from}_${to}-lag${LAG_MIN}-${LAG_MAX}s${resSuffix}.md`);
    fs.writeFileSync(file, L.join('\n') + '\n');
    console.log(L.slice(0, 32).join('\n'));
    console.log(`Output: ${file}`);
}

main().catch(error => {
    console.error('❌', error.stack || error.message);
    process.exit(1);
});
