/**
 * Exports every Binance (catalog 48 New Listing, 161 Delisting) and Upbit (category "거래")
 * announcement published since --from (default: Jan 1 of this year, GMT+7) with the detail
 * page parsed: tokens, markets, key times (open/close trading, deposit/withdrawal stop...).
 *
 * Requests go round-robin over the egress IPs of UPBIT_PROXIES / UPBIT_PROXIES_FILE
 * (+ direct), each IP respecting its own spacing and 429/418 cooldown (ProxyPool).
 * Responses are cached in data/reports/.cache, so a re-run (or a resume after an error) is cheap.
 *
 *   node scripts/report/export-announcements.js [--from 2026-01-01] [--no-cache]
 *
 * Output (data/reports/): announcements-<from>_<to>.json (full, incl. body text),
 * binance-*.csv, upbit-*.csv (UTF-8 BOM, opens in Excel), summary-*.md
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config/config');
const { ProxyPool } = require('../../modules/monitoring/proxy-pool');

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'reports');
const CACHE_DIR = path.join(OUT_DIR, '.cache');
const BINANCE_LIST = 'https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query';
const BINANCE_DETAIL = 'https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query';
const UPBIT_LIST = 'https://api-manager.upbit.com/api/v1/announcements';
const BINANCE_CATALOGS = { 48: 'New Cryptocurrency Listing', 161: 'Delisting' };
const UPBIT_MARKET_CODES = new Set(['KRW', 'BTC', 'USDT']);
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', Accept: 'application/json', lang: 'en' };

const args = process.argv.slice(2);
const argValue = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const FROM = argValue('--from') || `${new Date().getFullYear()}-01-01`;
const FROM_MS = new Date(`${FROM}T00:00:00+07:00`).getTime();
const USE_CACHE = !args.includes('--no-cache');
// List pages change over time (new notices push old ones down): cache them briefly only.
const LIST_CACHE_TTL_MS = 30 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fmtTz = (ms, offsetH) => new Date(ms + offsetH * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const vn = ms => fmtTz(ms, 7);
const kst = ms => fmtTz(ms, 9);

// ==================== HTTP over the proxy pool ====================

const egressList = config.exchanges.upbit.proxies;
// Upbit: Cloudflare limit per IP (~0.1 req/s measured). Binance's CMS is far looser.
const upbitPool = new ProxyPool(egressList, {
    minIntervalMs: config.exchanges.upbit.perIpMinIntervalMs,
    backoffMs: config.exchanges.upbit.rateLimitBackoffMs,
    headers: HEADERS,
    timeout: 20000
});
const binancePool = new ProxyPool(egressList, { minIntervalMs: 1500, backoffMs: 60000, headers: HEADERS, timeout: 20000 });

const stats = { requests: 0, cacheHits: 0, retries: 0 };

function cacheFile(url) {
    return path.join(CACHE_DIR, crypto.createHash('md5').update(url).digest('hex') + '.json');
}

async function getJson(pool, url, { ttlMs = Infinity } = {}) {
    const file = cacheFile(url);
    if (USE_CACHE && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < ttlMs) {
        stats.cacheHits++;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    for (let attempt = 0; attempt < 12; attempt++) {
        let egress = pool.acquire();
        while (!egress) {
            await sleep(200);
            egress = pool.acquire();
        }
        const startedAt = Date.now();
        try {
            stats.requests++;
            const { data } = await egress.client.get(url);
            if (data?.success === false) throw Object.assign(new Error('success=false'), { status: 'API' });
            pool.reportSuccess(egress, Date.now() - startedAt);
            fs.writeFileSync(file, JSON.stringify(data));
            return data;
        } catch (error) {
            const status = error.response?.status || error.status;
            pool.reportError(egress, status);
            if (status === 404) throw new Error(`404 ${url}`);
            stats.retries++;
            console.warn(`  ⚠️ ${egress.id} ${status || error.code || error.message} - retry ${attempt + 1}`);
            await sleep(500);
        }
    }
    throw new Error(`Giving up after 12 attempts: ${url}`);
}

/** Runs fn over items with `concurrency` workers; the pool itself paces the requests. */
async function mapLimit(items, concurrency, fn, label) {
    const results = new Array(items.length);
    let next = 0, done = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            try {
                results[i] = await fn(items[i], i);
            } catch (error) {
                console.error(`  ❌ ${label} #${i}: ${error.message}`);
                results[i] = null;
            }
            if (++done % 20 === 0 || done === items.length) console.log(`  ${label}: ${done}/${items.length}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}

// ==================== text helpers ====================

const decodeEntities = s => String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Binance detail body is a JSON node tree ({node, tag, child, text}); flatten to plain text. */
function binanceBodyToText(body) {
    let root;
    try { root = typeof body === 'string' ? JSON.parse(body) : body; } catch { return String(body || ''); }
    const BLOCK = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'br', 'tr', 'ul', 'ol', 'table']);
    const walk = node => {
        if (!node) return '';
        if (node.node === 'text') return node.text || '';
        const inner = (node.child || []).map(walk);
        if (node.tag === 'tr') return inner.map(s => s.trim()).filter(Boolean).join(' | ') + '\n';
        if (node.tag === 'td' || node.tag === 'th') return inner.join('') + ' ';
        if (node.tag === 'li') return '- ' + inner.join('') + '\n';
        if (node.tag === 'a' && node.attr?.href && !/^https?:\/\/(www\.)?binance\.com/.test(node.attr.href)) {
            return inner.join('');
        }
        return inner.join('') + (BLOCK.has(node.tag) ? '\n' : '');
    };
    return decodeEntities(walk(root)).replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Upbit body is markdown with embedded HTML tables: one " | " joined line per table row. */
function upbitBodyToText(body) {
    return decodeEntities(String(body || '')
        .replace(/<\/t[hd]>\s*/gi, ' | ')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
        .split('\n').map(line => line.trim().replace(/\s*\|\s*$/, '')).filter(Boolean).join('\n');
}

/**
 * First table whose header has the given columns (Upbit listing table:
 * 디지털 자산 | 마켓 | 네트워크 | 입출금 개시 시점 | 거래지원 개시 시점) → array of {header: cell}.
 */
function upbitTable(body, requiredHeader) {
    for (const table of String(body || '').match(/<table[\s\S]*?<\/table>/gi) || []) {
        const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(row =>
            (row.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(cell => decodeEntities(cell.replace(/<[^>]+>/g, '')).trim()));
        if (rows.length < 2 || !rows[0].includes(requiredHeader)) continue;
        return rows.slice(1).map(cells => Object.fromEntries(rows[0].map((h, i) => [h, cells[i] || ''])));
    }
    return [];
}

const DATE_RE = /\b20\d{2}[-./]\d{1,2}[-./]\d{1,2}\b|\d{1,2}월\s*\d{1,2}일/;
/** Lines that carry a dated event (trading open/close, deposit/withdrawal stop, ...). */
function keyTimeLines(text, tzRe) {
    return [...new Set(text.split('\n')
        .map(line => line.replace(/^[-*#\s]+/, '').trim())
        .filter(line => DATE_RE.test(line) && tzRe.test(line) && line.length <= 400))];
}

const csvCell = value => {
    const s = Array.isArray(value) ? value.join(' || ') : String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (file, columns, rows) => {
    const lines = [columns.map(c => c.header).join(',')];
    for (const row of rows) lines.push(columns.map(c => csvCell(row[c.key])).join(','));
    fs.writeFileSync(file, '﻿' + lines.join('\n') + '\n');
};

// ==================== Binance ====================

const BINANCE_TOKEN_BLACKLIST = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR', 'BRL', 'UTC', 'USD', 'API', 'VIP', 'ETF', 'NFT', 'AI']);

function binanceType(title, catalogId) {
    const t = title;
    if (catalogId === 161) {
        if (/monitoring tag|seed tag/i.test(t)) return 'TAG_CHANGE';
        if (/alpha will remove/i.test(t)) return 'ALPHA_REMOVE';
        if (/stocks?\b/i.test(t)) return 'STOCKS_DELIST';
        if (/futures.*(delist|close)|perpetual contract.*(delist|close)|(delist|close).*perpetual/i.test(t)) return 'FUTURES_DELIST';
        if (/margin/i.test(t) && /delist|remov/i.test(t)) return 'MARGIN_DELIST';
        if (/will delist\b.+\bon\s+\d{4}-\d{2}-\d{2}/i.test(t)) return 'SPOT_DELIST';
        if (/remov.*(trading pairs|spot)|delist.*(trading pairs)/i.test(t)) return 'PAIR_REMOVAL';
        if (/convert|earn|loan|copy trading|bots?\b|simple earn|vip loan/i.test(t)) return 'PRODUCT_DELIST';
        if (/delist|remov|cease|discontinu/i.test(t)) return 'DELIST_OTHER';
        return 'DELIST_RELATED';
    }
    if (/hodler airdrops?/i.test(t)) return 'HODLER_AIRDROP';
    if (/launchpool|megadrop|launchpad/i.test(t)) return 'LAUNCHPOOL';
    if (/alpha/i.test(t) && !/will list/i.test(t)) return 'ALPHA';
    if (/bstocks|tokenized securit|stock trading/i.test(t)) return 'STOCKS';
    if (/^binance futures will (launch|list)|perpetual contract|delivery contract/i.test(t)) return 'FUTURES_LISTING';
    if (/pre-market/i.test(t)) return 'PRE_MARKET';
    if (/will list\b/i.test(t)) return /seed tag/i.test(t) ? 'SPOT_LISTING_SEED' : 'SPOT_LISTING';
    if (/trading pairs?/i.test(t) && /add/i.test(t)) return 'NEW_PAIRS';
    if (/margin/i.test(t)) return 'MARGIN_ADD';
    if (/earn|convert|buy crypto|loan|collateral|copy trading|bots?\b/i.test(t)) return 'PRODUCT_ADD';
    return 'LISTING_OTHER';
}

function binanceTokens(title, bodyText) {
    const tokens = new Set();
    for (const m of title.matchAll(/\(([A-Z0-9]{1,12})\)/g)) tokens.add(m[1]);
    for (const m of title.matchAll(/\b([A-Z0-9]{2,12})(USDT|USDC|USD1|FDUSD|BTC|BNB|TRY)\b/g)) tokens.add(m[1]);
    const delist = title.match(/\bdelist\s+(.+?)\s+on\s+\d{4}-\d{2}-\d{2}/i);
    if (delist) {
        for (const part of delist[1].split(/\s*(?:,|&|\band\b)\s*/i)) {
            if (/^[A-Z0-9]{2,12}$/.test(part.trim())) tokens.add(part.trim());
        }
    }
    // Multi-contract futures / margin / pair-removal notices name the tokens only in the body.
    if (tokens.size === 0 && bodyText) {
        // "2026-10-12 09:00 (UTC): ZCSHUSDT USDT-Priced Perpetual Contract", "USDⓈ-M PROMPTUSDT, PUMPBTCUSDT and 1000000BOBUSDT"
        for (const line of bodyText.split('\n').filter(l => /perpetual|delivery/i.test(l) && /\(UTC\)/.test(l))) {
            for (const m of line.matchAll(/\b([A-Z0-9]{2,20}?)(USDT|USDC)\b/g)) tokens.add(m[1]);
        }
        // "- REQ (Request Network)" bullet lists (margin / loans delist)
        for (const m of bodyText.matchAll(/^- ([A-Z0-9]{2,12}) \([^)]+\)\s*$/gm)) tokens.add(m[1]);
        for (const m of bodyText.matchAll(/\b([A-Z0-9]{2,12})\/(USDT|USDC|FDUSD|BTC|BNB|ETH|TRY|EUR|BRL)\b/g)) tokens.add(m[1]);
    }
    return [...tokens].filter(t => !BINANCE_TOKEN_BLACKLIST.has(t) && !/^\d+$/.test(t));
}

function binancePairs(bodyText) {
    return [...new Set([...bodyText.matchAll(/\b([A-Z0-9]{2,12}\/(?:USDT|USDC|FDUSD|BTC|BNB|ETH|TRY|EUR|BRL|JPY|USD1))\b/g)].map(m => m[1]))];
}

async function fetchBinance() {
    const articles = [];
    for (const catalogId of Object.keys(BINANCE_CATALOGS).map(Number)) {
        for (let pageNo = 1; ; pageNo++) {
            const data = await getJson(binancePool, `${BINANCE_LIST}?type=1&pageNo=${pageNo}&pageSize=50&catalogId=${catalogId}`, { ttlMs: LIST_CACHE_TTL_MS });
            const page = data?.data?.catalogs?.[0]?.articles || [];
            const inRange = page.filter(a => a.releaseDate >= FROM_MS);
            articles.push(...inRange.map(a => ({ ...a, catalogId })));
            console.log(`  Binance catalog ${catalogId} page ${pageNo}: ${page.length} articles, ${inRange.length} in range`);
            // Newest first: stop once a page reaches before FROM.
            if (page.length < 50 || inRange.length < page.length) break;
        }
    }
    console.log(`Binance: ${articles.length} articles since ${FROM}, fetching details...`);

    return (await mapLimit(articles, 6, async a => {
        const detail = (await getJson(binancePool, `${BINANCE_DETAIL}?articleCode=${a.code}`))?.data || {};
        const bodyText = binanceBodyToText(detail.body);
        const delistOn = a.title.match(/\bon\s+(\d{4}-\d{2}-\d{2})/i)?.[1] || '';
        return {
            exchange: 'BINANCE',
            catalog: BINANCE_CATALOGS[a.catalogId],
            type: binanceType(a.title, a.catalogId),
            releaseMs: a.releaseDate,
            releaseVn: vn(a.releaseDate),
            releaseUtc: fmtTz(a.releaseDate, 0),
            title: a.title,
            tokens: binanceTokens(a.title, bodyText),
            pairs: binancePairs(bodyText),
            dateInTitle: delistOn,
            keyTimes: keyTimeLines(bodyText, /\bUTC\b/),
            lastUpdateVn: detail.lastUpdateTime ? vn(detail.lastUpdateTime) : '',
            url: `https://www.binance.com/en/support/announcement/${a.code}`,
            bodyText
        };
    }, 'Binance detail')).filter(Boolean).sort((x, y) => y.releaseMs - x.releaseMs);
}

