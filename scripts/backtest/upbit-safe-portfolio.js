/**
 * "Safe" setups for every Upbit alert type on Binance perps, then a chronological account
 * simulation with a fixed risk per trade.
 *
 * Safe = a stop is mandatory (SL <= MAX_SL), hold <= 24h, median trade > 0, both chronological
 * halves > 0, n >= MIN_N. Ranked by return per unit of risk (worse-half mean / SL).
 * Net of cost and of the funding paid/received while the position is open.
 *
 * Account: each trade risks RISK_PCT of equity (notional = equity x RISK_PCT / SL), so a stop-out
 * costs RISK_PCT (+cost/funding) whatever the setup. Overlapping positions are not netted.
 *
 *   node scripts/backtest/upbit-safe-portfolio.js [--latency 10] [--risk 1] [--cost 0.2]
 *   node scripts/backtest/upbit-safe-portfolio.js --margin 5 --leverage 10   (fixed size, P&L in USDT)
 *
 * Output: data/reports/safe-portfolio-*.md
 */
const fs = require('fs');
const path = require('path');
const bt = require('./upbit-alert-backtest');

const { MIN, mean, median, pct, fmtTz } = bt;
const args = process.argv.slice(2);
const argValue = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const LATENCY_S = Number(argValue('--latency', 10));
const RISK_PCT = Number(argValue('--risk', 1));
const COST = bt.COST_PCT;
// Fixed sizing: every trade = MARGIN USDT x LEVERAGE notional (overrides --risk).
const MARGIN = Number(argValue('--margin', 0));
const LEVERAGE = Number(argValue('--leverage', 0));
const FIXED = MARGIN > 0 && LEVERAGE > 0;
const NOTIONAL = MARGIN * LEVERAGE;

// Isolated liquidation sits ~ (100 / leverage - maintenance) % away: keep the stop at 80% of it.
const MAX_SL = FIXED ? Math.min(10, Math.floor(100 / LEVERAGE * 0.8)) : 10;
const SL_GRID = [2, 3, 5, 8, 10].filter(x => x <= MAX_SL);
const TP_GRID = [2, 3, 5, 8, 10, 15, 0];
const HOLD_GRID = [15, 60, 240, 720, 1440];
const MIN_N = 8;
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');

async function fundingOf(symbol, fromMs) {
    const data = await bt.binanceGet('https://fapi.binance.com/fapi/v1', `/fundingRate?symbol=${symbol}&startTime=${fromMs}&endTime=${fromMs + 26 * 3600e3}&limit=1000`);
    return (data || []).map(x => [x.fundingTime, Number(x.fundingRate) * 100]);
}

/** Net % of price and exit time; stop assumed hit first inside a candle. */
function simulate(t, side, sl, tp, hold) {
    const dir = side === 'LONG' ? 1 : -1;
    const span = t.path.filter(k => k[0] < t.entryAt + hold * MIN);
    let pnl = null, exitAt = span[span.length - 1][0] + MIN, exit = 'time';
    for (const k of span) {
        const worst = dir * pct(t.entry, dir === 1 ? k[3] : k[2]);
        const best = dir * pct(t.entry, dir === 1 ? k[2] : k[3]);
        if (worst <= -sl) { pnl = -sl; exitAt = k[0] + MIN; exit = 'SL'; break; }
        if (tp > 0 && best >= tp) { pnl = tp; exitAt = k[0] + MIN; exit = 'TP'; break; }
    }
    if (pnl === null) pnl = dir * pct(t.entry, span[span.length - 1][4]);
    const funding = t.funding.filter(([time]) => time > t.entryAt && time <= exitAt).reduce((s, [, r]) => s + r, 0);
    return { net: pnl - dir * funding - COST, exitAt, exit };
}

function groupOf(ev) {
    if (ev.strategy === 'LISTING_KRW') return /디지털\s*자산\s*추가/.test(ev.title) ? 'LISTING_KRW_MARKET_ADD' : 'LISTING_KRW_NEW';
    return ev.strategy;
}

