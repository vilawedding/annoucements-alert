// Round trip of a real order from this machine, on the Binance DEMO account only (refuses PRODUCTION).
// Opens and immediately closes a small BTCUSDT MARKET position N times, over the WS-API (the bot's order
// channel) and over REST, and prints send→ack timings. Run it here and on the VPS and compare.
// Note: demo/testnet hosts are not the production matching engine; also run `npm run probe:binance`.
// Run: npm run probe:order -- [rounds=5] [notionalUsdt=150]
require('dotenv').config();
const https = require('https');
const crypto = require('crypto');
const config = require('../../config/config');
const WsOrderClient = require('../../modules/trading/ws-order-client');

const ROUNDS = Number(process.argv[2] || 5);
const NOTIONAL = Number(process.argv[3] || 150);
const SYMBOL = 'BTCUSDT';
const cfg = config.binanceFutures;
if (cfg.mode !== 'DEMO' && cfg.mode !== 'TESTNET') {
    console.error(`❌ mode=${cfg.mode}: this probe only runs on DEMO/TESTNET`);
    process.exit(1);
}

const host = new URL(cfg.testnetUrl).host;
const agent = new https.Agent({ keepAlive: true, maxSockets: 2 });
let offset = 0;
const now = () => Date.now() + offset;
const ms = t0 => Number(process.hrtime.bigint() - t0) / 1e6;
const stats = a => {
    const s = [...a].sort((x, y) => x - y);
    return `min ${s[0].toFixed(1)}  median ${s[Math.floor(s.length / 2)].toFixed(1)}  max ${s[s.length - 1].toFixed(1)} ms`;
};

function rest(method, path, params = {}, signed = false) {
    let query = new URLSearchParams(params).toString();
    if (signed) {
        query += `${query ? '&' : ''}timestamp=${now()}&recvWindow=5000`;
        query += `&signature=${crypto.createHmac('sha256', cfg.apiSecret).update(query).digest('hex')}`;
    }
    return new Promise((resolve, reject) => {
        const req = https.request({ host, method, path: `${path}?${query}`, agent, headers: { 'X-MBX-APIKEY': cfg.apiKey } }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                const data = JSON.parse(body || '{}');
                if (res.statusCode >= 400) reject(new Error(`${res.statusCode} ${data.msg || body}`));
                else resolve(data);
            });
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const t = Date.now();
    const { serverTime } = await rest('GET', '/fapi/v1/time');
    offset = Math.round(serverTime - (t + (Date.now() - t) / 2)); // Binance rejects a fractional timestamp

    const [info, mark, dual] = await Promise.all([
        rest('GET', '/fapi/v1/exchangeInfo'),
        rest('GET', '/fapi/v1/premiumIndex', { symbol: SYMBOL }),
        rest('GET', '/fapi/v1/positionSide/dual', {}, true)
    ]);
    const step = Number(info.symbols.find(s => s.symbol === SYMBOL).filters.find(f => f.filterType === 'LOT_SIZE').stepSize);
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    const quantity = (Math.ceil(NOTIONAL / Number(mark.markPrice) / step) * step).toFixed(decimals);
    const hedge = dual.dualSidePosition;
    const open = { symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity, ...(hedge ? { positionSide: 'LONG' } : {}) };
    const close = { symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity, ...(hedge ? { positionSide: 'LONG' } : { reduceOnly: 'true' }) };
    console.log(`mode=${cfg.mode} host=${host} ${SYMBOL} qty=${quantity} (~${NOTIONAL} USDT) hedge=${hedge} rounds=${ROUNDS}`);

    const ws = new WsOrderClient({ url: cfg.wsApiUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, timestamp: now, label: 'PROBE' });
    ws.start();
    for (let i = 0; i < 50 && !ws.isReady(); i++) await new Promise(r => setTimeout(r, 100));
    if (!ws.isReady()) throw new Error('ws-api not connected');
    await rest('GET', '/fapi/v1/ping'); // warm the REST connection so no TLS handshake is timed

    const wsTimes = [], restTimes = [];
    for (let i = 0; i < ROUNDS; i++) {
        let t0 = process.hrtime.bigint();
        await ws.placeOrder({ ...open, newOrderRespType: 'ACK' });
        wsTimes.push(ms(t0));
        await ws.placeOrder({ ...close, newOrderRespType: 'ACK' });

        t0 = process.hrtime.bigint();
        await rest('POST', '/fapi/v1/order', { ...open, newOrderRespType: 'ACK' }, true);
        restTimes.push(ms(t0));
        await rest('POST', '/fapi/v1/order', { ...close, newOrderRespType: 'ACK' }, true);
        await new Promise(r => setTimeout(r, 300));
    }
    console.log(`WS-API order.place x${ROUNDS}: ${stats(wsTimes)}`);
    console.log(`REST   POST order  x${ROUNDS}: ${stats(restTimes)}`);
    ws.stop();
    process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
