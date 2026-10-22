// Crawler regression tests (no network, no writes to data/ files).
// Run: node scripts/tests/test-crawler.js
const assert = require('assert');
process.env.SEEN_STORE_DISABLED = 'true'; // never touch data/seen_*.json from tests
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Tests must not depend on the developer's .env egress settings (dotenv never overrides set vars).
process.env.UPBIT_PROXIES = 'direct';
process.env.UPBIT_PROXIES_FILE = '';
process.env.UPBIT_SSH_TUNNELS = '';
const config = require('../../config/config');
config.exchanges.upbit.enabled = true;
config.exchanges.bithumb.enabled = true;
config.exchanges.binance.enabled = true;

const storage = require('../../modules/storage');
// Never touch the real storage files from tests
storage.saveUpbit = async () => {};
storage.saveBithumb = async () => {};
storage.saveBinance = async () => {};

const upbit = require('../../modules/monitoring/upbit-monitor');
const bithumb = require('../../modules/monitoring/bithumb-monitor');
const binance = require('../../modules/monitoring/binance-monitor');

// Silence throttled error logs from stubs
upbit.health.logIntervalMs = Infinity;

function resetStorage() {
    storage.upbitSentAnnouncements = {};
    storage.bithumbSentAnnouncements = {};
    storage.binanceSentAnnouncements = {};
}

