const fs = require('fs');
const path = require('path');
const util = require('util');

/**
 * Mirrors console output to data/logs/bot-YYYY-MM-DD.log (data/ is a host volume in docker),
 * so detection / latency / trade lines survive container restarts and rebuilds.
 * Daily files; files older than LOG_RETENTION_DAYS are removed at startup.
 */
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'data', 'logs');
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 14;

let stream = null;
let streamDay = null;

function today() {
    return new Date().toISOString().slice(0, 10);
}

function getStream() {
    const day = today();
    if (stream && streamDay === day) return stream;
    if (stream) stream.end();
    stream = fs.createWriteStream(path.join(LOG_DIR, `bot-${day}.log`), { flags: 'a' });
    stream.on('error', () => { stream = null; });
    streamDay = day;
    return stream;
}

function cleanOldLogs() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const name of fs.readdirSync(LOG_DIR)) {
        if (!/^bot-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const file = path.join(LOG_DIR, name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
}

function install() {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        cleanOldLogs();
    } catch (error) {
        console.error(`⚠️ [FILE-LOG] disabled: ${error.message}`);
        return;
    }

    for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            try {
                const s = getStream();
                if (s) s.write(`${new Date().toISOString()} ${util.format(...args)}\n`);
            } catch (_) { /* logging must never break the bot */ }
        };
    }
}

module.exports = { install, LOG_DIR };
