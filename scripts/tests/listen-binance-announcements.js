// Listens to Binance's official announcement WebSocket (every catalog, not only list/delist) and records,
// per notice, when it arrived vs Binance's publish time, on Binance's clock (offset re-measured every minute
// from the fastest /fapi/v1/time samples). Lines go to data/binance_ws_announcements.jsonl.
// Afterwards `--compare` matches them with cryptolisting.ws's public feed (its detection time per notice).
// Run: npm run listen:binance-ws -- [hours=6, 0 = forever]      npm run listen:binance-ws -- --compare
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

const FILE = path.join(__dirname, '..', '..', 'data', 'binance_ws_announcements.jsonl');
const apiKey = process.env.BINANCE_ANNOUNCE_API_KEY || process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_ANNOUNCE_API_SECRET || process.env.BINANCE_API_SECRET;
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const getJson = (host, p) => new Promise((resolve, reject) => {
    https.get({ host, path: p, agent: host === 'fapi.binance.com' ? agent : undefined, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let b = '';
        res.on('data', c => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
});
const clock = ms => new Date(ms + 7 * 3600e3).toISOString().slice(11, 23);

// ---------- clock offset (Binance - local), from the fastest of a few samples ----------
let offsetMs = 0;
async function syncClock() {
    let best = null;
    for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        const { serverTime } = await getJson('fapi.binance.com', '/fapi/v1/time');
        const t1 = Date.now();
        if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: serverTime - (t0 + t1) / 2 };
    }
    offsetMs = Math.round(best.offset);
    return best;
}

async function compare() {
    if (!fs.existsSync(FILE)) return console.log('nothing recorded yet');
    const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.title);
    const feed = (await getJson('cryptolisting.ws', '/data/recent-announcements.json')).events.filter(e => e.cex === 'binance');
    console.log('| Binance publish (GMT+7) | official WS | cryptolisting (+240ms FreeDelayed) | catalog | title |');
    console.log('|---|---:|---:|---|---|');
    for (const r of rows) {
        const m = feed.filter(e => e.ticker && e.ticker.split(',').some(t => t && r.title.includes(t)) && Math.abs(e.detected_at_us / 1000 - r.publishDate) < 600000);
        const cl = m.length ? Math.min(...m.map(e => e.detected_at_us / 1000)) - r.publishDate : null;
        console.log(`| ${clock(r.publishDate)} | +${r.latencyMs}ms | ${cl === null ? '–' : `+${Math.round(cl)}ms (+${Math.round(cl + 240)})`} | ${r.catalogName} | ${r.title.slice(0, 80)} |`);
    }
}

async function listen(hours) {
    if (!apiKey || !secret) throw new Error('BINANCE_ANNOUNCE_API_KEY / _SECRET not set');
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const s = await syncClock();
    console.log(`clock: Binance - local = ${offsetMs}ms (rtt ${s.rtt}ms). Listening ${hours ? `${hours}h` : 'until stopped'} -> ${FILE}`);
    setInterval(() => syncClock().catch(() => {}), 60000).unref();

    const connect = () => {
        const query = `random=${crypto.randomBytes(16).toString('hex')}&topic=com_announcement_en&recvWindow=30000&timestamp=${Date.now() + offsetMs}`;
        const sig = crypto.createHmac('sha256', secret).update(query).digest('hex');
        const ws = new WebSocket(`wss://api.binance.com/sapi/wss?${query}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': apiKey }, perMessageDeflate: false });
        const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 25000);
        ws.on('message', data => {
            const recvLocal = Date.now();
            const recvBinance = recvLocal + offsetMs;
            let msg;
            try { msg = JSON.parse(data.toString('utf8')); } catch (_) { return; }
            if (msg.type === 'COMMAND') return console.log(`${new Date().toISOString()} COMMAND ${msg.subType} ${msg.data}`);
            const d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data || {};
            const row = {
                recvLocal, recvBinance, offsetMs,
                publishDate: d.publishDate, latencyMs: d.publishDate ? recvBinance - d.publishDate : null,
                catalogId: d.catalogId, catalogName: d.catalogName, title: d.title,
                bodyChars: (d.body || '').length, bodyIsTree: /^\s*\{\s*"node"/.test(d.body || '')
            };
            fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
            console.log(`📰 publish ${clock(d.publishDate)} recv ${clock(recvBinance)} (+${row.latencyMs}ms) [${d.catalogId} ${d.catalogName}] ${d.title} | body ${row.bodyChars} chars${row.bodyIsTree ? ' (JSON tree)' : ''}`);
        });
        ws.on('close', (code, reason) => { clearInterval(ping); console.log(`closed ${code} ${reason}, reconnecting`); setTimeout(connect, 2000); });
        ws.on('error', e => console.log('error', e.message));
    };
    connect();
    // The socket is reconnected on every close (Binance drops it after 24h), so it can run forever.
    if (hours > 0) setTimeout(() => { console.log('done'); process.exit(0); }, hours * 3600e3);
}

if (process.argv.includes('--compare')) compare().catch(e => { console.error(e); process.exit(1); });
else listen(process.argv[2] === undefined ? 6 : Number(process.argv[2])).catch(e => { console.error('❌', e.message); process.exit(1); });
