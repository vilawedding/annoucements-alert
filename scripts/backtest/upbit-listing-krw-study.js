/**
 * Study: how to trade an Upbit KRW-market listing on Binance USDT-M perps — LONG or SHORT,
 * entered at T+10s ... T+60m after the notice or around Upbit's actual trading start
 * (usually 2-3h after the notice), with an SL / TP / time-stop grid, plus conditioning on
 * the pump size already done at T+10s and on the notice type.
 *
 * Same data/caches as upbit-alert-backtest.js. Fine path for the first ~16 minutes from
 * spot 1s klines (or futures trades aggregated to 1s when there is no spot pair), then perp 1m.
 *
 *   node scripts/backtest/upbit-listing-krw-study.js [--latency 10] [--cost 0.2] [--strategy LISTING_KRW]
 *
 * Output: data/reports/study-<strategy>-*.md
 */
const fs = require('fs');
const path = require('path');
const bt = require('./upbit-alert-backtest');

const { MIN, SPOT, mean, median, pct, fmtTz } = bt;
const args = process.argv.slice(2);
const argValue = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const STRATEGY = argValue('--strategy', 'LISTING_KRW');
const COST = bt.COST_PCT;
const FINE_SECONDS = 16 * 60;

const SL_GRID = [3, 5, 8, 12, 20, 0];
const TP_GRID = [3, 5, 10, 20, 0];
const HOLD_GRID = [5, 15, 60, 240, 1440];
const MIN_N = 10;
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');

// ==================== data ====================