function upbitNotice(id, title, listedAt) {
    return { id, uuid: `u${id}`, title, listed_at: listedAt, first_listed_at: listedAt, exchange: 'UPBIT' };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ==================== UPBIT ====================

test('upbit: newer non-trade notice from the all-category source does not mask a listing', async () => {
    resetStorage();
    upbit.seenKeys = new Set();
    upbit.restBaselined = true;
    const listing = upbitNotice(100, '깃코인(GTC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)', '2026-10-12T19:00:00+09:00');
    const other = upbitNotice(101, '서비스 점검 안내', '2026-10-12T19:00:05+09:00');

    upbit.fetchAnnouncementsFromSource = async (os, includeCategory) => (includeCategory ? [listing] : [other, listing]);

    const first = await upbit.check();
    const second = await upbit.check();
    const all = [...first.announcements, ...second.announcements];

    assert.strictEqual(all.filter(a => a.tokens[0] === 'GTC').length, 1, 'listing must be announced exactly once');
    assert.ok(all.find(a => a.tokens[0] === 'GTC')._shouldTrade);
});

test('upbit: two listings published between polls are both processed, oldest first', async () => {
    resetStorage();
    upbit.seenKeys = new Set();
    upbit.restBaselined = true;
    const a = upbitNotice(200, '에이(AAA) 신규 거래지원 안내 (KRW 마켓)', '2026-10-12T10:00:00+09:00');
    const b = upbitNotice(201, '비(BBB) 신규 거래지원 안내 (KRW 마켓)', '2026-10-12T10:00:10+09:00');
    upbit.fetchAnnouncementsFromSource = async () => [b, a];

    const result = await upbit.check();
    assert.deepStrictEqual(result.announcements.map(x => x.tokens[0]), ['AAA', 'BBB']);
    assert.strictEqual(result.announcement.tokens[0], 'BBB');

    const again = await upbit.check();
    assert.strictEqual(again.announcements.length, 0, 'no re-processing on next poll');
});

test('upbit: already stored (legacy REST hash) notice is not re-announced after restart', async () => {
    resetStorage();
    upbit.seenKeys = new Set();
    upbit.restBaselined = true;
    const n = upbitNotice(300, '씨(CCC) 신규 거래지원 안내 (KRW 마켓)', '2026-10-12T11:00:00+09:00');
    const legacyHash = crypto.createHash('md5').update(`UPBIT-${n.id}-${n.listed_at}`).digest('hex');
    storage.add(legacyHash, { title: n.title }, 'UPBIT');
    upbit.fetchAnnouncementsFromSource = async () => [n];

    const result = await upbit.check();
    assert.strictEqual(result.announcements.length, 0);
});

test('upbit: same notice from WS then REST is processed once', async () => {
    resetStorage();
    upbit.seenKeys = new Set();
    upbit.restBaselined = true;
    const ws = { uuid: 'u400', title: '디(DDD) 신규 거래 지원 안내', first_listed_at: '2026-10-12T12:00:00+09:00', listed_at: '2026-10-12T12:00:00+09:00', event_type: 'CREATED' };
    const viaWs = upbit.processAnnouncement(ws, 'WS');
    assert.ok(viaWs, 'WS notice processed');
    assert.strictEqual(viaWs.category, 'LISTING', 'spacing variant of listing title must match');

    upbit.fetchAnnouncementsFromSource = async () => [{ ...upbitNotice(400, ws.title, ws.listed_at), uuid: 'u400' }];
    const result = await upbit.check();
    assert.strictEqual(result.announcements.length, 0, 'REST must not re-process WS notice');
});

test('upbit: source failures resolve to empty and are recorded in health', async () => {
    resetStorage();
    upbit.seenKeys = new Set();
    upbit.restBaselined = true;
    upbit.fetchAnnouncementsFromSource = async () => { upbit.health.error('stub', 'HTTP 429'); return []; };
    const result = await upbit.check();
    assert.strictEqual(result.announcements.length, 0);
    assert.ok(upbit.getHealth().rest.lastError.includes('429'));
});

test('upbit: JWT is HS512 signed with secret key', () => {
    upbit.config.accessKey = 'ak';
    upbit.config.secretKey = 'sk';
    const [h, p, sig] = upbit._createJwt().split('.');
    const expected = crypto.createHmac('sha512', 'sk').update(`${h}.${p}`).digest('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    assert.strictEqual(sig, expected);
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    assert.strictEqual(payload.access_key, 'ak');
    assert.ok(payload.nonce);
});

test('upbit: first poll only considers the newest notice (stale storage must not re-trade old listings)', async () => {
    resetStorage();
    upbit.seenKeys = new Set();
    upbit.restBaselined = false;
    const old = upbitNotice(500, '올드(OLD) 신규 거래지원 안내 (KRW 마켓)', '2026-10-01T10:00:00+09:00');
    const newest = upbitNotice(501, '뉴(NEW) 신규 거래지원 안내 (KRW 마켓)', '2026-10-12T10:00:00+09:00');
    upbit.fetchAnnouncementsFromSource = async (os, includeCategory) => (includeCategory ? [newest, old] : [old]);

    const first = await upbit.check();
    assert.deepStrictEqual(first.announcements.map(a => a.tokens[0]), ['NEW']);
    const second = await upbit.check();
    assert.strictEqual(second.announcements.length, 0, 'baselined notices never processed');
});

test('upbit: all sources failing on startup keeps baseline pending', async () => {
    resetStorage();
    upbit.seenKeys = new Set();
    upbit.restBaselined = false;
    upbit.fetchAnnouncementsFromSource = async () => [];
    await upbit.check();
    assert.strictEqual(upbit.restBaselined, false);
});

test('upbit: poll schedule is dense around :00 and never sleeps past the burst window', () => {
    upbit.config.fastPolling = { burstIntervalMs: 150, burstPreMs: 300, burstPostMs: 2500, normalIntervalMs: 1500, maxInFlight: 4, requestTimeoutMs: 1500 };
    const minute = Date.UTC(2026, 9, 12, 10, 0, 0);

    assert.strictEqual(upbit._nextPollDelay(minute), 150, 'at :00.000');
    assert.strictEqual(upbit._nextPollDelay(minute + 2000), 150, 'at :02.000');
    assert.strictEqual(upbit._nextPollDelay(minute - 200), 150, 'at :59.800');
    assert.strictEqual(upbit._nextPollDelay(minute + 30000), 1500, 'mid-minute');
    assert.strictEqual(upbit._nextPollDelay(minute - 1000), 700, 'clamped to burst start at :59.700');

    const realPool = upbit.pool;
    upbit.pool = { size: 1, allCoolingDown: () => true };
    assert.strictEqual(upbit._nextPollDelay(minute), upbit.config.rateLimitPollMs, 'backs off while every IP is rate limited');
    upbit.pool = realPool;

    upbit.config.fastPolling.wsFallbackIntervalMs = 5000;
    upbit.wsConnected = true;
    assert.strictEqual(upbit._nextPollDelay(minute), 5000, 'REST is a slow fallback while WS is connected');
    upbit.wsConnected = false;
});

test('upbit: token extraction on real multi-token titles never returns market codes', () => {
    const cases = [
        ['BTC, USDT 마켓 신규 거래지원 안내 (BICO, BMT, NIL, GWEI) (BICO, BMT, NIL 거래지원 개시 시점 변경 안내)', ['BICO', 'BMT', 'NIL', 'GWEI']],
        ['BTC, USDT 마켓 신규 거래지원 안내 (CYS, ICNT, XAN, EDEN, AIOZ, ALLO) (거래지원 개시 시점 안내)', ['CYS', 'ICNT', 'XAN', 'EDEN', 'AIOZ', 'ALLO']],
        ['페이팔유에스디(PYUSD), 제이피와이코인(JPYC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)', ['PYUSD', 'JPYC']],
        ['메타다오(META2) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)', ['META2']],
        ['깃코인(GTC) KRW, USDT 마켓 디지털 자산 추가', ['GTC']],
        ['카이아(KAIA) 신규 거래지원 안내 (KRW, BTC, USDT 마켓) (KAIA/BTC 초기 매수 제한 안내)', ['KAIA']],
        ['BTC 마켓 신규 거래지원 안내', []]
    ];
    for (const [title, expected] of cases) {
        assert.deepStrictEqual(upbit.extractTokens(title), expected, title);
    }
    assert.strictEqual(upbit.categorize(cases[0][0]), 'LISTING');
});

test('upbit: warning lifted / extended / caution are never WARNING (no short on good news)', () => {
    assert.strictEqual(upbit.categorize('블러(BLUR) 거래 유의 종목 지정 안내'), 'WARNING');
    assert.strictEqual(upbit.categorize('샌드박스(SAND) 거래 유의 종목 지정 해제 안내'), 'WARNING_LIFTED');
    assert.strictEqual(upbit.categorize('만트라(MANTRA) 거래 유의 종목 지정 기간 연장 안내'), 'WARNING_EXTENDED');
    assert.strictEqual(upbit.categorize('헤데라(HBAR) 유의 촉구 안내'), 'CAUTION');
    // Pre-2025 wording without 거래
    assert.strictEqual(upbit.categorize('포튜브(FOR) 유의 종목 지정 안내'), 'WARNING');
    assert.strictEqual(upbit.categorize('플레이댑(PLA) 유의 종목 지정 기간 연장 안내'), 'WARNING_EXTENDED');
    assert.strictEqual(upbit.categorize('카바(KAVA), 웨이브(WAVES) 유의 종목 지정 해제 안내'), 'WARNING_LIFTED');
    assert.strictEqual(upbit.categorize('스택스(STX) 투자 유의 촉구 안내'), 'CAUTION');
    assert.strictEqual(upbit.categorize('아이콘(ICX) 거래지원 종료 안내 (10/19 15:00)'), 'DELISTING');
});

// ==================== PROXY POOL ====================

const { ProxyPool, maskProxyUrl } = require('../../modules/monitoring/proxy-pool');

test('proxy pool: round-robin, per-IP spacing, skip when all busy', () => {
    const pool = new ProxyPool(['direct', 'http://1.1.1.1:8080', 'socks5://u:p@2.2.2.2:1080'], { minIntervalMs: 1000, backoffMs: 60000 });
    const t = 1000000;
    assert.deepStrictEqual([pool.acquire(t), pool.acquire(t), pool.acquire(t)].map(e => e.id),
        ['direct', 'http://1.1.1.1:8080', 'socks5://***@2.2.2.2:1080']);
    assert.strictEqual(pool.acquire(t + 500), null, 'every IP used within its spacing');
    assert.strictEqual(pool.acquire(t + 1000).id, 'direct', 'first IP available again after spacing');
});

test('proxy pool: 429 cools only that IP, 418 cools longer, all-cooling detected', () => {
    const pool = new ProxyPool(['direct', 'http://1.1.1.1:8080'], { minIntervalMs: 0, backoffMs: 60000 });
    const a = pool.acquire();
    pool.reportError(a, 429);
    const now = Date.now();
    assert.strictEqual(pool.acquire(now).id, 'http://1.1.1.1:8080');
    assert.strictEqual(pool.acquire(now).id, 'http://1.1.1.1:8080', 'cooled IP is skipped');
    assert.strictEqual(pool.allCoolingDown(now), false);

    const b = pool.entries[1];
    pool.reportError(b, 418);
    assert.ok(b.cooldownUntil - now >= 4 * 60000 - 50, '418 = 4x backoff');
    assert.strictEqual(pool.allCoolingDown(now), true);
    assert.strictEqual(pool.acquire(now), null);

    pool.reportError(pool.entries[0], 500);
    assert.strictEqual(pool.getHealth()[0].rateLimited, 1, 'non-rate-limit errors do not cool down');
});

test('proxy pool: credentials masked, invalid scheme rejected', () => {
    assert.strictEqual(maskProxyUrl('http://user:secret@host:1'), 'http://***@host:1');
    assert.ok(!JSON.stringify(new ProxyPool(['http://user:secret@host:1'], { minIntervalMs: 0, backoffMs: 1 }).getHealth()).includes('secret'));
    assert.throws(() => new ProxyPool(['ftp://x:1'], { minIntervalMs: 0, backoffMs: 1 }), /unsupported scheme/);
});

test('upbit: burst interval auto-scales with the number of IPs', () => {
    const realNormal = upbit.config.fastPolling.normalIntervalMs;
    const realPool = upbit.pool;
    const realBurst = upbit.config.fastPolling.burstIntervalMs;
    upbit.config.fastPolling.burstIntervalMs = 0;
    upbit.config.perIpMinIntervalMs = 1000;
    upbit.pool = { size: 1 };
    assert.strictEqual(upbit._burstIntervalMs(), 1000);
    upbit.pool = { size: 10 };
    assert.strictEqual(upbit._burstIntervalMs(), 100);
    upbit.pool = { size: 100 };
    assert.strictEqual(upbit._burstIntervalMs(), 50, 'floored');
    upbit.config.fastPolling.normalIntervalMs = 0;
    upbit.config.fastPolling.burstPreMs = 0;
    upbit.config.fastPolling.burstPostMs = 0;
    upbit.wsConnected = false;
    upbit.pool = { size: 4, allCoolingDown: () => false };
    upbit.config.perIpMinIntervalMs = 6000;
    assert.strictEqual(upbit._nextPollDelay(Date.UTC(2026, 9, 12, 10, 0, 30)), 1500, 'uniform polling = 6000ms / 4 IPs');
    upbit.pool = realPool;
    upbit.config.fastPolling.burstIntervalMs = realBurst;
    upbit.config.fastPolling.normalIntervalMs = realNormal;
});

test('proxy pool: requests really go through an HTTP proxy and reuse the tunnel (keep-alive)', async () => {
    const http = require('http');
    const net = require('net');
    let connects = 0;
    const proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
        connects++;
        const [host, port] = req.url.split(':');
        const upstream = net.connect(Number(port), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));

    try {
        const pool = new ProxyPool([`http://127.0.0.1:${proxy.address().port}`], { minIntervalMs: 0, backoffMs: 1, timeout: 5000 });
        const entry = pool.acquire();
        for (let i = 0; i < 3; i++) {
            const res = await entry.client.get('https://fapi.binance.com/fapi/v1/ping');
            assert.strictEqual(res.status, 200);
        }
        assert.strictEqual(connects, 1, `expected 1 CONNECT (tunnel reused), got ${connects}`);
    } finally {
        proxy.close();
    }
});

test('proxy list: provider formats parsed, bad lines skipped without leaking content', () => {
    const { parseProxyLine, loadProxyFile } = require('../../modules/monitoring/proxy-list');
    assert.deepStrictEqual(parseProxyLine('1.2.3.4:8080:user:p@ss:w'), { proxy: 'http://user:p%40ss%3Aw@1.2.3.4:8080' });
    assert.deepStrictEqual(parseProxyLine('user:pw@5.6.7.8:3128'), { proxy: 'http://user:pw@5.6.7.8:3128' });
    assert.deepStrictEqual(parseProxyLine('9.9.9.9:1080', 'socks5'), { proxy: 'socks5://9.9.9.9:1080' });
    assert.deepStrictEqual(parseProxyLine('socks5h://u:p@7.7.7.7:1080'), { proxy: 'socks5h://u:p@7.7.7.7:1080' });
    assert.deepStrictEqual(parseProxyLine('direct'), { proxy: 'direct' });
    assert.ok(parseProxyLine('  # comment').skip);
    assert.ok(parseProxyLine('').skip);
    assert.ok(parseProxyLine('ftp://x:1').error);
    assert.ok(parseProxyLine('http-proxy-without-port').error);
    assert.ok(parseProxyLine('user:pass@ip1:port').error, 'placeholder rejected');

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxies-')), 'p.txt');
    fs.writeFileSync(file, '# x\n1.1.1.1:80:u:secretpw\nbad secretpw line\n\n');
    const warnings = [];
    const realWarn = console.warn;
    console.warn = msg => warnings.push(msg);
    try {
        assert.deepStrictEqual(loadProxyFile(file), ['http://u:secretpw@1.1.1.1:80']);
        assert.deepStrictEqual(loadProxyFile('/definitely/missing.txt'), []);
    } finally {
        console.warn = realWarn;
    }
    assert.ok(warnings.some(w => w.includes('line 3')));
    assert.ok(!warnings.some(w => w.includes('secretpw')), 'warning must not print the line');
});

test('proxy pool: malformed entry fails with a clear, masked message', () => {
    assert.throws(() => new ProxyPool(['direct', 'http://user:secret@ip1:port'], { minIntervalMs: 0, backoffMs: 1 }),
        e => /Invalid Upbit proxy #2/.test(e.message) && !e.message.includes('secret'));
});

// ==================== BITHUMB ====================

test('bithumb: first poll baselines old notices, later polls process every new notice', async () => {
    resetStorage();
    bithumb.seenIds = new Set();
    const page1 = [
        { id: 3, title: '에이(AAA) 원화 마켓 추가', publicationDateTime: '2026-10-12 10:00:00' },
        { id: 2, title: '비(BBB) 원화 마켓 추가', publicationDateTime: '2026-10-12 09:00:00' },
        { id: 1, title: '씨(CCC) 원화 마켓 추가', publicationDateTime: '2026-10-12 08:00:00' }
    ];
    bithumb.fetchNotices = async () => page1;
    const first = await bithumb.check();
    assert.deepStrictEqual(first.announcements.map(a => a.tokens[0]), ['AAA'], 'only newest on first poll');

    bithumb.fetchNotices = async () => [
        { id: 5, title: '이(EEE) 원화 마켓 추가', publicationDateTime: '2026-10-12 10:00:20' },
        { id: 4, title: '디(DDD) 원화 마켓 추가', publicationDateTime: '2026-10-12 10:00:10' },
        ...page1
    ];
    const second = await bithumb.check();
    assert.deepStrictEqual(second.announcements.map(a => a.tokens[0]), ['DDD', 'EEE']);
    assert.ok(second.announcements.every(a => a._shouldTrade));
});

test('bithumb: buildId segment is replaced in apiUrl', () => {
    const url = 'https://feed.bithumb.com/_next/data/OLDID/notice.json?category=9&page=1';
    const replaced = url.replace(/\/_next\/data\/[^/]+\//, '/_next/data/NEWID/');
    assert.strictEqual(replaced, 'https://feed.bithumb.com/_next/data/NEWID/notice.json?category=9&page=1');
});

// ==================== BINANCE ====================

test('binance: delisting without tokens does not block when delist trading is off', async () => {
    resetStorage();
    config.autoTrade.enabled = false;
    let parseCalled = false;
    binance.parseDelistDetails = () => {
        parseCalled = true;
        return new Promise(() => {}); // never resolves: would hang if awaited
    };
    binance.fetchAnnouncements = async (catalogId) => ({
        name: 'x',
        articles: catalogId === 161
            ? [{ id: 1, code: 'c1', title: 'Binance Will Delist Several Tokens on 2026-10-20', releaseDate: Date.now(), catalogId: 161, url: 'u' }]
            : [
                { id: 2, code: 'c2', title: 'Binance Will List Foo (FOO)', releaseDate: Date.now(), catalogId: 48, url: 'u' },
                { id: 3, code: 'c3', title: 'Binance Will List Bar (BAR)', releaseDate: Date.now(), catalogId: 48, url: 'u' }
            ]
    });

    const result = await Promise.race([
        binance.check(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('check() blocked')), 1000))
    ]);
    assert.ok(parseCalled);
    assert.deepStrictEqual(result.announcements.map(a => a.category).sort(), ['DELISTING', 'LISTING', 'LISTING']);

    const again = await binance.check();
    assert.strictEqual(again.announcements.length, 0, 'pending delisting stored, not re-fetched each poll');
});

test('binance: delistScope separates spot / futures from margin and other delists (2026 titles)', () => {
    const cases = [
        ['Binance Will Delist EPIC, QUICK on 2026-10-28', 'SPOT'],
        ['Binance Futures Will Delist Multiple USDⓈ-M Perpetual Contracts (2026-10-05)', 'FUTURES'],
        ['Binance Futures Will Delist COIN-M APTUSD and OPUSD Perpetual Contracts (2026-03-25)', 'FUTURES'],
        ['Binance Margin And Loans Token Delist on 2026-10-02', 'MARGIN'],
        ['Binance VIP Loan Will Delist TUSD and ALCX from Eligible Collateral Asset List - 2026-03-30', 'MARGIN'],
        ['Binance Will Delist UTK and Support Rebranding and Airdrop Plan on Binance Alpha', 'OTHER'],
        ['Notice of Removal of Spot Trading Pair (BTC/RON) - 2026-01-02', 'OTHER']
    ];
    for (const [title, scope] of cases) assert.strictEqual(binance.delistScope(title), scope, title);
});

test('binance: listingScope keeps spot listings only, same split as the backtest export', () => {
    const cases = [
        ['Binance Will List Celestia (TIA) with Seed Tag Applied', 'SPOT'],
        ['Binance Will List Rocket Pool (RPL) in the Innovation Zone', 'SPOT'],
        ['Binance Futures Will Launch USDⓈ-M FET Perpetual Contracts with Up to 20X Leverage', 'FUTURES'],
        ['Introducing Banana Gun (BANANA) on Binance HODLer Airdrops! Subscribe your BNB to Simple Earn', 'OTHER'],
        ['Binance Will End the Scroll (SCR) Pre-Market and List Scroll (SCR) with Seed Tag Applied', 'OTHER'],
        ['Balance (EPT) Will Be Available on Binance Alpha and Binance Futures', 'OTHER']
    ];
    for (const [title, scope] of cases) assert.strictEqual(binance.listingScope(title), scope, title);
});

test('binance: futures delist keeps the multiplier prefix and skips COIN-M contracts', () => {
    const line = '2026-10-05 09:00 (UTC): USDⓈ-M PROMPTUSDT, PUMPBTCUSDT and 1000000BOBUSDT Perpetual Contracts';
    assert.deepStrictEqual(binance.filterValidTokens(binance.extractPerpTokens(line)), ['PROMPT', 'PUMPBTC', '1000000BOB']);
    assert.deepStrictEqual(binance.extractPerpTokens('2026-03-25 09:00 (UTC): COIN-M APTUSD and OPUSD Perpetual Contracts'), []);
    assert.deepStrictEqual(binance.extractPerpTokens('Binance Futures Will Delist USDⓈ-M AERGOUSDT Perpetual Contract (2026-07-24)'), ['AERGO']);
});

test('binance: margin delist is alert-only, spot/futures delist carries its scope to the trader', async () => {
    resetStorage();
    const prev = { enabled: config.autoTrade.enabled, delisting: config.autoTrade.binanceDelisting };
    config.autoTrade.enabled = true;
    config.autoTrade.binanceDelisting = true;
    const awaited = [];
    binance.parseDelistDetails = async (code, scope) => {
        awaited.push([code, scope]);
        return scope === 'FUTURES' ? ['1000000BOB'] : ['GNS', 'WIN'];
    };
    binance.fetchAnnouncements = async (catalogId) => ({
        name: 'x',
        articles: catalogId === 161 ? [
            { id: 11, code: 'fut', title: 'Binance Futures Will Delist Multiple USDⓈ-M Perpetual Contracts (2026-10-05)', releaseDate: Date.now(), catalogId: 161, url: 'u' },
            { id: 12, code: 'mar', title: 'Binance Margin And Loans Token Delist on 2026-10-02', releaseDate: Date.now(), catalogId: 161, url: 'u' },
            { id: 13, code: 'spot', title: 'Binance Will Delist EPIC, QUICK on 2026-10-28', releaseDate: Date.now(), catalogId: 161, url: 'u' }
        ] : []
    });
    try {
        const result = await binance.check();
        const byCode = Object.fromEntries(result.announcements.map(a => [a.url === 'u' && a.title.includes('Futures') ? 'fut' : a.title.includes('Margin') ? 'mar' : 'spot', a]));
        assert.strictEqual(byCode.fut.delistScope, 'FUTURES');
        assert.deepStrictEqual(byCode.fut.tokens, ['1000000BOB']);
        assert.strictEqual(byCode.spot.delistScope, 'SPOT');
        assert.deepStrictEqual(byCode.spot.tokens, ['EPIC', 'QUICK'], 'spot tokens come from the title, no page fetch');
        assert.strictEqual(byCode.mar.delistScope, 'MARGIN');
        // Only the futures page was awaited; the margin page is resolved in the background.
        assert.deepStrictEqual(awaited.filter(([, s]) => s === 'FUTURES').map(([c]) => c), ['fut']);
    } finally {
        config.autoTrade.enabled = prev.enabled;
        config.autoTrade.binanceDelisting = prev.delisting;
    }
});

test('binance: list URL rotates catalogId cache keys (CloudFront TTL ~120s), never the shared hot key', () => {
    binance.cacheKeyCounter = 0;
    const keys = new Set();
    for (let i = 0; i < 1000; i++) {
        const url = binance._freshListUrl(48);
        assert.ok(/catalogId=0+48$/.test(url), url);
        assert.ok(!url.includes('_='), 'unknown params are rejected with HTTP 400');
        keys.add(url);
    }
    assert.strictEqual(keys.size, 1000, 'a key is reused only after 1000 polls');
    assert.ok(/catalogId=048$/.test(binance._freshListUrl(48)), 'wraps around');
});

test('seen store persists keys across restarts and caps its size', () => {
    const { SeenStore } = require('../../modules/storage/seen-store');
    const prev = process.env.SEEN_STORE_DISABLED;
    process.env.SEEN_STORE_DISABLED = 'false';
    try {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seen-')), 'seen.json');
        const a = new SeenStore(file, { maxEntries: 3 });
        ['k1', 'k2', 'k3', 'k4'].forEach(k => a.add(k));
        a.flush();
        const b = new SeenStore(file, { maxEntries: 3 });
        assert.ok(!b.has('k1'), 'oldest dropped');
        assert.ok(b.has('k2') && b.has('k4'), 'recent keys survive a restart');

        // monitors share the store's Set: marking through the monitor must still persist
        const file2 = path.join(path.dirname(file), 'seen2.json');
        const c = new SeenStore(file2);
        const mon = { seenStore: c, seenKeys: c.set, _seenKeysOf: n => [`uuid:${n.uuid}`] };
        upbit._markSeen.call(mon, { uuid: 'x1' });
        c.flush();
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(file2, 'utf8')), ['uuid:x1']);
    } finally {
        process.env.SEEN_STORE_DISABLED = prev;
    }
});

