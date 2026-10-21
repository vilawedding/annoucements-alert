const WebSocket = require('ws');
const crypto = require('crypto');

/**
 * Binance USDS-M Futures WebSocket API (order.place) over one kept-open connection: no HTTP request
 * setup per order. Every request is signed on its own (no session logon). The caller falls back to
 * REST whenever isReady() is false or a request fails before Binance answered.
 */
class WsOrderClient {
    constructor({ url, apiKey, apiSecret, timestamp, label = 'WS-ORDER' }) {
        this.url = url;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.timestamp = timestamp; // () => ms, server-time corrected
        this.label = label;
        this.ws = null;
        this.pending = new Map();
        this.seq = 0;
        this.reconnectMs = 1000;
        this.stopped = false;
        this.connectedAt = 0;
    }

    start() {
        if (!this.url || !this.apiKey || !this.apiSecret) return;
        this.stopped = false;
        this._connect();
    }

    stop() {
        this.stopped = true;
        this.ws?.terminate();
    }

    isReady() {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    _connect() {
        if (this.stopped) return;
        const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 5000 });
        this.ws = ws;

        ws.on('open', () => {
            this.connectedAt = Date.now();
            this.reconnectMs = 1000;
            console.log(`🔌 [${this.label}] Connected (${this.url})`);
        });
        ws.on('message', (raw) => this._onMessage(raw));
        ws.on('error', (error) => console.warn(`[${this.label}] ${error.message}`));
        ws.on('close', () => {
            this._failAll(new Error('ws closed'));
            if (this.ws === ws) this.ws = null;
            if (this.stopped) return;
            setTimeout(() => this._connect(), this.reconnectMs);
            this.reconnectMs = Math.min(this.reconnectMs * 2, 10000);
        });
        // Binance drops a connection after 24h: renew it a little earlier, while idle between signals.
        ws.on('open', () => {
            setTimeout(() => { if (this.ws === ws) ws.close(); }, 23 * 3600 * 1000).unref?.();
        });
    }

    _onMessage(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.status === 200) {
            entry.resolve(msg.result);
        } else {
            // Same shape as an axios error, so callers read error.response.data.{code,msg} as for REST.
            const error = new Error(msg.error?.msg || `ws status ${msg.status}`);
            error.response = { status: msg.status, data: msg.error || {} };
            error.fromWsApi = true;
            entry.reject(error);
        }
    }

    _failAll(error) {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }

    _sign(params) {
        const query = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
        return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
    }

    /** Resolves with the order result; rejects with `error.fromWsApi` when Binance itself refused it. */
    placeOrder(orderParams, timeoutMs = 3000) {
        if (!this.isReady()) return Promise.reject(new Error('ws not connected'));
        const params = { ...orderParams, apiKey: this.apiKey, timestamp: this.timestamp(), recvWindow: 5000 };
        params.signature = this._sign(params);
        const id = `o${++this.seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`ws order timeout ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.ws.send(JSON.stringify({ id, method: 'order.place', params }));
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }
}

module.exports = WsOrderClient;