/** "10월 12일 19시 30분 예정" (no year: taken from the notice) or "2026-06-20 10:00 KST" -> ms, else null. */
function parseKst(text, releaseMs) {
    const iso = String(text).match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{1,2}):(\d{2})/);
    if (iso) return Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4].padStart(2, '0')}:${iso[5]}:00+09:00`);
    const ko = String(text).match(/(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2})시(?:\s*(\d{1,2})분)?/);
    if (!ko) return null;
    const year = fmtTz(releaseMs, 9).slice(0, 4);
    const pad = n => String(n).padStart(2, '0');
    return Date.parse(`${year}-${pad(ko[1])}-${pad(ko[2])}T${pad(ko[3])}:${pad(ko[4] || 0)}:00+09:00`);
}

function tradingStartOf(ev, upbitRows) {
    const row = upbitRows.find(r => r.releaseMs === ev.releaseMs && r.tokens.includes(ev.token));
    const cell = (row?.tradingStartFinal || []).find(s => s.startsWith(`${ev.token}:`));
    if (!cell || /CANCELLED/.test(cell)) return null;
    const ms = parseKst(cell.slice(ev.token.length + 1), ev.releaseMs);
    return ms && ms > ev.releaseMs ? ms : null;
}

/** 1s candles [t, o, h, l, c] (perp units) for the first ~16 min after release - 30s. */
async function fineSeries(ev, perp) {
    const from = ev.releaseMs - 30000;
    const spot = await bt.binanceGet(SPOT, `/klines?symbol=${ev.token}USDT&interval=1s&startTime=${from}&limit=1000`);
    if (spot && spot.length) {
        const s = spot.map(k => [k[0], k[1] * perp.mult, k[2] * perp.mult, k[3] * perp.mult, k[4] * perp.mult]);
        const futPre = perp.c.filter(k => k[0] + MIN <= ev.releaseMs).pop()?.[4];
        const spotPre = s.filter(k => k[0] < ev.releaseMs).pop()?.[4];
        if (!futPre || !spotPre || Math.abs(pct(futPre, spotPre)) <= 5) return { source: 'spot', s };
    }
    const trades = await bt.trades(perp.symbol, from, from + FINE_SECONDS * 1000);
    if (!trades || !trades.length) return null;
    const bySecond = new Map();
    for (const [T, p] of trades) {
        const t = Math.floor(T / 1000) * 1000;
        const k = bySecond.get(t);
        if (!k) bySecond.set(t, [t, p, p, p, p]);
        else { k[2] = Math.max(k[2], p); k[3] = Math.min(k[3], p); k[4] = p; }
    }
    return { source: 'futures', s: [...bySecond.values()].sort((a, b) => a[0] - b[0]) };
}

/** Entry at `ts`: fine 1s data when it covers ts, else the open of the perp minute starting at/after ts. */
function entryAt(ts, fine, perpCandles, side) {
    const fineCovers = fine && fine.s.length && fine.s[fine.s.length - 1][0] >= ts && fine.s[0][0] <= ts;
    const minuteEnd = Math.floor(ts / MIN) * MIN + MIN;
    let entry, at, head;
    if (fineCovers) {
        const rest = fine.s.filter(k => k[0] >= ts && k[0] < minuteEnd);
        if (!rest.length) return null;
        [at, entry] = rest[0];
        head = [[at, entry, Math.max(...rest.map(k => k[2])), Math.min(...rest.map(k => k[3])), rest[rest.length - 1][4]]];
    } else {
        const k = perpCandles.find(x => x[0] >= ts);
        if (!k || k[0] - ts > MIN) return null;
        [at, entry] = k;
        head = [];
    }
    const tail = perpCandles.filter(k => k[0] >= (head.length ? minuteEnd : at));
    return { side, entry, entryAt: at, path: [...head, ...tail] };
}

/** Funding events [time, rate %] over the notice + 40h (covers late Upbit openings + 24h holds). */
async function fundingOf(symbol, releaseMs) {
    const data = await bt.binanceGet('https://fapi.binance.com/fapi/v1', `/fundingRate?symbol=${symbol}&startTime=${releaseMs}&endTime=${releaseMs + 40 * 3600e3}&limit=1000`);
    return (data || []).map(x => [x.fundingTime, Number(x.fundingRate) * 100]);
}

// ==================== evaluation ====================

/**
 * Net % of price incl. cost AND funding paid/received while the position is open
 * (rate > 0: LONG pays, SHORT receives). Within one candle the stop is assumed hit first.
 */
function simulate(t, sl, tp, hold) {
    const dir = t.side === 'LONG' ? 1 : -1;
    const span = t.path.filter(k => k[0] < t.entryAt + hold * MIN);
    let pnl = null, exitAt = span[span.length - 1][0] + MIN;
    for (const k of span) {
        const worst = dir * pct(t.entry, dir === 1 ? k[3] : k[2]);
        const best = dir * pct(t.entry, dir === 1 ? k[2] : k[3]);
        if (sl > 0 && worst <= -sl) { pnl = -sl; exitAt = k[0] + MIN; break; }
        if (tp > 0 && best >= tp) { pnl = tp; exitAt = k[0] + MIN; break; }
    }
    if (pnl === null) pnl = dir * pct(t.entry, span[span.length - 1][4]);
    const funding = t.funding.filter(([time]) => time > t.entryAt && time <= exitAt).reduce((sum, [, rate]) => sum + rate, 0);
    return pnl - dir * funding - COST;
}

function stats(values, chronological) {
    const half = Math.floor(chronological.length / 2);
    return {
        n: values.length,
        mean: mean(values),
        median: median(values),
        win: values.filter(v => v > 0).length / values.length * 100,
        worst: Math.min(...values),
        half1: mean(chronological.slice(0, half)),
        half2: mean(chronological.slice(half))
    };
}

function gridFor(trades) {
    const rows = [];
    for (const sl of SL_GRID) for (const tp of TP_GRID) for (const hold of HOLD_GRID) {
        // Only trades with enough path for the hold.
        const usable = trades.filter(t => t.path.length && t.path[t.path.length - 1][0] - t.entryAt >= hold * MIN * 0.9);
        if (usable.length < MIN_N) continue;
        const v = usable.map(t => simulate(t, sl, tp, hold));
        rows.push({ sl, tp, hold, ...stats(v, v) });
    }
    return rows;
}

const robustScore = r => Math.min(r.half1, r.half2);
const label = r => `SL ${r.sl || '-'} / TP ${r.tp || '-'} / ${r.hold >= 60 ? r.hold / 60 + 'h' : r.hold + 'm'}`;

// ==================== main ====================

async function main() {
    const { events } = bt.loadEvents();
    const { upbit } = JSON.parse(fs.readFileSync(bt.INPUT, 'utf8'));
    await bt.buildPool();
    const selected = events.filter(e => e.strategy === STRATEGY);
    console.log(`${STRATEGY}: ${selected.length} events`);

    const rows = [];
    for (const ev of selected) {
        const base = await bt.analyse(ev);
        if (base.skip) continue;
        const minute = Math.floor(ev.releaseMs / MIN) * MIN;
        const perp = await bt.resolvePerp(ev.token, minute);
        const fine = await fineSeries(ev, perp);
        const tradingStart = tradingStartOf(ev, upbit);
        // The notice window holds ~25h of candles; entries at Upbit's trading start (up to 8h later)
        // need their own 25h, otherwise late openings silently drop out of the 24h holds.
        if (tradingStart) {
            const late = await bt.klines(perp.symbol, tradingStart - 10 * MIN);
            if (late) {
                const merged = new Map(perp.c.map(k => [k[0], k]));
                for (const k of late.c) merged.set(k[0], k);
                perp.c = [...merged.values()].sort((a, b) => a[0] - b[0]);
            }
        }
        const funding = await fundingOf(perp.symbol, ev.releaseMs);
        const upbitRow = upbit.find(r => r.releaseMs === ev.releaseMs && r.tokens.includes(ev.token));
        rows.push({
            ev, base, perp, fine, funding,
            tradingStart,
            kind: /디지털\s*자산\s*추가/.test(ev.title) ? 'MARKET_ADD' : 'NEW_LISTING',
            krwOnly: ev.markets === 'KRW',
            depositOpen: (upbitRow?.depositOpen || []).join(' ')
        });
    }
    rows.sort((a, b) => a.ev.releaseMs - b.ev.releaseMs);
    console.log(`usable: ${rows.length}`);

    const entries = [
        ...[10, 30, 60, 180, 300, 900, 1800, 3600].map(s => ({ name: `T+${s >= 60 ? s / 60 + 'm' : s + 's'}`, at: r => r.ev.releaseMs + s * 1000 })),
        { name: 'Upbit open −5m', at: r => r.tradingStart && r.tradingStart - 5 * MIN },
        { name: 'Upbit open', at: r => r.tradingStart },
        { name: 'Upbit open +5m', at: r => r.tradingStart && r.tradingStart + 5 * MIN },
        { name: 'Upbit open +15m', at: r => r.tradingStart && r.tradingStart + 15 * MIN }
    ];

    const results = [];
    for (const e of entries) {
        for (const side of ['LONG', 'SHORT']) {
            const trades = rows.map(r => { const ts = e.at(r); const t = ts ? entryAt(ts, r.fine, r.perp.c, side) : null; return t && { ...t, funding: r.funding }; }).filter(Boolean);
            if (trades.length < MIN_N) continue;
            for (const g of gridFor(trades)) results.push({ entry: e.name, side, ...g });
        }
    }

    // ---------- report ----------
    const L = [];
    const w = (...s) => L.push(...s);
    w(`# Upbit ${STRATEGY} — LONG or SHORT on Binance perps`, '');
    w(`${rows.length} tradable notices (perp existed before the notice), ${fmtTz(rows[0].ev.releaseMs, 9).slice(0, 10)} → ${fmtTz(rows[rows.length - 1].ev.releaseMs, 9).slice(0, 10)} KST.`);
    w(`Net of ${COST}% round-trip cost and of the funding paid/received while open, % of price (ROI = × leverage). Within a candle SL is assumed hit first. "half1/half2" = mean in the first/second chronological half — a setup is only credible if both are positive.`, '');

    const gap = rows.filter(r => r.tradingStart).map(r => (r.tradingStart - r.ev.releaseMs) / MIN);
    w(`Upbit trading start after the notice: median ${f(median(gap), 0)} min (min ${f(Math.min(...gap), 0)}, max ${f(Math.max(...gap), 0)}), known for ${gap.length}/${rows.length}.`, '');

    // Price path relative to the last pre-notice price.
    w('## Average price path (vs last price before the notice)', '');
    const pathAt = (r, ts) => { const t = entryAt(ts, r.fine, r.perp.c, 'LONG'); return t ? pct(r.base.pre, t.entry) : NaN; };
    const checkpoints = [['+10s', 10e3], ['+1m', 60e3], ['+5m', 300e3], ['+15m', 900e3], ['+1h', 3600e3], ['+4h', 14400e3], ['+24h', 86400e3 - MIN]];
    w(`| | ${checkpoints.map(c => c[0]).join(' | ')} | Upbit open | open +1h | open +4h |`);
    w(`|---|${checkpoints.map(() => '---:').join('|')}|---:|---:|---:|`);
    const series = rows.map(r => [...checkpoints.map(c => pathAt(r, r.ev.releaseMs + c[1])),
        r.tradingStart ? pathAt(r, r.tradingStart) : NaN, r.tradingStart ? pathAt(r, r.tradingStart + 3600e3) : NaN, r.tradingStart ? pathAt(r, r.tradingStart + 14400e3) : NaN]);
    const col = i => series.map(s => s[i]).filter(Number.isFinite);
    w(`| mean | ${series[0].map((_, i) => f(mean(col(i)), 1) + '%').join(' | ')} |`);
    w(`| median | ${series[0].map((_, i) => f(median(col(i)), 1) + '%').join(' | ')} |`);
    w(`| % above pre | ${series[0].map((_, i) => f(col(i).filter(v => v > 0).length / col(i).length * 100, 0) + '%').join(' | ')} |`, '');

    w('## Best setup per entry time and side (ranked by worst-half mean)', '');
    w('| Entry | Side | Setup | n | mean | median | win | half1 / half2 | worst |', '|---|---|---|---:|---:|---:|---:|---|---:|');
    for (const e of entries) for (const side of ['LONG', 'SHORT']) {
        const best = results.filter(r => r.entry === e.name && r.side === side).sort((a, b) => robustScore(b) - robustScore(a))[0];
        if (best) w(`| ${e.name} | ${side} | ${label(best)} | ${best.n} | ${f(best.mean)}% | ${f(best.median)}% | ${f(best.win, 0)}% | ${f(best.half1)} / ${f(best.half2)} | ${f(best.worst, 1)}% |`);
    }

    w('', '## Top 15 overall (worst-half mean)', '');
    w('| Entry | Side | Setup | n | mean | median | win | half1 / half2 | worst |', '|---|---|---|---:|---:|---:|---:|---|---:|');
    for (const r of [...results].sort((a, b) => robustScore(b) - robustScore(a)).slice(0, 15)) {
        w(`| ${r.entry} | ${r.side} | ${label(r)} | ${r.n} | ${f(r.mean)}% | ${f(r.median)}% | ${f(r.win, 0)}% | ${f(r.half1)} / ${f(r.half2)} | ${f(r.worst, 1)}% |`);
    }

    // Conditioning at T+10s: does the pump already done predict the next move?
    w('', '## Conditioning at T+10s', '', 'Gross % return of a LONG from T+10s (SHORT = the negative).', '');
    const groups = [
        ['pump at 10s < 10%', r => r.base.moveBeforeEntry < 10],
        ['pump at 10s 10–25%', r => r.base.moveBeforeEntry >= 10 && r.base.moveBeforeEntry < 25],
        ['pump at 10s ≥ 25%', r => r.base.moveBeforeEntry >= 25],
        ['NEW_LISTING (신규 거래지원)', r => r.kind === 'NEW_LISTING'],
        ['MARKET_ADD (KRW 마켓 추가)', r => r.kind === 'MARKET_ADD'],
        ['KRW only', r => r.krwOnly],
        ['KRW + BTC/USDT', r => !r.krwOnly],
        ['spot pair on Binance', r => r.fine?.source === 'spot'],
        ['perp only (no Binance spot)', r => r.fine?.source !== 'spot']
    ];
    w('| Group | n | +5m mean / median | +1h mean / median | +4h mean / median | +24h mean / median | 24h % up |', '|---|---:|---|---|---|---|---:|');
    for (const [name, pred] of groups) {
        const g = rows.filter(pred);
        if (!g.length) continue;
        const r = h => g.map(x => x.base.returns[h]).filter(Number.isFinite);
        w(`| ${name} | ${g.length} | ${f(mean(r(5)), 1)} / ${f(median(r(5)), 1)} | ${f(mean(r(60)), 1)} / ${f(median(r(60)), 1)} | ${f(mean(r(240)), 1)} / ${f(median(r(240)), 1)} | ${f(mean(r(1440)), 1)} / ${f(median(r(1440)), 1)} | ${f(r(1440).filter(v => v > 0).length / r(1440).length * 100, 0)}% |`);
    }

    // Same grid restricted to sub-groups (small n: indicative only).
    w('', '## Best setup per sub-group (worst-half mean; small n = indicative only)', '');
    w('| Group | Entry | Side | Setup | n | mean | median | win | half1 / half2 | worst |', '|---|---|---|---|---:|---:|---:|---:|---|---:|');
    const subEntries = entries.filter(e => ['T+10s', 'T+5m', 'Upbit open', 'Upbit open +15m'].includes(e.name));
    for (const [name, pred] of groups) {
        const g = rows.filter(pred);
        if (g.length < MIN_N) continue;
        for (const e of subEntries) for (const side of ['LONG', 'SHORT']) {
            const trades = g.map(r => { const ts = e.at(r); const t = ts ? entryAt(ts, r.fine, r.perp.c, side) : null; return t && { ...t, funding: r.funding }; }).filter(Boolean);
            const best = gridFor(trades).sort((a, b) => robustScore(b) - robustScore(a))[0];
            if (best) w(`| ${name} | ${e.name} | ${side} | ${label(best)} | ${best.n} | ${f(best.mean)}% | ${f(best.median)}% | ${f(best.win, 0)}% | ${f(best.half1)} / ${f(best.half2)} | ${f(best.worst, 1)}% |`);
        }
    }

    // Candidate rule set, decided at T+L (L = your latency in seconds): the pump is measured at the
    // moment the bot can act, so a different latency also changes which rule fires.
    const pumpAt = (r, L) => { const t = entryAt(r.ev.releaseMs + L * 1000, r.fine, r.perp.c, 'LONG'); return t ? pct(r.base.pre, t.entry) : NaN; };
    const rulesFor = L => [
        { name: 'KRW market add → SHORT T+5m, SL 20 / TP 20 / 24h', when: r => r.kind === 'MARKET_ADD', side: 'SHORT', at: r => r.ev.releaseMs + Math.max(L, 300) * 1000, sl: 20, tp: 20, hold: 1440 },
        { name: `New listing, pump ≥ 25% at T+L → SHORT T+5m, SL 12 / TP 5 / 4h`, when: r => r.kind === 'NEW_LISTING' && pumpAt(r, L) >= 25, side: 'SHORT', at: r => r.ev.releaseMs + Math.max(L, 300) * 1000, sl: 12, tp: 5, hold: 240 },
        { name: `New listing, pump < 25% at T+L → LONG T+L, SL 8 / - / 24h`, when: r => r.kind === 'NEW_LISTING' && pumpAt(r, L) < 25, side: 'LONG', at: r => r.ev.releaseMs + L * 1000, sl: 8, tp: 0, hold: 1440 }
    ];
    const runBook = L => {
        const out = [];
        for (const r of rows) {
            const rule = rulesFor(L).find(x => x.when(r));
            const t = rule && entryAt(rule.at(r), r.fine, r.perp.c, rule.side);
            if (t) out.push({ rule: rule.name, r, net: simulate({ ...t, funding: r.funding }, rule.sl, rule.tp, rule.hold) });
        }
        return out;
    };
    const LAT = Number(argValue('--latency', 10));
    const RULES = rulesFor(LAT);
    const book = runBook(LAT);
    w('', '## Candidate rule set (one trade per notice, chronological)', '', 'Picked from the tables above, so in-sample: expect less live.', '');
    w('| Rule | n | mean | median | win | half1 / half2 | worst | sum |', '|---|---:|---:|---:|---:|---|---:|---:|');
    for (const name of [...RULES.map(x => x.name), 'ALL']) {
        const v = book.filter(b => name === 'ALL' || b.rule === name).map(b => b.net);
        if (!v.length) continue;
        const s = stats(v, v);
        w(`| ${name} | ${s.n} | ${f(s.mean)}% | ${f(s.median)}% | ${f(s.win, 0)}% | ${f(s.half1)} / ${f(s.half2)} | ${f(s.worst, 1)}% | ${f(v.reduce((a, b) => a + b, 0), 1)}% |`);
    }
    w('', '| Published (KST) | Symbol | Rule | Net % |', '|---|---|---|---:|');
    for (const b of book) w(`| ${fmtTz(b.r.ev.releaseMs, 9)} | ${b.r.base.symbol} | ${b.rule.split(' →')[0]} | ${f(b.net)} |`);

    // Latency tiers: the bot knows its own lag (now - first_listed_at) when it decides, so each
    // lag range gets its own action. A setup is scored on ALL latencies of its tier pooled
    // (real lag jitters inside a tier), then by the worse chronological half.
    const TIERS = [
        { name: '≤1.5s', maxMs: 1500, lat: [1] },
        { name: '1.5–3.5s', maxMs: 3500, lat: [2, 3] },
        { name: '3.5–6.5s', maxMs: 6500, lat: [4, 5, 6] },
        { name: '6.5–13s', maxMs: 13000, lat: [7, 8, 10, 12] },
        { name: '13–27s', maxMs: 27000, lat: [15, 20, 25] },
        { name: '27–65s', maxMs: 65000, lat: [30, 45, 60] }
    ];
    const MIN_EDGE_PCT = 0.5; // below this worst-half mean per trade: SKIP
    const tierConfig = [];
    w('', '## Config per latency tier (entry right at the bot\'s lag)', '');
    w(`Scored on all latencies of the tier pooled; pick = best worse-half mean, SKIP when it is under ${MIN_EDGE_PCT}% per trade. Net of cost and funding.`, '');
    w('| Kind | Lag tier | Action | SL / TP / hold | n (trades×lags) | mean | median | win | half1 / half2 | worst |', '|---|---|---|---|---:|---:|---:|---:|---|---:|');
    for (const kind of ['NEW_LISTING', 'MARKET_ADD']) {
        const group = rows.filter(r => r.kind === kind);
        for (const tier of TIERS) {
            let best = null;
            for (const side of ['LONG', 'SHORT']) for (const sl of SL_GRID) for (const tp of TP_GRID) for (const hold of HOLD_GRID) {
                // Chronological order across the pooled lags: sort by notice time.
                const v = [];
                for (const r of group) for (const L of tier.lat) {
                    const t = entryAt(r.ev.releaseMs + L * 1000, r.fine, r.perp.c, side);
                    if (t && t.path[t.path.length - 1][0] - t.entryAt >= hold * MIN * 0.9) v.push([r.ev.releaseMs, simulate({ ...t, funding: r.funding }, sl, tp, hold)]);
                }
                if (v.length < MIN_N) continue;
                const nets = v.sort((a, b) => a[0] - b[0]).map(x => x[1]);
                const s = stats(nets, nets);
                if (!best || robustScore(s) > robustScore(best)) best = { side, sl, tp, hold, ...s };
            }
            const action = best && robustScore(best) >= MIN_EDGE_PCT ? best.side : 'SKIP';
            tierConfig.push({ kind, tier: tier.name, maxLagMs: tier.maxMs, action, ...(best && { slPct: best.sl, tpPct: best.tp, maxHoldMin: best.hold, mean: +best.mean.toFixed(2), median: +best.median.toFixed(2), win: +best.win.toFixed(0), half1: +best.half1.toFixed(2), half2: +best.half2.toFixed(2), worst: +best.worst.toFixed(2), n: best.n }) });
            w(`| ${kind} | ${tier.name} | **${action}**${action === 'SKIP' && best ? ` (best: ${best.side})` : ''} | ${best ? label(best) : '-'} | ${best?.n ?? 0} | ${f(best?.mean)}% | ${f(best?.median)}% | ${f(best?.win, 0)}% | ${f(best?.half1)} / ${f(best?.half2)} | ${f(best?.worst, 1)}% |`);
        }
    }
    fs.writeFileSync(path.join(bt.REPORT_DIR, `latency-tiers-${STRATEGY.toLowerCase()}.json`), JSON.stringify({
        generatedAt: new Date().toISOString(), strategy: STRATEGY, costPct: COST, minEdgePct: MIN_EDGE_PCT,
        note: 'slPct/tpPct in % of price (0 = none); maxHoldMin = time stop. Lag = now - first_listed_at at order time. Lag above the last tier: SKIP.',
        tiers: tierConfig
    }, null, 2));

    // Latency sensitivity: same rules, entry + classification at T+L.
    w('', '## Latency sensitivity (same rules, pump measured and LONG entered at T+L)', '');
    w('| Latency | Median pump at L | Market add SHORT n / mean / win | Pump ≥ 25% SHORT n / mean / win | Pump < 25% LONG n / mean / median / win | ALL mean / median | ALL half1 / half2 |', '|---:|---:|---|---|---|---|---|');
    for (const L of [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 120]) {
        const b = runBook(L);
        const part = i => b.filter(x => x.rule === rulesFor(L)[i].name).map(x => x.net);
        const fmt = v => v.length ? `${v.length} / ${f(mean(v))}% / ${f(v.filter(x => x > 0).length / v.length * 100, 0)}%` : '-';
        const lv = part(2), all = b.map(x => x.net), s = stats(all, all);
        w(`| ${L}s | ${f(median(rows.filter(r => r.kind === 'NEW_LISTING').map(r => pumpAt(r, L)).filter(Number.isFinite)), 1)}% | ${fmt(part(0))} | ${fmt(part(1))} | ${lv.length} / ${f(mean(lv))}% / ${f(median(lv))}% / ${f(lv.filter(x => x > 0).length / lv.length * 100, 0)}% | ${f(s.mean)}% / ${f(s.median)}% | ${f(s.half1)} / ${f(s.half2)} |`);
    }

    w('', '## Per notice', '', '| Published (KST) | Symbol | Kind | Pump 10s | 1h | 4h | 24h | MFE 4h | MAE 4h | Upbit open (KST) | at open vs pre | Title |', '|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|');
    rows.forEach((r, i) => {
        const b = r.base;
        w(`| ${fmtTz(r.ev.releaseMs, 9)} | ${b.symbol} | ${r.kind} | ${f(b.moveBeforeEntry, 1)} | ${f(b.returns[60], 1)} | ${f(b.returns[240], 1)} | ${f(b.returns[1440], 1)} | ${f(b.mfe4h, 1)} | ${f(b.mae4h, 1)} | ${r.tradingStart ? fmtTz(r.tradingStart, 9).slice(5, 16) : '-'} | ${f(series[i][7], 1)} | [${r.ev.title.replace(/\|/g, '/')}](${r.ev.url}) |`);
    });

    const file = path.join(bt.REPORT_DIR, `study-${STRATEGY.toLowerCase()}-${path.basename(bt.INPUT).replace(/^announcements-|\.json$/g, '')}.md`);
    fs.writeFileSync(file, L.join('\n') + '\n');
    console.log(`Output: ${file}`);
}

main().catch(error => {
    console.error('❌', error.stack || error.message);
    process.exit(1);
});
