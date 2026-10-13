// Live check of the Upbit private WebSocket announcement stream with the keys in .env.
// Run: node scripts/tests/check-upbit-ws.js [seconds=30]
// Verifies: handshake/auth (key + IP allowlist), subscription accepted (no error message),
// server keepalive ({"status":"UP"} reply to PING), and prints any announcement received.
require('dotenv').config();
const WebSocket = require('ws');
const config = require('../../config/config');
const upbit = require('../../modules/monitoring/upbit-monitor');

const seconds = parseInt(process.argv[2] || '30', 10);
const { wsUrl, accessKey, secretKey } = config.exchanges.upbit;

if (!accessKey || !secretKey) {
    console.error('❌ UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY missing in .env');
    process.exit(1);
}

const startedAt = Date.now();
const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${upbit._createJwt()}` },
    perMessageDeflate: false
});

ws.on('unexpected-response', (req, res) => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
        console.error(`❌ Handshake rejected: HTTP ${res.statusCode} ${body}`);
        console.error('   401 → wrong key/secret or this IP is not registered on the API key (max 10 IPs per key)');
        console.error('   418 → temporarily banned after repeated rate-limit violations, retry later');
        process.exit(1);
    });
});

ws.on('open', () => {
    console.log(`✅ Connected + authenticated in ${Date.now() - startedAt}ms`);
    ws.send(JSON.stringify([
        { ticket: `check-${Date.now()}` },
        { type: 'announcement', include_body: false },
        { format: 'DEFAULT' }
    ]));
    ws.send('PING');
});

ws.on('message', (data) => {
    const text = data.toString('utf8');
    let msg;
    try { msg = JSON.parse(text); } catch (_) { console.log('raw:', text); return; }

    if (msg.error) {
        console.error(`❌ Server error: ${msg.error.name} - ${msg.error.message}`);
        process.exit(1);
    }
    if (msg.status === 'UP') {
        console.log('✅ Keepalive OK ({"status":"UP"}) - subscription accepted, waiting for announcements...');
        return;
    }
    if (msg.type === 'announcement') {
        const lagMs = msg.timestamp ? Date.now() - msg.timestamp : null;
        console.log(`📩 ${msg.event_type} | ${msg.category} | ${msg.title} | listed_at=${msg.listed_at} | serverTs→local=${lagMs}ms | category→${upbit.categorize(msg.title)}`);
        return;
    }
    console.log('msg:', text);
});

ws.on('error', (error) => console.error(`❌ ${error.message}`));
ws.on('close', (code, reason) => console.log(`connection closed: ${code} ${reason || ''}`));

setTimeout(() => {
    console.log(`Done after ${seconds}s (no announcement is normal unless Upbit posted one in this window).`);
    ws.close();
    process.exit(0);
}, seconds * 1000);