async function main() {
    const { events } = bt.loadEvents();
    await bt.buildPool();
    console.log(`${events.length} events, latency ${LATENCY_S}s, risk ${RISK_PCT}%/trade`);

    const trades = [];
    for (const ev of events) {
        const r = await bt.analyse(ev);
        if (r.skip) continue;
        trades.push({ ev, group: groupOf(ev), ...r, funding: await fundingOf(r.symbol, ev.releaseMs) });
    }
    trades.sort((a, b) => a.ev.releaseMs - b.ev.releaseMs);
    const groups = [...new Set(trades.map(t => t.group))];

    // ---------- safe setup per group ----------
    const picks = [];
    const L = [];
    const w = (...s) => L.push(...s);
    w(`# "Safe" ${bt.EXCHANGE} alert setups — Binance perps, entry ${LATENCY_S}s after the notice`, '');
    w(`Safe = stop mandatory (SL ≤ ${MAX_SL}%), hold ≤ 24h, median > 0, both chronological halves > 0, n ≥ ${MIN_N}. Ranked by worse-half mean ÷ SL (return per unit of risk). Net of ${COST}% cost and funding. % of price.`, '');
    w('| Alert | Side | SL / TP / hold | n | mean | median | win | half1 / half2 | worst | per unit risk |', '|---|---|---|---:|---:|---:|---:|---|---:|---:|');
    for (const group of groups) {
        const g = trades.filter(t => t.group === group);
        let best = null;
        for (const side of ['LONG', 'SHORT']) for (const sl of SL_GRID) for (const tp of TP_GRID) for (const hold of HOLD_GRID) {
            const v = g.map(t => simulate(t, side, sl, tp, hold).net);
            if (v.length < MIN_N) continue;
            const half = Math.floor(v.length / 2);
            const s = { side, sl, tp, hold, n: v.length, mean: mean(v), median: median(v), win: v.filter(x => x > 0).length / v.length * 100, h1: mean(v.slice(0, half)), h2: mean(v.slice(half)), worst: Math.min(...v) };
            if (s.median <= 0 || s.h1 <= 0 || s.h2 <= 0) continue;
            s.score = Math.min(s.h1, s.h2) / sl;
            if (!best || s.score > best.score) best = s;
        }
        if (!best) { w(`| ${group} | — | no safe setup | ${g.length} | | | | | | |`); continue; }
        picks.push({ group, ...best });
        w(`| ${group} | ${best.side} | SL ${best.sl} / TP ${best.tp || '-'} / ${best.hold >= 60 ? best.hold / 60 + 'h' : best.hold + 'm'} | ${best.n} | ${f(best.mean)}% | ${f(best.median)}% | ${f(best.win, 0)}% | ${f(best.h1)} / ${f(best.h2)} | ${f(best.worst, 1)}% | ${f(best.score, 3)} |`);
    }

    // ---------- account simulation ----------
    const runAccount = selected => {
        let equity = 100, peak = 100, maxDd = 0, streak = 0, maxStreak = 0;
        const curve = [];
        for (const t of trades) {
            const p = selected.find(x => x.group === t.group);
            if (!p) continue;
            const { net, exit } = simulate(t, p.side, p.sl, p.tp, p.hold);
            // Notional sized so a stop-out = RISK_PCT of equity.
            const pnl = FIXED ? NOTIONAL * net / 100 : equity * (RISK_PCT / 100) * (net / p.sl);
            equity += pnl;
            peak = Math.max(peak, equity);
            maxDd = Math.max(maxDd, FIXED ? peak - equity : (peak - equity) / peak * 100);
            streak = pnl < 0 ? streak + 1 : 0;
            maxStreak = Math.max(maxStreak, streak);
            curve.push({ t, p, net, exit, pnl, equity, leverage: RISK_PCT / p.sl });
        }
        return { equity, maxDd, maxStreak, curve };
    };

    if (FIXED) {
        w('', `## Account simulation — ${MARGIN} USDT margin × ${LEVERAGE}x = ${NOTIONAL} USDT per trade (P&L in USDT, start counted from 0)`, '');
        w(`A stop-out at SL x% costs ${NOTIONAL} × x% USDT (+ cost/funding); liquidation ≈ ${f(100 / LEVERAGE, 1)}% price, hence SL ≤ ${MAX_SL}%.`, '');
        w('| Book | trades | total P&L (USDT) | avg / trade | worst trade | max drawdown (USDT) | longest losing streak | win |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    } else {
        w('', `## Account simulation — risk ${RISK_PCT}% of equity per trade (start 100)`, '');
        w('Notional per trade = equity × risk ÷ SL, e.g. SL 5% → 20% of equity as notional (leverage ≥ 0.2x on the whole account).', '');
        w('| Book | trades | end equity | return | max drawdown | longest losing streak | win |', '|---|---:|---:|---:|---:|---:|---:|');
    }
    const books = [['All safe setups', picks], ...picks.map(p => [p.group, [p]])];
    for (const [name, sel] of books) {
        const a = runAccount(sel);
        if (!a.curve.length) continue;
        const win = f(a.curve.filter(c => c.pnl > 0).length / a.curve.length * 100, 0);
        if (FIXED) w(`| ${name} | ${a.curve.length} | ${f(a.equity - 100)} | ${f((a.equity - 100) / a.curve.length)} | ${f(Math.min(...a.curve.map(c => c.pnl)))} | ${f(a.maxDd)} | ${a.maxStreak} | ${win}% |`);
        else w(`| ${name} | ${a.curve.length} | ${f(a.equity, 1)} | ${f(a.equity - 100, 1)}% | ${f(a.maxDd, 1)}% | ${a.maxStreak} | ${win}% |`);
    }

    const all = runAccount(picks);
    w('', '## Trades of the combined book', '', '| Published (KST) | Alert | Symbol | Side | Exit | Net % price | Account P&L | Equity |', '|---|---|---|---|---|---:|---:|---:|');
    for (const c of all.curve) {
        w(`| ${fmtTz(c.t.ev.releaseMs, 9)} | ${c.t.group} | ${c.t.symbol} | ${c.p.side} | ${c.exit} | ${f(c.net)} | ${f(c.pnl)} | ${f(c.equity, 1)} |`);
    }

    const file = path.join(bt.REPORT_DIR, `safe-portfolio-${bt.EXCHANGE}-lat${LATENCY_S}s-${FIXED ? `${MARGIN}u-x${LEVERAGE}` : `risk${RISK_PCT}`}.md`);
    fs.writeFileSync(file, L.join('\n') + '\n');
    console.log(L.slice(0, 40).join('\n'));
    console.log(`Output: ${file}`);
}

main().catch(error => {
    console.error('❌', error.stack || error.message);
    process.exit(1);
});