// ==================== Upbit ====================

// Same rules as UpbitMonitor.categorize, plus the non-tradeable notice families for review.
function upbitType(title) {
    const c = String(title || '').replace(/\s+/g, '');
    if (c.includes('신규거래지원안내') || c.includes('디지털자산추가')) return 'LISTING';
    // "...KRW 마켓 거래지원 종료(10/10 18:00) 및 ..." (2023 wording, one market only)
    if (c.includes('거래지원종료안내') || c.includes('거래지원종료및') || /거래지원종료\(\d/.test(c)) return 'DELISTING';
    // Until late 2024 Upbit wrote "유의 종목 지정" without 거래 (PLA, LINA, FOR 2024-10-29).
    if (c.includes('유의종목지정')) {
        if (c.includes('해제')) return 'WARNING_LIFTED';
        if (c.includes('연장')) return 'WARNING_EXTENDED';
        return 'WARNING';
    }
    if (c.includes('유의촉구')) return 'CAUTION';
    if (c.includes('거래지원개시시점') || c.includes('시점변경')) return 'LISTING_SCHEDULE_CHANGE';
    if (c.includes('입출금') || c.includes('네트워크')) return 'DEPOSIT_WITHDRAWAL';
    if (c.includes('스왑') || c.includes('리브랜딩') || c.includes('티커변경') || c.includes('명칭변경')) return 'SWAP_REBRAND';
    if (c.includes('에어드랍') || c.includes('에어드롭')) return 'AIRDROP';
    return 'OTHER';
}

function upbitTokens(title) {
    const tokens = [];
    for (const match of String(title || '').matchAll(/\(([^()]+)\)/g)) {
        const items = match[1].split(',').map(item => item.trim());
        if (items.length === 0 || !items.every(item => /^[A-Z0-9]{1,15}$/.test(item))) continue;
        tokens.push(...items.filter(item => !UPBIT_MARKET_CODES.has(item)));
    }
    return [...new Set(tokens)];
}

function upbitMarkets(title, bodyText) {
    const fromTitle = String(title).match(/((?:KRW|BTC|USDT)(?:\s*,\s*(?:KRW|BTC|USDT))*)\s*마켓/);
    const source = fromTitle ? fromTitle[1] : (bodyText.match(/((?:KRW|BTC|USDT)(?:\s*,\s*(?:KRW|BTC|USDT))*)\s*마켓/) || [])[1];
    return source ? [...new Set(source.split(/\s*,\s*/))] : [];
}

/** First paragraph(s) after a "사유" heading — the stated reason for a delist/warning. */
function upbitReason(bodyText) {
    const lines = bodyText.split('\n');
    const i = lines.findIndex(line => /사유/.test(line) && line.length < 60);
    if (i < 0) return '';
    return lines.slice(i + 1).map(l => l.replace(/^[-#\s]+/, '').trim()).filter(Boolean)
        .filter(l => !/^#/.test(l)).slice(0, 6).join(' ').slice(0, 800);
}

/**
 * An edited Upbit notice stacks its updates on top of the original, separated by "---",
 * newest first, each starting with "> 업데이트 일자 : 2026-06-19 17:55". The original table
 * keeps the FIRST schedule, so the real one comes from replaying the updates oldest → newest:
 *   "## LDO, PAXG 거래지원 개시 시점 변경 안내" / "- 변경된 거래지원 개시 시점 : 2026-06-20 10:00 KST"
 *   "헤미(HEMI)의 거래지원 취소를 안내드립니다" (listing cancelled)
 *   "- 변경된 거래지원 종료 예정일 : 2026-09-01(화) 09:00 KST" (delist moved)
 */
function upbitSchedule(bodyText, titleTokens, listingRows) {
    const tickerOf = asset => (String(asset).match(/\(([A-Z0-9]{1,15})\)/) || [])[1] || String(asset).trim();
    // The table may name the old ticker of a renamed symbol: 앰프(AMP) listed as AMP2, title says AMP2.
    const alias = t => titleTokens.includes(t) ? t : (titleTokens.find(tt => new RegExp(`^${t}\\d+$`).test(tt)) || t);
    const start = new Map(listingRows.map(r => [alias(tickerOf(r['디지털 자산'])), r['거래지원 개시 시점']]));
    const known = [...new Set([...titleTokens, ...start.keys()])];
    const mentioned = text => known.filter(t => new RegExp(`(^|[^A-Z0-9])${t}([^A-Z0-9]|$)`).test(text));

    const blocks = bodyText.split(/\n---\n/);
    const updates = blocks.slice(0, -1).map(block => {
        const date = (block.match(/업데이트\s*일자\s*:?\s*([\d-]+\s*[\d:]*)/) || [])[1] || '';
        const summary = block.split('\n').find(l => !/업데이트\s*일자|^안녕하세요/.test(l) && l.length > 5) || '';
        return `${date.trim()} ${summary.trim()}`.trim();
    }).reverse();

    const cancelled = new Set();
    let changed = false;
    let delistAt = '';
    // Replay oldest → newest so the latest update wins. The original notice is the last block.
    for (const block of blocks.slice().reverse()) {
        const isUpdate = block !== blocks[blocks.length - 1];
        let scope = null;
        for (const line of block.split('\n')) {
            if (/^#/.test(line) && mentioned(line).length) scope = mentioned(line);
            // "정정 후 : 5월 13일 20시 30분 예정" = schedule typo corrected
            const startChange = line.match(/^-?\s*(?:(?:변경(?:된)?\s*)?거래지원\s*개시\s*시점|정정\s*후)\s*:\s*(.+)$/);
            if (isUpdate && startChange && !/기존/.test(line)) {
                for (const t of scope || (mentioned(block).length ? mentioned(block) : known)) start.set(t, startChange[1].trim());
                changed = true;
            }
            if (isUpdate && /거래지원(?:을|이)?\s*(?:취소|개시하지\s*않기로)/.test(line)) {
                for (const t of mentioned(line).length ? mentioned(line) : (scope || known)) cancelled.add(t);
            }
            const end = line.match(/^-?\s*(?:변경(?:된)?\s*)?거래지원\s*종료\s*(?:예정일|일시|시점)\s*:\s*(.+)$/);
            if (end && !/기존/.test(line)) delistAt = end[1].trim();
            const endSentence = line.match(/(\d{4}-\d{2}-\d{2}\([^)]*\)\s*\d{1,2}:\d{2}\s*KST)\s*에\s*(?:거래지원을\s*)?종료/);
            if (!delistAt && endSentence) delistAt = endSentence[1];
        }
    }

    const tradingStartFinal = known.filter(t => start.has(t) || cancelled.has(t))
        .map(t => `${t}: ${cancelled.has(t) ? 'CANCELLED' : start.get(t)}`);
    return { tradingStartFinal, scheduleChanged: changed, cancelledTokens: [...cancelled], delistAt, updates };
}

/** "거래 유의 종목 지정 기간 : 2026년 10월 13일(화) 15:00 KST ~ 2026년 10월 5주차(...)" / "연장 기간 : ~ ..." */
function upbitWarningPeriod(bodyText) {
    const lifted = bodyText.match(/(\d{4}년\s*\d{1,2}월\s*\d{1,2}일)\s*\S+\s*유의\s*종목\s*지정을?\s*해제/);
    if (lifted) return `해제 ${lifted[1]}`;
    return (bodyText.match(/(?:지정|연장)\s*기간\s*:\s*(.+)/) || [])[1]?.trim() || '';
}

async function fetchUpbit() {
    const notices = [];
    for (let page = 1; ; page++) {
        const data = await getJson(upbitPool, `${UPBIT_LIST}?os=web&page=${page}&per_page=20&category=trade`, { ttlMs: LIST_CACHE_TTL_MS });
        const list = data?.data?.notices || [];
        const published = n => new Date(n.first_listed_at || n.listed_at).getTime();
        const inRange = list.filter(n => published(n) >= FROM_MS);
        notices.push(...inRange);
        console.log(`  Upbit page ${page}/${data?.data?.total_pages}: ${list.length} notices, ${inRange.length} in range`);
        // Sorted by listed_at (moves on edit), not by first publication: continue while any notice is in range.
        if (list.length === 0 || inRange.length === 0) break;
    }
    const unique = [...new Map(notices.map(n => [n.id, n])).values()];
    console.log(`Upbit: ${unique.length} notices since ${FROM}, fetching details (${upbitPool.size} IPs, ~${Math.ceil(unique.length * config.exchanges.upbit.perIpMinIntervalMs / upbitPool.size / 1000)}s without cache)...`);

    return (await mapLimit(unique, upbitPool.size, async n => {
        const detail = (await getJson(upbitPool, `${UPBIT_LIST}/${n.id}`))?.data || {};
        const bodyText = upbitBodyToText(detail.body);
        const publishedMs = new Date(n.first_listed_at || n.listed_at).getTime();
        const updatedMs = new Date(n.listed_at).getTime();
        // Listing table; times have no year ("10월 12일 19시 30분 예정") — kept verbatim.
        const listingRows = upbitTable(detail.body, '거래지원 개시 시점');
        const col = key => [...new Set(listingRows.map(r => r[key]).filter(Boolean))];
        const type = upbitType(n.title);
        const tokens = upbitTokens(n.title);
        const schedule = upbitSchedule(bodyText, tokens, listingRows);
        return {
            exchange: 'UPBIT',
            id: n.id,
            type,
            releaseMs: publishedMs,
            publishedKst: kst(publishedMs),
            publishedVn: vn(publishedMs),
            updatedKst: updatedMs !== publishedMs ? kst(updatedMs) : '',
            title: n.title,
            tokens,
            markets: col('마켓').length ? [...new Set(col('마켓').join(',').split(/\s*,\s*/))] : upbitMarkets(n.title, bodyText),
            assets: col('디지털 자산'),
            network: col('네트워크'),
            depositOpen: col('입출금 개시 시점'),
            // As first announced (original table) vs after replaying the updates.
            tradingStart: col('거래지원 개시 시점'),
            tradingStartFinal: schedule.tradingStartFinal,
            scheduleChanged: schedule.scheduleChanged,
            cancelledTokens: schedule.cancelledTokens,
            delistAt: schedule.delistAt,
            warningPeriod: /^WARNING/.test(type) ? upbitWarningPeriod(bodyText) : '',
            updates: schedule.updates,
            // Warning lift / caution notices date events without a time ("2026년 9월 22일").
            keyTimes: keyTimeLines(bodyText, /./),
            reason: ['DELISTING', 'WARNING', 'CAUTION', 'WARNING_LIFTED', 'WARNING_EXTENDED'].includes(type) ? upbitReason(bodyText) : '',
            url: `https://upbit.com/service_center/notice?id=${n.id}`,
            bodyText
        };
    }, 'Upbit detail')).filter(Boolean).sort((x, y) => y.releaseMs - x.releaseMs);
}

// ==================== report ====================

function summaryMarkdown(binance, upbit, to) {
    const count = (rows, key) => rows.reduce((m, r) => (m[r[key]] = (m[r[key]] || 0) + 1, m), {});
    const table = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
    const month = r => r.releaseVn ? r.releaseVn.slice(0, 7) : r.publishedVn.slice(0, 7);
    const byMonth = (rows, types) => {
        const months = [...new Set(rows.map(month))].sort();
        return `| Month | ${types.join(' | ')} |\n|---|${types.map(() => '---:').join('|')}|\n` + months.map(m =>
            `| ${m} | ${types.map(t => rows.filter(r => month(r) === m && r.type === t).length).join(' | ')} |`).join('\n');
    };
    const list = (rows, type, timeKey) => rows.filter(r => r.type === type)
        .map(r => `| ${r[timeKey]} | ${r.tokens.join(', ') || '-'} | ${(r.markets || r.pairs || []).slice(0, 8).join(', ')} | [${r.title.replace(/\|/g, '/')}](${r.url}) |`).join('\n');
    const upbitRows = (rows, type, extra) => rows.filter(r => r.type === type)
        .map(r => `| ${r.publishedKst} | ${r.tokens.join(', ') || '-'} | ${r.markets.join(', ')} | ${String(extra(r)).replace(/\|/g, '/')} | [${r.title.replace(/\|/g, '/')}](${r.url}) |`).join('\n');

    return `# Binance & Upbit listing / delisting — ${FROM} → ${to} (GMT+7)

Generated ${vn(Date.now())} GMT+7. Binance: ${binance.length} articles · Upbit: ${upbit.length} notices.
Times: Binance in GMT+7 (UTC in CSV), Upbit in KST (GMT+9, GMT+7 in CSV).

## Binance — by type
| Type | Count |
|---|---:|
${table(count(binance, 'type'))}

${byMonth(binance, ['SPOT_LISTING', 'SPOT_LISTING_SEED', 'FUTURES_LISTING', 'SPOT_DELIST', 'FUTURES_DELIST', 'MARGIN_DELIST'])}

## Upbit — by type
| Type | Count |
|---|---:|
${table(count(upbit, 'type'))}

${byMonth(upbit, ['LISTING', 'DELISTING', 'WARNING', 'WARNING_LIFTED', 'CAUTION'])}

## Binance spot listings
| Released (GMT+7) | Tokens | Pairs | Title |
|---|---|---|---|
${list(binance, 'SPOT_LISTING', 'releaseVn')}
${list(binance, 'SPOT_LISTING_SEED', 'releaseVn')}

## Binance futures listings
| Released (GMT+7) | Tokens | Pairs | Title |
|---|---|---|---|
${list(binance, 'FUTURES_LISTING', 'releaseVn')}

## Binance spot delistings
| Released (GMT+7) | Tokens | Pairs | Title |
|---|---|---|---|
${list(binance, 'SPOT_DELIST', 'releaseVn')}

## Binance futures delistings
| Released (GMT+7) | Tokens | Pairs | Title |
|---|---|---|---|
${list(binance, 'FUTURES_DELIST', 'releaseVn')}

## Upbit listings
Trading start = final schedule after the notice's updates (⚠️ = changed, CANCELLED = listing called off).

| Published (KST) | Tokens | Markets | Trading start (KST) | Title |
|---|---|---|---|---|
${upbitRows(upbit, 'LISTING', r => `${r.scheduleChanged || r.cancelledTokens.length ? '⚠️ ' : ''}${r.tradingStartFinal.join('; ') || '-'}`)}

## Upbit delistings
| Published (KST) | Tokens | Markets | Trading ends (KST) | Title |
|---|---|---|---|---|
${upbitRows(upbit, 'DELISTING', r => r.delistAt || '-')}

## Upbit investment warnings (거래 유의 종목 지정)
| Published (KST) | Tokens | Markets | Warning period | Title |
|---|---|---|---|---|
${upbitRows(upbit, 'WARNING', r => r.warningPeriod || '-')}
`;
}

async function main() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`Export since ${FROM} (GMT+7) via ${egressList.length} egress IP(s), cache ${USE_CACHE ? 'on' : 'off'}`);

    const [binance, upbit] = await Promise.all([fetchBinance(), fetchUpbit()]);
    const to = vn(Date.now()).slice(0, 10);
    const base = `${FROM}_${to}`;

    fs.writeFileSync(path.join(OUT_DIR, `announcements-${base}.json`), JSON.stringify({
        generatedAt: new Date().toISOString(), from: FROM, to, binance, upbit
    }, null, 2));

    writeCsv(path.join(OUT_DIR, `binance-${base}.csv`), [
        { key: 'releaseVn', header: 'released_gmt7' }, { key: 'releaseUtc', header: 'released_utc' },
        { key: 'catalog', header: 'catalog' }, { key: 'type', header: 'type' },
        { key: 'tokens', header: 'tokens' }, { key: 'pairs', header: 'pairs' },
        { key: 'dateInTitle', header: 'date_in_title' }, { key: 'title', header: 'title' },
        { key: 'keyTimes', header: 'key_times_utc' }, { key: 'lastUpdateVn', header: 'last_update_gmt7' },
        { key: 'url', header: 'url' }
    ], binance);
    writeCsv(path.join(OUT_DIR, `upbit-${base}.csv`), [
        { key: 'publishedKst', header: 'published_kst' }, { key: 'publishedVn', header: 'published_gmt7' },
        { key: 'updatedKst', header: 'updated_kst' }, { key: 'type', header: 'type' },
        { key: 'tokens', header: 'tokens' }, { key: 'markets', header: 'markets' },
        { key: 'title', header: 'title' },
        { key: 'tradingStartFinal', header: 'trading_start_final_kst' }, { key: 'scheduleChanged', header: 'schedule_changed' },
        { key: 'cancelledTokens', header: 'cancelled_tokens' }, { key: 'tradingStart', header: 'trading_start_original_kst' },
        { key: 'depositOpen', header: 'deposit_open' }, { key: 'network', header: 'network' },
        { key: 'delistAt', header: 'delist_at_kst' }, { key: 'warningPeriod', header: 'warning_period' },
        { key: 'updates', header: 'updates' }, { key: 'keyTimes', header: 'key_times' },
        { key: 'reason', header: 'reason' }, { key: 'url', header: 'url' }
    ], upbit);
    fs.writeFileSync(path.join(OUT_DIR, `summary-${base}.md`), summaryMarkdown(binance, upbit, to));

    console.log(`\n✅ Binance ${binance.length} | Upbit ${upbit.length} | requests ${stats.requests}, cache hits ${stats.cacheHits}, retries ${stats.retries}`);
    console.log(`Output: ${OUT_DIR}/*-${base}.*`);
    console.table(upbitPool.getHealth().map(h => ({ ip: h.id, ok: h.ok, errors: h.errors, rateLimited: h.rateLimited })));
}

main().catch(error => {
    console.error('❌ Export failed:', error.message);
    process.exit(1);
});
