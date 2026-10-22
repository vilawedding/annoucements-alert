// Bithumb / Robinhood (and Upbit for comparison) notices from cryptolisting.ws's public feed (detection time
// to the microsecond), traded on the Binance USDT perp: listing -> LONG, delisting -> SHORT.
// Moves at detection + D from the ms tape, then the trade on 1s candles (x10, margin 10u, SL 5%, close
// trigger, liquidation at 100/lev - 1%), cost 0.2%. The feed snapshot is kept in data/reports for re-runs.
//   node scripts/backtest/kr-notice-study.js [--refresh]   (--refresh downloads the feed again)
const fs = require('fs');
const path = require('path');
const https = require('https');
const REPO = path.join(__dirname, '..', '..');
process.argv.push('--exchange', 'binance', '--input', `${REPO}/data/reports/announcements-2023-01-01_2026-10-15.json`);
const bt = require('./upbit-alert-backtest');
const FEED = path.join(REPO, 'data', 'reports', 'cryptolisting-recent-announcements.json');
const MIN = 60000, COST = 0.2, MARGIN = 10, LEV = 10, SL = 5, MMR = 1;
const DELAYS = [0.25, 1, 6, 30];
const HOLD = { spot_listing: [60, 240], cex_listing: [60, 240], wallet_listing: [60, 240], spot_delisting: [240, 720] };
const pct = (a, b) => (b / a - 1) * 100;

const getFeed = () => new Promise((resolve, reject) => {
    https.get('https://cryptolisting.ws/data/recent-announcements.json', { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
});

function sim(sec, entryAt, entry, dir, holdMin) {
    const liq = 100 / LEV - MMR;
    let last = null;
    for (const k of sec) {
        if (k[0] < entryAt - (entryAt % 1000)) continue;
        if (k[0] >= entryAt + holdMin * MIN) break;
        last = k;
        const r = dir * pct(entry, k[4]);
        if (r <= -liq) return { pnl: -100 / LEV, exit: 'LIQ' };
        if (r <= -SL) return { pnl: r, exit: 'SL' };
    }
    return last ? { pnl: dir * pct(entry, last[4]), exit: 'time' } : null;
}

(async () => {
    if (process.argv.includes('--refresh') || !fs.existsSync(FEED)) {
        // Merge with the saved snapshot: the public feed only keeps the recent events.
        const old = fs.existsSync(FEED) ? JSON.parse(fs.readFileSync(FEED, 'utf8')).events : [];
        const fresh = (await getFeed()).events;
        const key = e => `${e.cex}|${e.type}|${e.ticker}|${e.detected_at_us}`;
        const merged = [...new Map([...old, ...fresh].map(e => [key(e), e])).values()];
        fs.writeFileSync(FEED, JSON.stringify({ savedAt: new Date().toISOString(), events: merged }));
    }
    const events = JSON.parse(fs.readFileSync(FEED, 'utf8')).events
        .filter(e => ['bithumb', 'robinhood', 'upbit'].includes(e.cex) && HOLD[e.type] && e.ticker);
    await bt.buildPool();
    const rows = [];
    for (const e of events.sort((a, b) => a.detected_at_us - b.detected_at_us)) {
        const push = Math.floor(e.detected_at_us / 1000);
        const dir = /delist/.test(e.type) ? -1 : 1;
        for (const token of String(e.ticker).split(',').filter(Boolean)) {
            const perp = await bt.resolvePerp(token, Math.floor(push / MIN) * MIN).catch(() => null);
            if (!perp) continue;
            const tape = await bt.trades(perp.symbol, push - 5000, push + 60000);
            if (!tape || !tape.some(t => t[0] < push)) continue;
            const holdMax = Math.max(...HOLD[e.type]);
            const sec = await bt.secondCandles(perp.symbol, push - 30000, push + (holdMax + 5) * MIN);
            if (!sec) continue;
            const pre = tape.filter(t => t[0] < push).pop()[1];
            const r = { cex: e.cex, type: e.type, sym: perp.symbol, date: bt.fmtTz(push, 7).slice(0, 16), at: {}, res: {} };
            for (const d of DELAYS) {
                const t = tape.find(x => x[0] >= push + d * 1000);
                if (!t) continue;
                r.at[d] = dir * pct(pre, t[1]);
                for (const h of HOLD[e.type]) { const s = sim(sec, t[0], t[1], dir, h); if (s) r.res[`${d}|${h}`] = s; }
            }
            rows.push(r);
        }
    }
    const med = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    const f = x => (Number.isFinite(x) ? x.toFixed(1) : '-');
    for (const cex of ['bithumb', 'robinhood', 'upbit']) for (const type of Object.keys(HOLD)) {
        const g = rows.filter(r => r.cex === cex && r.type === type);
        if (!g.length) continue;
        const side = /delist/.test(type) ? 'SHORT' : 'LONG';
        console.log(`\n# ${cex} ${type} -> ${side} on the Binance perp: ${g.length} trades (${g[0].date} .. ${g[g.length - 1].date})`);
        console.log('  move in the trade direction at detection + D (median): ' + DELAYS.map(d => `+${d}s ${f(med(g.map(r => r.at[d])))}%`).join(' | '));
        for (const h of HOLD[type]) for (const d of DELAYS) {
            const xs = g.map(r => r.res[`${d}|${h}`]).filter(Boolean);
            const us = xs.map(s => MARGIN * LEV * (s.pnl - COST) / 100);
            const byYear = {};
            g.forEach(r => { const s = r.res[`${d}|${h}`]; if (s) byYear[r.date.slice(0, 7)] = 1; });
            console.log(`  x${LEV} SL ${SL}% hold ${String(h).padEnd(4)}m entry +${String(d).padEnd(4)}s: total ${f(us.reduce((a, b) => a + b, 0)).padStart(6)}u | median ${f(med(us))}u | win ${us.filter(u => u > 0).length}/${us.length} | SL ${xs.filter(s => s.exit === 'SL').length} LIQ ${xs.filter(s => s.exit === 'LIQ').length}`);
        }
    }
    fs.writeFileSync(path.join(REPO, 'data', 'reports', 'kr-notice-study.json'), JSON.stringify(rows));
})().catch(e => { console.error(e); process.exit(1); });