test('trader never trades a signal older than AUTO_TRADE_MAX_SIGNAL_AGE_SEC', async () => {
    const trader = require('../../modules/automation/lightning-trader');
    const realEnabled = config.autoTrade.enabled;
    const realPm = trader.positionManager;
    config.autoTrade.enabled = true;
    config.autoTrade.upbitWarning = true;
    trader.positionManager = null;
    let ordered = false;
    const realEntry = trader.binance.trading.marketEntry;
    trader.binance.trading.marketEntry = async () => { ordered = true; throw new Error('stop'); };
    try {
        const old = { exchange: 'UPBIT', category: 'WARNING', title: '블러(BLUR) 거래 유의 종목 지정 안내', tokens: ['BLUR'], releaseDate: Date.now() - 70 * 60000 };
        assert.strictEqual(await trader.executeLight(old), null);
        assert.strictEqual(await trader.executeLight({ ...old, releaseDate: undefined }), null, 'unknown publication time');
        assert.ok(!ordered, 'no order for stale / undated signals');
    } finally {
        trader.binance.trading.marketEntry = realEntry;
        trader.positionManager = realPm;
        config.autoTrade.enabled = realEnabled;
    }
});

test('trader shorts Binance spot/futures delists only, never margin / unknown scope', async () => {
    const trader = require('../../modules/automation/lightning-trader');
    const real = { enabled: config.autoTrade.enabled, delisting: config.autoTrade.binanceDelisting, pm: trader.positionManager, entry: trader.binance.trading.marketEntry, skip: trader.fastModeSkipTradableCheck, isolated: trader.binance.isIsolatedCached };
    config.autoTrade.enabled = true;
    config.autoTrade.binanceDelisting = true;
    trader.positionManager = { positions: new Map() }; // marketEntry path, no open position
    trader.binance.isIsolatedCached = () => true; // no margin-type call to Binance
    trader.fastModeSkipTradableCheck = true;
    const ordered = [];
    // Leverage must be set BEFORE the order (MITOUSDT 2026-10-21 entered at a stale 50x). No network.
    const leverageOf = new Map([['1000000BOBUSDT', 50]]);
    real.getLev = trader.binance.getLeverageCached;
    real.setLev = trader.binance.changeInitialLeverage;
    trader.binance.getLeverageCached = symbol => (leverageOf.has(symbol) ? leverageOf.get(symbol) : null);
    trader.binance.changeInitialLeverage = async (symbol, lev) => { ordered.push(['leverage', symbol, lev]); leverageOf.set(symbol, lev); return { leverage: lev }; };
    trader.binance.trading.marketEntry = async (symbol, side) => { ordered.push([symbol, side]); throw new Error('stop'); };
    try {
        const base = { exchange: 'BINANCE', category: 'DELISTING', releaseDate: Date.now() };
        assert.strictEqual(await trader.executeLight({ ...base, delistScope: 'MARGIN', title: 'Binance Margin And Loans Token Delist on 2026-10-02', tokens: ['GNS'] }), null);
        assert.strictEqual(await trader.executeLight({ ...base, title: 'no scope (old monitor)', tokens: ['GNS'] }), null);
        assert.deepStrictEqual(ordered, [], 'no order for margin / unknown delists');

        await trader.executeLight({ ...base, delistScope: 'FUTURES', title: 'Binance Futures Will Delist Multiple USDⓈ-M Perpetual Contracts', tokens: ['1000000BOB'] }).catch(() => {});
        const lev = config.strategies.binanceDelisting.leverage;
        assert.deepStrictEqual(ordered, [['leverage', '1000000BOBUSDT', lev], ['1000000BOBUSDT', 'SELL']], 'leverage set before the short of the multiplier perp');
        ordered.length = 0;
        await trader.executeLight({ ...base, delistScope: 'FUTURES', title: 'Binance Futures Will Delist USDⓈ-M 1000000BOBUSDT Perpetual Contract', tokens: ['1000000BOB'] }).catch(() => {});
        assert.deepStrictEqual(ordered, [['1000000BOBUSDT', 'SELL']], 'no leverage call when it is already right');
    } finally {
        trader.binance.trading.marketEntry = real.entry;
        trader.binance.isIsolatedCached = real.isolated;
        trader.binance.getLeverageCached = real.getLev;
        trader.binance.changeInitialLeverage = real.setLev;
        trader.positionManager = real.pm;
        trader.fastModeSkipTradableCheck = real.skip;
        config.autoTrade.enabled = real.enabled;
        config.autoTrade.binanceDelisting = real.delisting;
    }
});

