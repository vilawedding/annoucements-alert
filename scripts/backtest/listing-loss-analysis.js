// Why do Binance spot-listing LONGs lose? Per trade (live profile: entry push+0.25s, SL 5%, hold 60m, 1s
// closes) the features known before / just after entry, and simple rules that would have avoided losers.
// Needs data/reports/listing-study.json (listing-study.js). Output: table + rule checks on stdout.
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
process.argv.push('--exchange', 'binance', '--input', `${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`);
const bt = require('./upbit-alert-backtest');
const MIN = 60000;
const pct = (a, b) => (b / a - 1) * 100;

function run(sec, entryAt, entry, sl = 5, holdMin = 60) {
    let last = null, mfe = 0, mae = 0;
    for (const k of sec) {
        if (k[0] < entryAt - (entryAt % 1000)) continue;
        if (k[0] >= entryAt + holdMin * MIN) break;
        last = k;
        const r = pct(entry, k[4]);
        mfe = Math.max(mfe, r); mae = Math.min(mae, r);
        if (r <= -sl) return { pnl: r, exit: 'SL', at: k[0] - entryAt, mfe, mae };
    }
    return { pnl: pct(entry, last[4]), exit: 'time', at: last[0] - entryAt, mfe, mae };
}
const priceAt = (sec, t) => { let p = null; for (const k of sec) { if (k[0] > t) break; p = k[4]; } return p; };

(async () => {
    const rows = require(`${REPO}/data/reports/listing-study.json`).filter(r => r.type === 'SPOT_LISTING' && !r.skip);
    const ann = require(`${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`).binance;
    await bt.buildPool();
    const out = [];
    for (const r of rows.sort((a, b) => a.pub - b.pub)) {
        const push = r.pub + (r.onsetMs || 0);
        const tape = await bt.trades(r.symbol, r.pub - 5000, r.pub + 330000);
        const sec = await bt.secondCandles(r.symbol, push - 30000, push + 245 * MIN);
        const e = tape.find(x => x[0] >= push + 250);
        if (!e || !sec) continue;
        const res = run(sec, e[0], e[1]);
        // before the notice: 1m perp candles from 24h earlier
        const k = (await bt.klines(r.symbol, r.pub - 24 * 3600e3))?.c || [];
        const before = k.filter(c => c[0] + MIN <= r.pub);
        const ago = m => { const c = before.filter(x => x[0] <= r.pub - m * MIN).pop(); return c ? pct(c[4], r.pre) : null; };
        const firstCandle = k[0] ? k[0][0] : null;
        const title = (ann.find(n => n.releaseMs === r.pub) || {}).title || '';
        out.push({
            date: r.date.slice(0, 16), sym: r.symbol.replace('USDT', ''), pnl: res.pnl - 0.2, exit: res.exit, exitS: Math.round(res.at / 1000),
            jump: pct(r.pre, e[1]), run1h: ago(60), run24h: ago(1440), ageH: firstCandle ? (r.pub - firstCandle) / 3600e3 : null,
            seed: /seed tag/i.test(title), multi: /\band\b/i.test(title.split('with')[0]),
            r10: pct(e[1], priceAt(sec, e[0] + 10000)), r30: pct(e[1], priceAt(sec, e[0] + 30000)), r60: pct(e[1], priceAt(sec, e[0] + 60000)),
            r180: pct(e[1], priceAt(sec, e[0] + 180000)), peakS: r.peakMs / 1000, mfe: res.mfe, mae: res.mae, sec, e
        });
    }
    const f = (x, d = 1) => (x === null || !Number.isFinite(x) ? '-' : x.toFixed(d));
    console.log('date | sym | pnl% | exit | jump | run1h | run24h | seed | multi | r10s | r30s | r60s | r180s | peak s | MFE | MAE');
    for (const o of out.sort((a, b) => a.pnl - b.pnl)) {
        console.log([o.date, o.sym.padEnd(10), f(o.pnl).padStart(6), `${o.exit}@${o.exitS}s`.padEnd(10), f(o.jump), f(o.run1h), f(o.run24h), o.seed ? 'Y' : '-', o.multi ? 'Y' : '-', f(o.r10), f(o.r30), f(o.r60), f(o.r180), f(o.peakS, 0), f(o.mfe), f(o.mae)].join(' | '));
    }
    const groups = [['WIN', out.filter(o => o.pnl > 0)], ['LOSS', out.filter(o => o.pnl <= 0)]];
    const med = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    console.log('\nmedians:');
    for (const [name, g] of groups) {
        console.log(`  ${name} n=${g.length}: jump ${f(med(g.map(o => o.jump)))} | run1h ${f(med(g.map(o => o.run1h)))} | run24h ${f(med(g.map(o => o.run24h)))} | r10 ${f(med(g.map(o => o.r10)))} | r30 ${f(med(g.map(o => o.r30)))} | r60 ${f(med(g.map(o => o.r60)))} | peak ${f(med(g.map(o => o.peakS)), 0)}s | seed ${g.filter(o => o.seed).length}/${g.length} | multi ${g.filter(o => o.multi).length}/${g.length}`);
    }
    // exit-early rules: at +T s after entry, if return < X%, exit there (else keep the live profile)
    const sumOf = xs => xs.reduce((s, x) => s + x, 0);
    const base = sumOf(out.map(o => o.pnl));
    console.log(`\nlive profile: total ${f(base)}% (= ${f(base)}u at 100u notional) win ${out.filter(o => o.pnl > 0).length}/${out.length}`);
    console.log('early exit: at +T s, if return < X% -> close there (cost incl.)');
    for (const T of [10, 30, 60, 120, 180]) for (const X of [-2, 0, 2]) {
        const xs = out.map(o => {
            const r = pct(o.e[1], priceAt(o.sec, o.e[0] + T * 1000));
            if (o.exit === 'SL' && o.exitS <= T) return o.pnl;
            return r < X ? r - 0.2 : o.pnl;
        });
        const cut = out.filter(o => !(o.exit === 'SL' && o.exitS <= T) && pct(o.e[1], priceAt(o.sec, o.e[0] + T * 1000)) < X);
        console.log(`  +${String(T).padEnd(3)}s < ${String(X).padStart(2)}%: total ${f(sumOf(xs)).padStart(6)}% | win ${xs.filter(x => x > 0).length}/${xs.length} | cut ${cut.length} (winners cut: ${cut.filter(o => o.pnl > 0).map(o => `${o.sym} ${f(o.pnl, 0)}`).join(', ') || '-'})`);
    }
    // entry filters known at entry
    console.log('entry filters:');
    for (const [name, fn] of [['jump >= 5%', o => o.jump >= 5], ['jump < 10%', o => o.jump < 10], ['run1h < 3%', o => o.run1h === null || o.run1h < 3], ['run24h < 10%', o => o.run24h === null || o.run24h < 10], ['seed only', o => o.seed], ['single coin', o => !o.multi]]) {
        const s = out.filter(fn);
        console.log(`  ${name.padEnd(14)} n=${s.length} total ${f(sumOf(s.map(o => o.pnl)))}% win ${s.filter(o => o.pnl > 0).length}/${s.length} | dropped: ${out.filter(o => !fn(o)).map(o => `${o.sym} ${f(o.pnl, 0)}`).join(', ')}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
