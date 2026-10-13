/**
 * Per-exchange crawler health + throttled error logging.
 *
 * Monitors used to swallow every error silently, so a 403/429/404 left the bot
 * "running" but blind. This records the last success/error (exposed on the health
 * endpoint) and logs errors at most once per `logIntervalMs` per error key.
 */
class MonitorHealth {
    constructor(name, logIntervalMs = 60000) {
        this.name = name;
        this.logIntervalMs = logIntervalMs;
        this.lastLoggedAt = {};
        this.lastSuccessAt = null;
        this.lastErrorAt = null;
        this.lastError = null;
        this.errorCount = 0;
        this.consecutiveErrors = 0;
    }

    success() {
        this.lastSuccessAt = Date.now();
        this.consecutiveErrors = 0;
    }

    error(key, message) {
        const now = Date.now();
        this.lastErrorAt = now;
        this.lastError = `${key}: ${message}`;
        this.errorCount++;
        this.consecutiveErrors++;

        if (now - (this.lastLoggedAt[key] || 0) < this.logIntervalMs) return;
        this.lastLoggedAt[key] = now;
        console.error(`⚠️ [${this.name}] ${key}: ${message} (consecutiveErrors=${this.consecutiveErrors}, total=${this.errorCount})`);
    }

    toJSON() {
        return {
            lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
            lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
            lastError: this.lastError,
            errorCount: this.errorCount,
            consecutiveErrors: this.consecutiveErrors
        };
    }
}

function describeHttpError(error) {
    const status = error?.response?.status;
    return status ? `HTTP ${status}` : (error?.code || error?.message || String(error));
}

module.exports = { MonitorHealth, describeHttpError };
