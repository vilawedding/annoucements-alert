const fs = require('fs');
const path = require('path');

const SELL_FAIL_ALERT_EVERY = 10;

/**
 * Bybit SPOT positions opened on Upbit KRW listings: SL on the last price (checked every pollMs,
 * like the backtest's 1s close) and a time stop, both closed with a market sell of the whole coin
 * balance. Spot = no leverage, the loss is bounded by the SL plus the gap of a fast dump.
 * The SL lives in the bot (not on Bybit): positions persist to storageFile and resume on restart.
 */
class BybitSpotManager {
    constructor({ client, notify = () => {}, settings, storageFile = null, pollMs = 1000, now = Date.now }) {
        this.client = client;
        this.notify = notify;
        this.settings = settings; // { amount, slPct, maxHoldMin }
        this.storageFile = storageFile;
        this.pollMs = pollMs;
        this.now = now;
        this.positions = new Map(); // symbol -> state
        this.timer = null;
    }

    start() {
        this._load();
        if (this.positions.size > 0) {
            console.log(`🟠 [BYBIT-SPOT] resumed ${this.positions.size} position(s): ${[...this.positions.keys()].join(', ')}`);
        }
        if (!this.timer) {
            this.timer = setInterval(() => this.tick().catch(error => console.error(`[BYBIT-SPOT] tick: ${error.message}`)), this.pollMs);
            if (this.timer.unref) this.timer.unref();
        }
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    /** Market buy `amount` USDT of symbol. Resolves with a trader-style result. */
    async open({ symbol, token, source = {} }) {
        const startedAt = this.now();
        const fill = await this.client.marketBuy(symbol, this.settings.amount);
        const state = {
            symbol,
            token,
            orderId: fill.orderId,
            entryPrice: fill.avgPrice || fill.value / fill.qty,
            qty: fill.qty,
            cost: fill.value,
            openedAt: startedAt,
            slPrice: (fill.avgPrice || fill.value / fill.qty) * (1 - this.settings.slPct / 100),
            closeAt: startedAt + this.settings.maxHoldMin * 60000,
            source,
            status: 'OPEN',
            sellFails: 0
        };
        this.positions.set(symbol, state);
        this._persist();

        console.log(`🟠 [BYBIT-SPOT] BUY ${symbol} ${state.qty} @ ${state.entryPrice} (${state.cost.toFixed(2)} USDT) | SL ${state.slPrice} | close at ${new Date(state.closeAt).toISOString()}`);
        this.notify(
            `🤖 <b>ORDER FILLED — Bybit SPOT${this.client.cfg?.testnet ? ' [TESTNET]' : ''}</b>\n` +
            `Signal: ${source.exchange || ''} ${source.category || ''}\n` +
            `${symbol} BUY ${state.qty} @ ${state.entryPrice} (~${state.cost.toFixed(2)} USDT)\n` +
            `SL: ${state.slPrice.toPrecision(6)} (-${this.settings.slPct}%) | time stop ${this.settings.maxHoldMin}m\n` +
            `Order: ${this.now() - startedAt}ms`,
            'order'
        );
        return {
            token,
            symbol,
            success: true,
            venue: 'BYBIT_SPOT',
            notified: true,
            orderId: fill.orderId,
            entryPrice: state.entryPrice,
            executedQty: state.qty,
            amount: state.cost,
            leverage: 1,
            stopLoss: state.slPrice,
            takeProfit: null,
            duration: this.now() - startedAt
        };
    }

    async tick() {
        const now = this.now();
        await Promise.all([...this.positions.values()].filter(s => s.status === 'OPEN').map(async (state) => {
            if (now >= state.closeAt) return this.close(state, 'TIME');
            let price;
            try {
                price = await this.client.lastPrice(state.symbol);
            } catch (error) {
                return; // next tick; the time stop still applies
            }
            if (price <= state.slPrice) return this.close(state, 'SL', price);
            return null;
        }));
    }

    async close(state, reason, triggerPrice = null) {
        if (state.status !== 'OPEN') return;
        state.status = 'CLOSING';
        let fill;
        try {
            fill = await this.client.marketSellAll(state.symbol);
        } catch (error) {
            state.status = 'OPEN';
            state.sellFails++;
            console.error(`❌ [BYBIT-SPOT] sell ${state.symbol} (${reason}) failed ${state.sellFails}x: ${error.message}`);
            if (state.sellFails === 1 || state.sellFails % SELL_FAIL_ALERT_EVERY === 0) {
                this.notify(`⚠️ <b>Bybit SPOT sell failed</b> ${state.symbol} (${reason}) ${state.sellFails}x: ${error.message}`, 'order');
            }
            return;
        }

        this.positions.delete(state.symbol);
        this._persist();
        if (!fill) {
            console.warn(`⚠️ [BYBIT-SPOT] ${state.symbol} closed (${reason}): no sellable balance`);
            this.notify(`⚠️ Bybit SPOT ${state.symbol}: nothing left to sell (${reason}), position dropped`, 'order');
            return;
        }
        const received = fill.value - fill.fee;
        const pnl = received - state.cost;
        const pnlPct = state.cost > 0 ? pnl / state.cost * 100 : 0;
        console.log(`🟠 [BYBIT-SPOT] SELL ${state.symbol} ${reason}${triggerPrice ? ` @trigger ${triggerPrice}` : ''} avg ${fill.avgPrice} | PnL ${pnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`);
        this.notify(
            `${pnl >= 0 ? '💰' : '🔻'} <b>Bybit SPOT closed — ${reason}</b>\n` +
            `${state.symbol}: ${state.entryPrice} → ${fill.avgPrice}\n` +
            `PnL: ${pnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%) | held ${Math.round((this.now() - state.openedAt) / 1000)}s`,
            'pnl'
        );
    }

    getHealth() {
        return {
            enabled: true,
            open: [...this.positions.values()].map(s => ({ symbol: s.symbol, entryPrice: s.entryPrice, slPrice: s.slPrice, closeAt: new Date(s.closeAt).toISOString(), status: s.status }))
        };
    }

    _persist() {
        if (!this.storageFile) return;
        try {
            const tmp = `${this.storageFile}.tmp`;
            fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify([...this.positions.values()], null, 1));
            fs.renameSync(tmp, this.storageFile);
        } catch (error) {
            console.error(`❌ [BYBIT-SPOT] save positions failed: ${error.message}`);
        }
    }

    _load() {
        if (!this.storageFile) return;
        try {
            const items = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
            for (const item of items || []) this.positions.set(item.symbol, { ...item, status: 'OPEN' });
        } catch (error) {
            if (error.code !== 'ENOENT') console.error(`❌ [BYBIT-SPOT] load positions failed: ${error.message}`);
        }
    }
}

module.exports = { BybitSpotManager };
