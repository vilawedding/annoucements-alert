const crypto = require('crypto');
const https = require('https');
const axios = require('axios');
const config = require('../../config/config');

const RECV_WINDOW = 5000;
const FILL_POLL_MS = 150;
const FILL_POLL_TRIES = 20;

/**
 * Bybit V5 SPOT client (Unified Trading Account): instruments cache, market buy by USDT amount,
 * market sell of the whole free coin balance, last price. Used as the venue for Upbit KRW listings
 * that have no Binance perp (backtest 2026-10-20).
 */
class BybitSpot {
    constructor(cfg = config.bybit) {
        this.cfg = cfg;
        this.instruments = new Map(); // symbol -> { basePrecision, minOrderQty, minOrderAmt }
        this.http = axios.create({
            baseURL: cfg.baseUrl,
            timeout: 5000,
            httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20 }),
            // Bybit answers errors with HTTP 200 + retCode; non-2xx are network/gateway problems.
            validateStatus: status => status >= 200 && status < 300
        });
    }

    get enabled() {
        return Boolean(this.cfg.apiKey && this.cfg.apiSecret);
    }

    _sign(timestamp, payload) {
        return crypto.createHmac('sha256', this.cfg.apiSecret)
            .update(`${timestamp}${this.cfg.apiKey}${RECV_WINDOW}${payload}`)
            .digest('hex');
    }

    async _request(method, endpoint, params = {}, signed = false) {
        const isGet = method === 'GET';
        const query = isGet ? new URLSearchParams(params).toString() : '';
        const body = isGet ? '' : JSON.stringify(params);
        const headers = { 'Content-Type': 'application/json' };
        if (signed) {
            const timestamp = Date.now().toString();
            Object.assign(headers, {
                'X-BAPI-API-KEY': this.cfg.apiKey,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
                'X-BAPI-SIGN': this._sign(timestamp, isGet ? query : body)
            });
        }
        const { data } = await this.http.request({
            method,
            url: query ? `${endpoint}?${query}` : endpoint,
            data: isGet ? undefined : body,
            headers
        });
        if (data?.retCode !== 0) {
            const error = new Error(`Bybit ${endpoint}: ${data?.retMsg || 'no response'} (retCode ${data?.retCode})`);
            error.retCode = data?.retCode;
            throw error;
        }
        return data.result;
    }

    /** Caches every trading USDT spot pair. Returns the number of pairs. */
    async loadInstruments() {
        const result = await this._request('GET', '/v5/market/instruments-info', { category: 'spot' });
        const next = new Map();
        for (const i of result?.list || []) {
            if (i.quoteCoin !== 'USDT' || i.status !== 'Trading') continue;
            next.set(i.symbol, {
                basePrecision: Number(i.lotSizeFilter?.basePrecision) || 0,
                minOrderQty: Number(i.lotSizeFilter?.minOrderQty) || 0,
                minOrderAmt: Number(i.lotSizeFilter?.minOrderAmt) || 0
            });
        }
        if (next.size > 0) this.instruments = next;
        return this.instruments.size;
    }

    hasPair(symbol) {
        return this.instruments.has(symbol);
    }

    async lastPrice(symbol) {
        const result = await this._request('GET', '/v5/market/tickers', { category: 'spot', symbol });
        const price = Number(result?.list?.[0]?.lastPrice);
        if (!(price > 0)) throw new Error(`Bybit ${symbol}: no last price`);
        return price;
    }

    async _waitFill(symbol, orderId) {
        for (let i = 0; i < FILL_POLL_TRIES; i++) {
            const result = await this._request('GET', '/v5/order/realtime', { category: 'spot', symbol, orderId }, true);
            const order = result?.list?.[0];
            if (order && ['Filled', 'PartiallyFilledCanceled', 'Cancelled', 'Rejected'].includes(order.orderStatus)) {
                return {
                    status: order.orderStatus,
                    avgPrice: Number(order.avgPrice) || 0,
                    qty: Number(order.cumExecQty) || 0,
                    value: Number(order.cumExecValue) || 0,
                    fee: Number(order.cumExecFee) || 0
                };
            }
            await new Promise(resolve => setTimeout(resolve, FILL_POLL_MS));
        }
        throw new Error(`Bybit ${symbol}: order ${orderId} not final after ${FILL_POLL_TRIES * FILL_POLL_MS}ms`);
    }

    /** Market BUY for `usdt` quote amount. Resolves with the fill (avgPrice, qty, value, fee). */
    async marketBuy(symbol, usdt) {
        const result = await this._request('POST', '/v5/order/create', {
            category: 'spot',
            symbol,
            side: 'Buy',
            orderType: 'Market',
            marketUnit: 'quoteCoin',
            qty: String(Math.floor(usdt * 100) / 100)
        }, true);
        const fill = await this._waitFill(symbol, result.orderId);
        if (!(fill.qty > 0)) throw new Error(`Bybit ${symbol}: buy ${result.orderId} ${fill.status} with no fill`);
        return { orderId: result.orderId, ...fill };
    }

    async freeBalance(coin) {
        const result = await this._request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin }, true);
        const entry = (result?.list?.[0]?.coin || []).find(c => c.coin === coin);
        if (!entry) return 0;
        return Math.max(0, (Number(entry.walletBalance) || 0) - (Number(entry.locked) || 0));
    }

    /**
     * Market SELL of the whole free balance of the pair's base coin (the buy fee is taken in the
     * coin, so the balance, not the bought qty, is what can be sold). null when nothing is sellable.
     */
    async marketSellAll(symbol) {
        const coin = symbol.replace(/USDT$/, '');
        const info = this.instruments.get(symbol) || {};
        const step = info.basePrecision || 0;
        const balance = await this.freeBalance(coin);
        const qty = step > 0 ? Math.floor(balance / step + 1e-9) * step : balance;
        const decimals = step > 0 ? Math.max(0, Math.round(-Math.log10(step))) : 8;
        if (!(qty > 0) || (info.minOrderQty && qty < info.minOrderQty)) return null;
        const result = await this._request('POST', '/v5/order/create', {
            category: 'spot',
            symbol,
            side: 'Sell',
            orderType: 'Market',
            qty: qty.toFixed(decimals)
        }, true);
        const fill = await this._waitFill(symbol, result.orderId);
        return { orderId: result.orderId, ...fill };
    }
}

module.exports = { BybitSpot };
