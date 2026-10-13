const fs = require('fs');
const path = require('path');

/**
 * Proxy list file: one proxy per line, so a provider's export can be pasted as-is.
 *
 * Accepted line formats (blank lines and `# comments` ignored):
 *   http://user:pass@1.2.3.4:8080      full URL (http, https, socks4, socks5, socks5h)
 *   user:pass@1.2.3.4:8080             → <defaultScheme>://user:pass@1.2.3.4:8080
 *   1.2.3.4:8080:user:pass             → <defaultScheme>://user:pass@1.2.3.4:8080  (common provider export)
 *   1.2.3.4:8080                       → <defaultScheme>://1.2.3.4:8080
 *   direct                             → no proxy (this machine's IP)
 */

const SUPPORTED_SCHEMES = /^(https?|socks4|socks5h?):\/\//i;

function parseProxyLine(rawLine, defaultScheme = 'http') {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) return { skip: true };
    if (line === 'direct') return { proxy: 'direct' };

    if (/^[a-z0-9+.-]+:\/\//i.test(line)) {
        return SUPPORTED_SCHEMES.test(line) ? { proxy: line } : { error: 'unsupported scheme' };
    }
    const parts = line.split(':');
    const validPort = p => /^\d{1,5}$/.test(p) && Number(p) > 0 && Number(p) < 65536;
    const validHost = h => /^[A-Za-z0-9.-]+$/.test(h);

    // host:port:user:pass first — the password itself may contain "@" or ":".
    if (parts.length >= 4 && validHost(parts[0]) && validPort(parts[1]) && parts[2]) {
        const [host, port, user, ...passParts] = parts;
        const pass = passParts.join(':');
        return { proxy: `${defaultScheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}` };
    }
    if (parts.length === 2 && validHost(parts[0]) && validPort(parts[1])) {
        return { proxy: `${defaultScheme}://${parts[0]}:${parts[1]}` };
    }
    if (line.includes('@')) {
        const hostPort = line.slice(line.lastIndexOf('@') + 1).split(':');
        if (hostPort.length === 2 && validHost(hostPort[0]) && validPort(hostPort[1])) {
            return { proxy: `${defaultScheme}://${line}` };
        }
    }
    return { error: 'unrecognized format' };
}

/**
 * Reads the file; invalid lines are reported (line number only, never the content,
 * which may hold credentials) and skipped. A missing file is reported and yields [].
 */
function loadProxyFile(filePath, defaultScheme = 'http') {
    if (!filePath) return [];

    const resolved = path.resolve(filePath);
    let content;
    try {
        if (!fs.statSync(resolved).isFile()) {
            console.warn(`⚠️ [CONFIG] UPBIT_PROXIES_FILE ${resolved} is not a file - ignored`);
            return [];
        }
        content = fs.readFileSync(resolved, 'utf8');
    } catch (error) {
        console.warn(`⚠️ [CONFIG] UPBIT_PROXIES_FILE ${resolved} not readable (${error.code || error.message}) - ignored`);
        return [];
    }

    const proxies = [];
    content.split(/\r?\n/).forEach((line, index) => {
        const result = parseProxyLine(line, defaultScheme);
        if (result.skip) return;
        if (result.error) {
            console.warn(`⚠️ [CONFIG] UPBIT_PROXIES_FILE line ${index + 1}: ${result.error} - skipped`);
            return;
        }
        proxies.push(result.proxy);
    });
    return proxies;
}

module.exports = { parseProxyLine, loadProxyFile };
