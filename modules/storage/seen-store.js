const fs = require('fs');
const path = require('path');

/**
 * Persistent "already seen" set for announcement ids/keys (one JSON file per crawler), so a
 * restart does not treat old notices as new (re-alerting them, or worse, trading them).
 * Keeps the most recent `maxEntries` keys; writes are debounced and atomic (tmp + rename).
 * SEEN_STORE_DISABLED=true turns it into an in-memory set (tests).
 */
class SeenStore {
    constructor(file, { maxEntries = 5000, debounceMs = 1000 } = {}) {
        this.file = file;
        this.maxEntries = maxEntries;
        this.debounceMs = debounceMs;
        this.disabled = String(process.env.SEEN_STORE_DISABLED || '').toLowerCase() === 'true';
        this.set = new Set();
        this.timer = null;
        this._load();
    }

    _load() {
        if (this.disabled || !this.file) return;
        try {
            const keys = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (Array.isArray(keys)) keys.forEach(k => this.set.add(String(k)));
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn(`⚠️ [SEEN] ${path.basename(this.file)} unreadable (${error.message}) - starting empty`);
        }
    }

    has(key) {
        return this.set.has(String(key));
    }

    add(key) {
        key = String(key);
        if (this.set.has(key)) return;
        this.set.add(key);
        if (this.set.size > this.maxEntries) {
            // Set iterates in insertion order: drop the oldest
            const excess = this.set.size - this.maxEntries;
            let i = 0;
            for (const k of this.set) {
                if (i++ >= excess) break;
                this.set.delete(k);
            }
        }
        this._scheduleSave();
    }

    _scheduleSave() {
        if (this.disabled || !this.file || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.debounceMs);
        if (this.timer.unref) this.timer.unref();
    }

    flush() {
        if (this.disabled || !this.file) return;
        try {
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify([...this.set]), 'utf8');
            fs.renameSync(tmp, this.file);
        } catch (error) {
            console.error(`❌ [SEEN] save ${path.basename(this.file)} failed: ${error.message}`);
        }
    }
}

module.exports = { SeenStore };
