// Which announcement source is fastest, from data/source_latency.jsonl (written by the bot for every
// delivery, duplicates included). Per exchange: how often each source arrived first, the lead over each
// other source, and each source's lag after the exchange's own publish time.
// Run: npm run report:latency [-- --days 7]
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 0;
const file = path.join(__dirname, '..', '..', 'data', 'source_latency.jsonl');
// cryptolisting.ws carries its own detection time, not the exchange's publish time
const NO_PUBLISH_TIME = new Set(['CRYPTOLISTING']);
const GROUP_WINDOW_MS = 10 * 60000;

if (!fs.existsSync(file)) {
    console.log(`No ${path.relative(process.cwd(), file)} yet: the bot writes it once announcements arrive.`);
    process.exit(0);
}
const since = days > 0 ? Date.now() - days * 86400e3 : 0;
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(r => r && r.at >= since)
    .sort((a, b) => a.at - b.at);

// One group per notice: same normalised title, or same exchange + category + tokens within 10 min
// (a source may word the title slightly differently).
const groups = [];
for (const r of rows) {
    const tokenKey = r.tokens.length ? `${r.exchange}|${r.category}|${[...r.tokens].sort().join(',')}` : null;
    let g = groups.find(x => x.exchange === r.exchange && r.at - x.firstAt < GROUP_WINDOW_MS
        && (x.titleKeys.has(r.titleKey) || (tokenKey && x.tokenKeys.has(tokenKey))));
    if (!g) {
        g = { exchange: r.exchange, title: r.title, firstAt: r.at, titleKeys: new Set(), tokenKeys: new Set(), bySource: new Map() };
        groups.push(g);
    }
    g.titleKeys.add(r.titleKey);
    if (tokenKey) g.tokenKeys.add(tokenKey);
    if (!g.bySource.has(r.source)) g.bySource.set(r.source, r);
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const fmt = ms => (Number.isFinite(ms) ? `${Math.round(ms)}ms` : '-');

console.log(`${rows.length} deliveries, ${groups.length} notices${days ? ` (last ${days} days)` : ''}\n`);
for (const exchange of [...new Set(groups.map(g => g.exchange))]) {
    const gs = groups.filter(g => g.exchange === exchange);
    const sources = [...new Set(gs.flatMap(g => [...g.bySource.keys()]))];
    console.log(`== ${exchange}: ${gs.length} notices, sources ${sources.join(', ')}`);

    for (const s of sources) {
        const seen = gs.filter(g => g.bySource.has(s));
        const first = seen.filter(g => [...g.bySource.values()].sort((a, b) => a.at - b.at)[0].source === s);
        // Lag after the publish time given by a source that carries it (official REST / WS)
        const lags = seen.map(g => {
            const pub = [...g.bySource.values()].filter(r => !NO_PUBLISH_TIME.has(r.source) && r.releaseDate).map(r => r.releaseDate);
            return pub.length ? g.bySource.get(s).at - Math.min(...pub) : NaN;
        }).filter(Number.isFinite);
        console.log(`  ${s.padEnd(14)} seen ${String(seen.length).padStart(3)} | first ${String(first.length).padStart(3)} | lag after publish: median ${fmt(median(lags))}, best ${fmt(Math.min(...lags))}, worst ${fmt(Math.max(...lags))}`);
    }

    for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
            const [a, b] = [sources[i], sources[j]];
            const both = gs.filter(g => g.bySource.has(a) && g.bySource.has(b));
            if (!both.length) continue;
            const d = both.map(g => g.bySource.get(b).at - g.bySource.get(a).at); // > 0: a earlier
            console.log(`  ${a} vs ${b}: ${both.length} common | ${a} first ${d.filter(x => x > 0).length}x | median lead of ${a} ${fmt(median(d))}`);
        }
    }

    console.log('  last notices:');
    for (const g of gs.slice(-5)) {
        const order = [...g.bySource.values()].sort((a, b) => a.at - b.at);
        console.log(`   ${new Date(g.firstAt).toISOString().slice(0, 19)} ${order.map(r => `${r.source}+${r.at - order[0].at}ms`).join(' ')} | ${g.title.slice(0, 70)}`);
    }
    console.log('');
}
