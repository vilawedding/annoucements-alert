const fs = require('fs');
const path = require('path');

/**
 * One announcement can reach the bot from several sources (Binance REST, Upbit WS/REST, Bithumb REST,
 * the cryptolisting.ws socket). Each monitor only de-dups its own feed and the socket carries no
 * exchange id, so the first source to deliver wins here and later copies are dropped before any trade.
 *
 * Keys:
 * - title key (exchange + normalized title), kept TITLE_WINDOW_MS and persisted, so a restart between
 *   the socket and a slower crawler cannot trade the same notice twice. Windowed, not permanent:
 *   Upbit reuses the exact same title when it warns the same token again months later.
 * - token key (exchange + category + delist scope + token set), kept TOKEN_WINDOW_MS in memory, in case
 *   the socket title differs slightly from the exchange API title. The delist scope keeps a Binance
 *   spot delist and a futures delist of the same token on the same day apart.
 */
const TITLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOKEN_WINDOW_MS = 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 1000;

function normalizeTitle(title) {
    return String(title || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

class CrossSourceDedup {
    constructor(file) {
        this.file = file;
        this.disabled = String(process.env.SEEN_STORE_DISABLED || '').toLowerCase() === 'true';
        this.titles = new Map(); // key -> { at, source }
        this.tokens = new Map();
        this.timer = null;
        this._load();
    }

    _load() {
        if (this.disabled || !this.file) return;
        try {
            const entries = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const now = Date.now();
            for (const [key, value] of Object.entries(entries || {})) {
                if (value && now - value.at < TITLE_WINDOW_MS) this.titles.set(key, value);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn(`⚠️ [DEDUP] ${path.basename(this.file)} unreadable (${error.message}) - starting empty`);
        }
    }

    _titleKey(a) {
        return `${a.exchange}|${normalizeTitle(a.title)}`;
    }

    _tokenKey(a) {
        if (!Array.isArray(a.tokens) || a.tokens.length === 0) return null;
        return `${a.exchange}|${a.category}|${a.delistScope || ''}|${[...a.tokens].sort().join(',')}`;
    }

    _prune(now) {
        for (const [key, value] of this.titles) {
            if (now - value.at >= TITLE_WINDOW_MS) this.titles.delete(key);
        }
        for (const [key, value] of this.tokens) {
            if (now - value.at >= TOKEN_WINDOW_MS) this.tokens.delete(key);
        }
    }

    /**
     * Synchronous: claims the announcement for its source. Returns null when it is new,
     * or { source, agoMs } of the first delivery when it is a duplicate.
     */
    claim(a, source) {
        const now = Date.now();
        this._prune(now);

        const titleKey = this._titleKey(a);
        const tokenKey = this._tokenKey(a);
        const first = this.titles.get(titleKey) || (tokenKey && this.tokens.get(tokenKey));
        if (first) return { source: first.source, agoMs: now - first.at };

        const entry = { at: now, source };
        this.titles.set(titleKey, entry);
        if (tokenKey) this.tokens.set(tokenKey, entry);
        this._scheduleSave();
        return null;
    }

    _scheduleSave() {
        if (this.disabled || !this.file || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, SAVE_DEBOUNCE_MS);
        if (this.timer.unref) this.timer.unref();
    }

    flush() {
        if (this.disabled || !this.file) return;
        try {
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.titles)), 'utf8');
            fs.renameSync(tmp, this.file);
        } catch (error) {
            console.error(`❌ [DEDUP] save ${path.basename(this.file)} failed: ${error.message}`);
        }
    }
}

module.exports = { CrossSourceDedup, normalizeTitle };