test('trader longs Binance spot listings only, never futures launches / unknown scope', async () => {
    const trader = require('../../modules/automation/lightning-trader');
    const real = { enabled: config.autoTrade.enabled, listing: config.autoTrade.binanceListing, pm: trader.positionManager, entry: trader.binance.trading.marketEntry, skip: trader.fastModeSkipTradableCheck, isolated: trader.binance.isIsolatedCached, getLev: trader.binance.getLeverageCached };
    config.autoTrade.enabled = true;
    config.autoTrade.binanceListing = true;
    trader.positionManager = { positions: new Map() };
    trader.binance.isIsolatedCached = () => true;
    trader.binance.getLeverageCached = () => config.strategies.binanceListing.leverage; // no leverage call
    trader.fastModeSkipTradableCheck = true;
    const ordered = [];
    trader.binance.trading.marketEntry = async (symbol, side) => { ordered.push([symbol, side]); throw new Error('stop'); };
    try {
        const base = { exchange: 'BINANCE', category: 'LISTING', releaseDate: Date.now() };
        assert.strictEqual(await trader.executeLight({ ...base, listingScope: 'FUTURES', title: 'Binance Futures Will Launch USDⓈ-M FET Perpetual Contracts', tokens: ['FET'] }), null);
        assert.strictEqual(await trader.executeLight({ ...base, title: 'no scope (old monitor)', tokens: ['FET'] }), null);
        assert.deepStrictEqual(ordered, [], 'no order for futures launches / unknown listings');

        await trader.executeLight({ ...base, listingScope: 'SPOT', title: 'Binance Will List Celestia (TIA) with Seed Tag Applied', tokens: ['TIA'] }).catch(() => {});
        assert.deepStrictEqual(ordered, [['TIAUSDT', 'BUY']]);
    } finally {
        trader.binance.trading.marketEntry = real.entry;
        trader.binance.isIsolatedCached = real.isolated;
        trader.binance.getLeverageCached = real.getLev;
        trader.positionManager = real.pm;
        trader.fastModeSkipTradableCheck = real.skip;
        config.autoTrade.enabled = real.enabled;
        config.autoTrade.binanceListing = real.listing;
    }
});

