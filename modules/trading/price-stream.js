const WebSocket = require('ws');
const config = require('../../config/config');

/**
 * All-market Binance Futures price stream kept in memory (symbol -> latest price).
 *  - priceStream:     `!miniTicker@arr` last trade price (~1s, changed symbols only) — order sizing,
 *                     so the order path skips a blocking GET /ticker/price round trip.
 *  - markPriceStream: `!markPrice@arr@1s` mark price (every symbol, every second) — ROI / trailing SL
 *                     in the position manager (Binance triggers MARK_PRICE stops on it).
 * URLs come from config per environment (production / demo / testnet).
 */

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class PriceStream {
    /**
     * @param name       log label
     * @param url        websocket URL of an all-market array stream
     * @param priceField field holding the price in each array item (miniTicker: c, markPrice: p)
     */
    constructor(name, url, priceField) {
        this.name = name;
        this.url = url;
        this.priceField = priceField;
        this.prices = new Map(); // symbol -> { price, eventTime, receivedAt }
        this.listeners = new Set();
        this.started = false;
        this.connected = false;
        this.lastMessageAt = null;
    }

    start() {
        if (this.started) return;
        this.started = true;

        let reconnectDelay = RECONNECT_MIN_MS;

        const connect = () => {
            const ws = new WebSocket(this.url);

            ws.on('open', () => {
                this.connected = true;
                reconnectDelay = RECONNECT_MIN_MS;
                console.log(`🔌 [${this.name}] Connected (${this.url})`);
            });

            ws.on('message', (data) => {
                let items;
                try {
                    items = JSON.parse(data.toString('utf8'));
                } catch (_) {
                    return;
                }
                if (!Array.isArray(items)) return;

                const receivedAt = Date.now();
                this.lastMessageAt = receivedAt;
                for (const item of items) {
                    const price = parseFloat(item[this.priceField]);
                    if (item.s && price > 0) {
                        this.prices.set(item.s, { price, eventTime: item.E, receivedAt });
                    }
                }
                for (const listener of this.listeners) {
                    try {
                        listener(this);
                    } catch (error) {
                        console.error(`⚠️ [${this.name}] listener error: ${error.message}`);
                    }
                }
            });

            ws.on('error', (error) => {
                console.error(`⚠️ [${this.name}] ${error.message}`);
            });

            // Binance drops every stream connection after 24h; just reconnect.
            ws.on('close', () => {
                this.connected = false;
                setTimeout(connect, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
            });
        };

        connect();
    }

    /**
     * Last price if it was received within maxAgeMs, otherwise null (caller falls back to REST).
     */
    getFreshPrice(symbol, maxAgeMs) {
        const entry = this.prices.get(symbol);
        if (!entry) return null;
        if (Date.now() - entry.receivedAt > maxAgeMs) return null;
        return entry.price;
    }

    /** Called after every batch update (≈ once per second). Returns an unsubscribe function. */
    onUpdate(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    getHealth() {
        return {
            connected: this.connected,
            symbols: this.prices.size,
            lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null
        };
    }
}

const priceStream = new PriceStream('PRICE-STREAM', config.binanceFutures.priceStreamUrl, 'c');
const markPriceStream = new PriceStream('MARK-PRICE-STREAM', config.binanceFutures.markPriceStreamUrl, 'p');

module.exports = priceStream;
module.exports.priceStream = priceStream;
module.exports.markPriceStream = markPriceStream;
module.exports.PriceStream = PriceStream;
