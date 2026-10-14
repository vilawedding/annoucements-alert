/**
 * Lists every historical "Binance Will Delist ..." event that had a live USDT perp, with the price
 * change after the announcement (negative = fell = short wins). Reads data/backtest-cache written
 * by optimize.js (run that first). Times are GMT+7.
 *   node scripts/backtest/delist-list.js > delist.csv
 */
const fs = require('fs');
const path = require('path');
const CACHE = path.join(__dirname, '..', '..', 'data', 'backtest-cache');
const MIN = 60000, LAT = 20000;
const vn = ms => new Date(ms + 7 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
const pct = (a, b) => ((b / a - 1) * 100);
const f = x => (x >= 0 ? '+' : '') + x.toFixed(1);

const articles = [];
for (const name of fs.readdirSync(CACHE).filter(n => /^ann-b161-\d+\.json$/.test(n))) {
    articles.push(...(JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8')).data?.catalogs?.[0]?.articles || []));
}
const BLACK = new Set(['USDT', 'FDUSD', 'TUSD', 'USD', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB']);
const rows = [];
for (const a of articles) {
    const m = a.title.match(/\bwill delist\s+(.+?)\s+on\s+(\d{4}-\d{2}-\d{2})/i);
    if (!m) continue;
    for (const token of m[1].split(/\s*(?:,|&|\band\b)\s*/i).map(s => s.trim()).filter(s => /^[A-Z0-9]{2,10}$/.test(s) && !BLACK.has(s))) {
        const rm = Math.floor((a.releaseDate + LAT) / MIN) * MIN;
        const file = path.join(CACHE, `${token}USDT-${rm}.json`);
        if (!fs.existsSync(file)) continue;
        const c = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (c.length < 62 || c.slice(0, 60).filter(k => k[2] === k[3]).length > 45) continue; // no / dead perp
        const sp = path.join(CACHE, `spot1s-${token}USDT-${a.releaseDate + LAT}.json`);
        const spot = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')).p : null;
        const cc = c.slice(1);
        const entry = spot || cc[0][1];
        const at = n => cc[Math.min(n, cc.length) - 1][4];
        const win = cc.slice(0, 480);
        rows.push({
            released: vn(a.releaseDate), delistOn: m[2], token, entry,
            p60: pct(entry, at(60)), p240: pct(entry, at(240)), p480: pct(entry, at(480)),
            maxUp: pct(entry, Math.max(...win.map(k => k[2]))), maxDown: pct(entry, Math.min(...win.map(k => k[3]))),
            t: a.releaseDate
        });
    }
}
rows.sort((x, y) => y.t - x.t);
console.log('released(GMT+7),delist_on,token,entry,chg60m%,chg240m%,chg480m%,max_up_480m%,max_down_480m%,short_wins_480m');
for (const r of rows) console.log([r.released, r.delistOn, r.token, r.entry, f(r.p60), f(r.p240), f(r.p480), f(r.maxUp), f(r.maxDown), r.p480 < 0 ? 'YES' : 'no'].join(','));
const n = rows.length, fell = h => rows.filter(r => r[h] < 0).length;
console.error(`events=${n} | fell after 60m: ${fell('p60')} (${(fell('p60') / n * 100).toFixed(0)}%) | 240m: ${fell('p240')} (${(fell('p240') / n * 100).toFixed(0)}%) | 480m: ${fell('p480')} (${(fell('p480') / n * 100).toFixed(0)}%)`);
const avg = h => (rows.reduce((s, r) => s + r[h], 0) / n).toFixed(1);
console.error(`mean change: 60m ${avg('p60')}% | 240m ${avg('p240')}% | 480m ${avg('p480')}%`);
