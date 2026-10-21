// How far is this machine from Binance's matching engine? Run it on the current server and on a candidate
// (AWS Tokyo ap-northeast-1 is where Binance runs) and compare. Read-only, no key, no order.
//   REST  : GET /fapi/v1/ping over a kept-alive connection (first call = TLS handshake, shown apart)
//   WS-API: "ping" over wss://ws-fapi.binance.com/ws-fapi/v1 (the channel the bot sends orders on)
//   clock : local clock vs Binance server time (the Telegram timeline mixes both)
// Run: npm run probe:binance -- [samples=30]
const https = require('https');
const WebSocket = require('ws');

const N = Number(process.argv[2] || 30);
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const stats = a => {
    const s = [...a].sort((x, y) => x - y);
    const q = f => s[Math.min(s.length - 1, Math.floor(s.length * f))];
    return `min ${s[0].toFixed(1)}  median ${q(0.5).toFixed(1)}  p90 ${q(0.9).toFixed(1)}  max ${s[s.length - 1].toFixed(1)} ms`;
};
const get = (path) => new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    https.get({ host: 'fapi.binance.com', path, agent }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, body }));
    }).on('error', reject);
});

(async () => {
    const first = await get('/fapi/v1/ping');
    const rest = [];
    for (let i = 0; i < N; i++) rest.push((await get('/fapi/v1/ping')).ms);
    console.log(`REST  first call (TLS handshake): ${first.ms.toFixed(1)} ms`);
    console.log(`REST  kept-alive /fapi/v1/ping x${N}: ${stats(rest)}`);

    const offsets = [];
    for (let i = 0; i < 5; i++) {
        const before = Date.now();
        const { ms, body } = await get('/fapi/v1/time');
        offsets.push(JSON.parse(body).serverTime - (before + ms / 2));
    }
    console.log(`clock local vs Binance: ${stats(offsets).replace(/ ms$/, '')} ms (positive = local clock behind)`);

    await new Promise((resolve) => {
        const ws = new WebSocket('wss://ws-fapi.binance.com/ws-fapi/v1');
        const rtts = [];
        let sentAt = 0;
        const next = () => { sentAt = Number(process.hrtime.bigint()) / 1e6; ws.send(JSON.stringify({ id: `p${rtts.length}`, method: 'ping' })); };
        ws.on('open', next);
        ws.on('message', () => {
            rtts.push(Number(process.hrtime.bigint()) / 1e6 - sentAt);
            if (rtts.length < N) return next();
            console.log(`WS-API ping x${N}: ${stats(rtts)}`);
            ws.close();
            resolve();
        });
        ws.on('error', e => { console.log(`WS-API error: ${e.message}`); resolve(); });
    });
    console.log('\nAn order reaches the engine ~ half the round trip after it is sent. Notices are pushed to everyone at');
    console.log('the same moment (futures delist ~0.9s after publish): to short before the crash the bot needs a few-ms');
    console.log('round trip (same AWS region as Binance) plus a push source without the FreeDelayed 240ms.');
    process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
