// Connects to Binance's announcement WebSocket (wss://api.binance.com/sapi/wss, topic com_announcement_en)
// with BINANCE_ANNOUNCE_API_KEY / _SECRET (or BINANCE_API_KEY / _SECRET) and prints every frame for
// `seconds` (default 60). Announcements are rare: a clean connect + no error is the check. Never trades.
// Run: npm run check:binance-ws -- [seconds]
require('dotenv').config();
const crypto = require('crypto');
const WebSocket = require('ws');

const apiKey = process.env.BINANCE_ANNOUNCE_API_KEY || process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_ANNOUNCE_API_SECRET || process.env.BINANCE_API_SECRET;
const seconds = Number(process.argv[2] || 60);
if (!apiKey || !secret) {
    console.error('BINANCE_ANNOUNCE_API_KEY / _SECRET (or BINANCE_API_KEY / _SECRET) not set — a production key, read-only is enough');
    process.exit(1);
}

const query = `random=${crypto.randomBytes(16).toString('hex')}&topic=com_announcement_en&recvWindow=30000&timestamp=${Date.now()}`;
const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
const ws = new WebSocket(`wss://api.binance.com/sapi/wss?${query}&signature=${signature}`, { headers: { 'X-MBX-APIKEY': apiKey } });

ws.on('unexpected-response', (req, res) => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => { console.error(`❌ handshake HTTP ${res.statusCode}: ${body}`); process.exit(1); });
});
ws.on('open', () => {
    console.log(`✅ connected, listening ${seconds}s`);
    const ping = setInterval(() => ws.ping(), 25000);
    setTimeout(() => { clearInterval(ping); ws.close(); console.log('done'); process.exit(0); }, seconds * 1000);
});
ws.on('message', d => console.log(new Date().toISOString(), d.toString('utf8').slice(0, 500)));
ws.on('close', (code, reason) => console.log(`closed ${code} ${reason}`));
ws.on('error', e => { console.error('❌', e.message); process.exit(1); });
