// Connects to cryptolisting.ws with CRYPTOLISTING_API_KEY, prints the welcome (tier, expiry) and asks for
// one test_announcement to measure dispatch→receive latency. Never trades.
// Run: npm run check:cryptolisting
require('dotenv').config();
const WebSocket = require('ws');

const apiKey = process.env.CRYPTOLISTING_API_KEY;
const url = process.env.CRYPTOLISTING_WS_URL || 'wss://jp.cryptolisting.ws';
if (!apiKey) {
    console.error('CRYPTOLISTING_API_KEY not set');
    process.exit(1);
}

const startedAt = Date.now();
const ws = new WebSocket(url, { headers: { 'X-API-Key': apiKey }, perMessageDeflate: false });
const timeout = setTimeout(() => {
    console.error('No test_announcement within 20s');
    process.exit(1);
}, 20000);

ws.on('unexpected-response', (req, res) => {
    console.error(`Handshake rejected: HTTP ${res.statusCode}`);
    process.exit(1);
});
ws.on('open', () => console.log(`Connected ${url} in ${Date.now() - startedAt}ms`));
ws.on('message', (data) => {
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.type === 'welcome') {
        console.log('welcome', msg);
        ws.send(JSON.stringify({ type: 'test' }));
    } else if (msg.type === 'test_announcement') {
        console.log('test_announcement', msg);
        console.log(`dispatch→recv=${Date.now() - Math.floor(msg.dispatchTimestampUs / 1000)}ms (includes clock skew)`);
        clearTimeout(timeout);
        ws.close();
        process.exit(0);
    } else {
        console.log(msg.type, msg);
        if (msg.type === 'error') {
            clearTimeout(timeout);
            process.exit(1);
        }
    }
});
ws.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
});
