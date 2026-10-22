// Upbit / Bithumb notices without an account or the notice pages (Cloudflare blocks api-manager.upbit.com on
// the VPS): the PUBLIC quotation data carries the state a notice sets. Both exchanges share the format.
//   market_warning NONE -> CAUTION         = 유의종목 지정 (WARNING)       and back = 해제
//   delisting_date null -> date            = 거래지원 종료 안내 (DELISTING) — Bithumb keeps market_state ACTIVE
//   market_state ACTIVE -> PREDELISTING     = same notice on Upbit
//   a new code in /v1/market/all            = 신규 거래지원 (LISTING)
// Two feeds: the ticker WebSocket (pushed, but only when the market trades) and GET /v1/market/all every POLL_MS.
// Every transition goes to data/<exchange>_market_events.jsonl with the local time and the feed that saw it
// first, to measure the lag against the notice's publish time.
// Run: node scripts/tests/listen-kr-market.js <upbit|bithumb> [hours=24, 0 = forever]
const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');

const EXCHANGES = {
    upbit: {
        rest: 'https://api.upbit.com/v1/market/all?is_details=true',
        ws: 'wss://api.upbit.com/websocket/v1',
        warningOf: m => (m.market_event?.warning ? 'CAUTION' : 'NONE')
    },
    bithumb: {
        rest: 'https://api.bithumb.com/v1/market/all?isDetails=true',
        ws: 'wss://ws-api.bithumb.com/websocket/v1',
        warningOf: m => m.market_warning || 'NONE'
    }
};
const EXCHANGE = String(process.argv[2] || '').toLowerCase();
const X = EXCHANGES[EXCHANGE];
if (!X) { console.error(`usage: listen-kr-market.js <${Object.keys(EXCHANGES).join('|')}> [hours]`); process.exit(1); }
const HOURS = Number(process.argv[3] || 24);
const POLL_MS = 1000;
const FILE = path.join(__dirname, '..', '..', 'data', `${EXCHANGE}_market_events.jsonl`);
const clock = ms => new Date(ms + 7 * 3600e3).toISOString().slice(11, 23);
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

const state = new Map(); // code -> { warning, marketState, delistingDate }
let baselineDone = false;

function record(code, kind, from, to, feed, extra = {}) {
    const row = { at: Date.now(), exchange: EXCHANGE, feed, code, kind, from, to, ...extra };
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
    console.log(`${clock(row.at)} [${feed}] ${kind} ${code}: ${from} -> ${to}${extra.name ? ` (${extra.name})` : ''}`);
}

// A REST value counts once two polls in a row agree (guard against a stale cache answer). The
// market_event.caution flags are not tracked: they are computed live (GLOBAL_PRICE_DIFFERENCES flips every
// few seconds on BTC-SC, KRW-MANTRA...), not set by a notice.
const pending = new Map(); // `${code}|${field}` -> { value, firstAt }

/** REST only: the confirmed value (or the old one while unconfirmed) and when it was first seen. */
function confirmed(code, field, value, current) {
    const key = `${code}|${field}`;
    if (value === current) { pending.delete(key); return { value: current }; }
    const p = pending.get(key);
    if (!p || p.value !== value) { pending.set(key, { value, firstAt: Date.now() }); return { value: current }; }
    pending.delete(key);
    return { value, firstAt: p.firstAt };
}

/** Compare one observation with the known state; the first feed to show a change records it. */
function observe(code, obs, feed, name) {
    const prev = state.get(code);
    if (prev && feed === 'REST' && obs.warning !== undefined) {
        const c = confirmed(code, 'warning', obs.warning, prev.warning);
        obs.warning = c.value;
        if (c.firstAt) obs.firstSeenAt = c.firstAt;
    }
    if (!prev) {
        state.set(code, { ...obs });
        if (baselineDone) record(code, 'NEW_MARKET', '-', obs.marketState || 'listed', feed, { name });
        return;
    }
    const seen = obs.firstSeenAt ? { firstSeenAt: obs.firstSeenAt } : {};
    if (obs.warning !== undefined && obs.warning !== prev.warning) {
        record(code, obs.warning === 'CAUTION' ? 'WARNING_ON' : 'WARNING_OFF', prev.warning, obs.warning, feed, seen);
        prev.warning = obs.warning;
    }
    // market/all has neither market_state nor delisting_date: the first ticker of a code is its baseline.
    for (const [field, kind] of [['marketState', 'STATE'], ['delistingDate', 'DELISTING_DATE']]) {
        if (obs[field] === undefined) continue;
        if (prev[field] === undefined) { prev[field] = obs[field]; continue; }
        if (obs[field] !== prev[field]) {
            record(code, kind, prev[field], obs[field], feed, { marketState: obs.marketState, delistingDate: obs.delistingDate });
            prev[field] = obs[field];
        }
    }
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} ${body.slice(0, 120)}`));
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

let ws = null;
let subscribed = '';

async function poll() {
    try {
        const all = await getJson(X.rest);
        for (const m of all) observe(m.market, { warning: X.warningOf(m) }, 'REST', `${m.korean_name}/${m.english_name}`);
        if (!baselineDone) {
            baselineDone = true;
            console.log(`${EXCHANGE} baseline: ${all.length} markets, ${[...state.values()].filter(s => s.warning === 'CAUTION').length} with warning`);
        }
        const codes = all.map(m => m.market).sort().join(',');
        if (ws && ws.readyState === WebSocket.OPEN && codes !== subscribed) subscribe(codes.split(','));
    } catch (error) {
        console.log(`${clock(Date.now())} REST error ${error.message}`);
    }
}

function subscribe(codes) {
    subscribed = codes.join(',');
    ws.send(JSON.stringify([{ ticket: `${EXCHANGE}-market-${Date.now()}` }, { type: 'ticker', codes }, { format: 'DEFAULT' }]));
}

function connect() {
    ws = new WebSocket(X.ws, { perMessageDeflate: false });
    let ping = null;
    ws.on('open', () => {
        if (state.size) subscribe([...state.keys()]);
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('PING'), 60000);
    });
    ws.on('message', data => {
        let m;
        try { m = JSON.parse(data.toString()); } catch (_) { return; }
        if (!m.code) return;
        observe(m.code, {
            warning: m.market_warning || 'NONE',
            marketState: m.market_state,
            delistingDate: m.delisting_date ? JSON.stringify(m.delisting_date) : 'none'
        }, 'WS');
    });
    ws.on('close', () => { clearInterval(ping); subscribed = ''; console.log(`${clock(Date.now())} WS closed, reconnecting`); setTimeout(connect, 1000); });
    ws.on('error', e => console.log(`WS error ${e.message}`));
}

(async () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    await poll(); // baseline before the WS, so existing flags are not reported as changes
    connect();
    setInterval(poll, POLL_MS);
    console.log(`listening ${HOURS ? `${HOURS}h` : 'until stopped'} -> ${FILE}`);
    // setTimeout caps at ~24.8 days: check the end once a minute instead.
    const endAt = Date.now() + HOURS * 3600e3;
    if (HOURS > 0) setInterval(() => { if (Date.now() >= endAt) { console.log('done'); process.exit(0); } }, 60000);
})();