test('trader presets the leverage of the most latency-sensitive ENABLED strategy only', () => {
    const trader = require('../../modules/automation/lightning-trader');
    const keys = ['binanceListing', 'upbitListing', 'bithumbListing', 'upbitWarning', 'upbitDelisting', 'binanceDelisting', 'upbitListingShort'];
    const real = Object.fromEntries(keys.map(k => [k, config.autoTrade[k]]));
    const set = on => keys.forEach(k => { config.autoTrade[k] = on.includes(k); });
    try {
        // VPS 2026-10-22: Binance listing + delist on, Upbit profiles (x20) off -> the listing's leverage
        set(['binanceListing', 'binanceDelisting']);
        assert.strictEqual(trader.presetProfile().leverage, config.strategies.binanceListing.leverage);
        set(['binanceDelisting', 'upbitListingShort']);
        assert.strictEqual(trader.presetProfile().leverage, config.strategies.binanceDelisting.leverage, 'disabled profiles never count');
        set(['upbitListing', 'binanceDelisting']);
        assert.strictEqual(trader.presetProfile().leverage, config.autoTrade.leverage, 'Upbit listing LONG uses the default profile');
        set([]);
        assert.strictEqual(trader.presetProfile().leverage, config.autoTrade.leverage);
    } finally {
        keys.forEach(k => { config.autoTrade[k] = real[k]; });
    }
});

test('upbit: release date is the ORIGINAL publication time (edits do not refresh it)', () => {
    resetStorage();
    upbit.seenKeys = new Set();
    const a = upbit.processAnnouncement({ id: 6645, uuid: 'u6645', title: '카이아(KAIA) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)', first_listed_at: '2026-10-09T17:06:46+09:00', listed_at: '2026-10-09T18:23:09+09:00' });
    assert.strictEqual(a.releaseDate, new Date('2026-10-09T17:06:46+09:00').getTime());
});

// ==================== STORAGE ====================

test('storage: concurrent saves are serialized and the file ends with the latest state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-test-'));
    const file = path.join(dir, 's.json');
    const state = { n: 0 };

    const saves = [];
    for (let i = 1; i <= 20; i++) {
        state.n = i;
        saves.push(storage._saveFile(file, () => state, 'Test'));
    }
    await Promise.all(saves);

    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 20 });
    assert.ok(!fs.existsSync(`${file}.tmp`));
    fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`✅ ${name}`);
        } catch (error) {
            failed++;
            console.log(`❌ ${name}\n   ${error.message}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
