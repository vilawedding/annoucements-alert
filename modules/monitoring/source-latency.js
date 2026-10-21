const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('./cross-source-dedup');

/**
 * Every delivery of every announcement, by source (Binance REST / Binance WS / cryptolisting / Upbit
 * REST / Upbit WS ...), including the duplicates the cross-source dedup drops, so the sources can be
 * compared on real notices: who arrives first and by how much, and the lag after the exchange's own
 * publish time. One JSON line per delivery; `npm run report:latency` summarises the file.
 */
class SourceLatencyLog {
    constructor(file) {
        this.file = file;
        this.disabled = !file || String(process.env.SEEN_STORE_DISABLED || '').toLowerCase() === 'true';
        if (!this.disabled) fs.mkdirSync(path.dirname(file), { recursive: true });
    }

    record(a, source, firstSource) {
        if (this.disabled) return;
        const line = JSON.stringify({
            at: Date.now(),
            exchange: a.exchange,
            source,
            first: !firstSource,
            firstSource: firstSource || null,
            category: a.category,
            title: a.title,
            titleKey: `${a.exchange}|${normalizeTitle(a.title)}`,
            tokens: a.tokens || [],
            // The exchange's publish time when the source carries it (cryptolisting: its detection time)
            releaseDate: Number(a.releaseDate) || null,
            detectedAt: a.detectedAt || null
        });
        // Off the hot path: an append failure must never affect alerting or trading.
        fs.appendFile(this.file, line + '\n', () => {});
    }
}

module.exports = { SourceLatencyLog };
