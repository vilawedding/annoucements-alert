const fs = require('fs').promises;
const path = require('path');
const config = require('../../config/config');
const {
    calcInitialSlPrice, calcTpPrice, getTrailLockRoiPct, getTrailSlPrice, calcCurrentRoiPct
} = require('./trade-engine');

/**
 * Position manager for auto-traded positions — the position-management half of pika's
 * "ladder" (pika/backend/lib/core/position-manager.js), adapted to this bot:
 *
 *  - open():   protective orders right after the market entry fills: reduce-only STOP_MARKET
 *              at -initialSlRoiPct% ROI and (optional) TAKE_PROFIT_MARKET, both on the Algo
 *              Order API, MARK_PRICE trigger.
 *  - mark tick (≈1s, all-market mark price stream, no REST): ROI, peak ROI, trailing SL by
 *              ROI step (pika getTrailSlPrice), and a software-SL guard when mark is past the SL.
 *  - poll (positionRisk every pollMs, one request for all symbols): detects the close
 *              (SL/TP/trail filled, liquidation, manual), quantity changes.
 *  - finalize: cancel leftovers, realized PnL from /fapi/v1/userTrades (fees included),
 *              Telegram PnL message.
 *
 * Differences from pika (on purpose): mark price comes from the all-market stream instead of
 * one stream per symbol; close detection polls every few seconds instead of 60s (listing
 * moves are fast); state is a JSON file instead of Postgres; the ATR ladder entry is not used.
 *
 * State persists to data/positions.json, so a restart resumes trailing on open positions.
 */

const SL_RETRY_DELAYS_MS = [3000, 6000, 10000];
const CLOSE_RETRY_DELAYS_MS = [3000, 5000];
const CLOSE_CONFIRM_DELAY_MS = 2000;
const SOFTWARE_SL_GRACE_MS = 3000;
const SOFTWARE_SL_WAKE_MIN_MS = 5000;
const TRAIL_FAIL_CLOSE_STREAK = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function errorText(error) {
    const data = error?.response?.data;
    if (data && (data.code !== undefined || data.msg)) return `code=${data.code} ${data.msg || ''}`.trim();
    return error?.message || String(error);
}

function errorCode(error) {
    return error?.response?.data?.code;
}

// -2021: trigger already passed / would immediately trigger.
function isPastTrigger(error) {
    const code = errorCode(error);
    return code === -2021 || /would immediately trigger|already passed/i.test(errorText(error));
}

function isRetryableCloseError(error) {
    const code = errorCode(error);
    if (code === -4131) return true;
    const status = error?.response?.status;
    if (status >= 500) return true;
    return !error?.response && /timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(errorText(error));
}

function decimalsOf(step) {
    const text = String(step);
    if (text.includes('e-')) return parseInt(text.split('e-')[1], 10);
    return text.includes('.') ? text.split('.')[1].replace(/0+$/, '').length : 0;
}

// Nearest tick (pika roundToStep) — stop prices.
function roundToTick(price, tickSize) {
    if (!(tickSize > 0)) return Number(price.toFixed(8));
    const decimals = decimalsOf(tickSize);
    return Number((Math.round(price / tickSize) * tickSize).toFixed(decimals));
}

function floorToStep(quantity, stepSize) {
    if (!(stepSize > 0)) return Number(quantity.toFixed(8));
    const decimals = decimalsOf(stepSize);
    return Number((Math.floor(quantity / stepSize + 1e-9) * stepSize).toFixed(decimals));
}

function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(sec).padStart(2, '0')}s`;
}

class PositionManager {
    /**
     * @param deps.binance      modules/trading/binance-futures
     * @param deps.markStream   PriceStream of mark prices (onUpdate / getFreshPrice)
     * @param deps.precisionOf  symbol -> { tickSize, stepSize } | null
     * @param deps.notify       (message, channel) fire-and-forget Telegram
     * @param deps.settings     config.positionManager
     */
    constructor({ binance, markStream, precisionOf, notify, settings, storageFile }) {
        this.binance = binance;
        this.markStream = markStream;
        this.precisionOf = precisionOf;
        this.notify = notify || (() => {});
        this.settings = settings;
        this.storageFile = storageFile;
        this.positions = new Map(); // symbol -> state
        this.started = false;
        this.saveChain = Promise.resolve();
        this.lastPollError = null;
    }

    // ==================== LIFECYCLE ====================

    async start() {
        if (this.started) return;
        this.started = true;

        await this._load();
        this.markStream.start();
        this.markStream.onUpdate(() => this._onMarkTick());
        this.pollTimer = setInterval(() => this._poll().catch(e => this._log(`poll error: ${errorText(e)}`, 'error')), this.settings.pollMs);

        if (this.positions.size > 0) {
            this._log(`resumed ${this.positions.size} managed position(s): ${[...this.positions.keys()].join(', ')}`);
            this._poll().catch(() => {});
        }
    }

    /**
     * Register a freshly filled market entry and place its protective orders.
     * side: 'BUY' | 'SELL'. Returns { slPrice, tpPrice, slAlgoId, tpAlgoId, slError }.
     */
    /**
     * risk (optional, per-strategy override persisted with the position):
     *   { name, initialSlRoiPct, tpRoiPct (0 = none), trailing (settings.trailing shape | null = off), maxHoldMin }
     */
    async open({ symbol, side, quantity, entryPrice, leverage, source = {}, risk = null }) {
        const existing = this.positions.get(symbol);
        if (existing) {
            // Same symbol traded again (one-way mode nets into the same position): rebuild
            // protection around the new size/average entry from the exchange.
            this._log(`${symbol} already managed — resyncing protection after additional entry`);
            await this._withLock(existing, () => this._resyncProtection(existing, 'additional entry'));
            return this._summary(existing);
        }

        const state = {
            symbol,
            side,
            quantity,
            entryPrice,
            leverage,
            openedAt: Date.now(),
            source,
            risk,
            slPrice: null,
            slAlgoId: null,
            tpPrice: null,
            tpAlgoId: null,
            trailLevel: 0,
            lockRoiPct: null,
            peakRoiPct: 0,
            trailFailStreak: 0,
            closeMissCount: 0,
            lastSoftwareSlWakeAt: 0,
            status: 'OPEN'
        };
        this.positions.set(symbol, state);

        await this._withLock(state, () => this._placeInitialProtection(state));
        this._persist();
        return this._summary(state);
    }

    getHealth() {
        const now = Date.now();
        return {
            enabled: this.settings.enabled,
            open: [...this.positions.values()].map(s => {
                const mark = this.markStream.getFreshPrice(s.symbol, 10000);
                return {
                    symbol: s.symbol,
                    side: s.side,
                    quantity: s.quantity,
                    entryPrice: s.entryPrice,
                    markPrice: mark,
                    roiPct: mark ? Number(calcCurrentRoiPct(s.side, s.entryPrice, mark, s.leverage).toFixed(2)) : null,
                    peakRoiPct: Number(s.peakRoiPct.toFixed(2)),
                    slPrice: s.slPrice,
                    tpPrice: s.tpPrice,
                    trailLevel: s.trailLevel,
                    heldFor: formatDuration(now - s.openedAt),
                    status: s.status
                };
            }),
            lastPollError: this.lastPollError
        };
    }

    // ==================== PROTECTIVE ORDERS ====================

    _closeSide(state) {
        return state.side === 'BUY' ? 'SELL' : 'BUY';
    }

    _tick(symbol) {
        return this.precisionOf(symbol)?.tickSize;
    }

    async _placeStop(state, type, price) {
        const order = await this.binance.trading.placeConditional({
            symbol: state.symbol,
            side: this._closeSide(state),
            type,
            stopPrice: roundToTick(price, this._tick(state.symbol)),
            quantity: state.quantity
        });
        if (order?.algoId == null) throw new Error(`no algoId in response: ${JSON.stringify(order).slice(0, 200)}`);
        return order.algoId;
    }

    async _placeInitialProtection(state) {
        const { initialSlRoiPct, tpRoiPctBySource } = this._riskParams(state);
        const slPrice = roundToTick(calcInitialSlPrice(state.side, state.entryPrice, state.leverage, initialSlRoiPct), this._tick(state.symbol));
        const tpRoiPct = tpRoiPctBySource;
        const tpPrice = tpRoiPct > 0
            ? roundToTick(calcTpPrice(state.side, state.entryPrice, state.leverage, tpRoiPct), this._tick(state.symbol))
            : null;

        state.slPrice = slPrice;
        state.tpPrice = tpPrice;

        // SL and TP in parallel: both are independent reduce-only conditionals.
        const [slResult, tpResult] = await Promise.allSettled([
            this._placeSlWithRetry(state, slPrice),
            tpPrice ? this._placeStop(state, 'TAKE_PROFIT_MARKET', tpPrice) : Promise.resolve(null)
        ]);

        if (tpResult.status === 'fulfilled') {
            state.tpAlgoId = tpResult.value;
        } else if (isPastTrigger(tpResult.reason)) {
            // Price already beyond the TP: nothing to rest, trailing protects the profit.
            this._log(`${state.symbol} TP ${tpPrice} already passed — skipped`);
            state.tpPrice = null;
        } else {
            this._log(`${state.symbol} TP failed: ${errorText(tpResult.reason)}`, 'error');
            this.notify(`⚠️ <b>TP ĐẶT THẤT BẠI</b>\n${state.symbol} ${state.side}\nTP: ${tpPrice}\nLỗi: ${errorText(tpResult.reason)}`, 'order');
        }

        if (slResult.status === 'fulfilled' && slResult.value) {
            state.slAlgoId = slResult.value;
            state.slError = null;
        } else {
            state.slError = slResult.status === 'rejected' ? errorText(slResult.reason) : 'SL not placed';
        }

        // The SL path may have emergency-closed (and cleaned up) while the TP request was still
        // in flight: a TP that landed afterwards must not stay resting on a flat symbol.
        if (state.status !== 'OPEN' && state.tpAlgoId != null) {
            this.binance.trading.cancelAlgoOrder(state.tpAlgoId).catch(() => {});
            state.tpAlgoId = null;
        }
    }

    /**
     * Initial SL with pika's retry policy: -2021 (price already past the SL) closes
     * immediately; other errors retry after 3s/6s/10s, then close the position rather than
     * leave it unprotected.
     */
    async _placeSlWithRetry(state, slPrice) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this._placeStop(state, 'STOP_MARKET', slPrice);
            } catch (error) {
                if (isPastTrigger(error)) {
                    await this._emergencyClose(state, `SL ${slPrice} đã bị vượt ngay khi đặt (-2021)`, 'SL');
                    return null;
                }
                if (attempt >= SL_RETRY_DELAYS_MS.length) {
                    this._log(`${state.symbol} SL failed ${attempt + 1}x: ${errorText(error)} — closing`, 'error');
                    await this._emergencyClose(state, `Không đặt được SL sau ${attempt + 1} lần (${errorText(error)})`, 'SL_UNPLACEABLE');
                    return null;
                }
                this._log(`${state.symbol} SL failed (${errorText(error)}) — retry in ${SL_RETRY_DELAYS_MS[attempt] / 1000}s`, 'warn');
                await sleep(SL_RETRY_DELAYS_MS[attempt]);
                if (state.status !== 'OPEN') return null;
            }
        }
    }

    _riskParams(state) {
        if (state.risk) {
            return { initialSlRoiPct: state.risk.initialSlRoiPct, tpRoiPctBySource: state.risk.tpRoiPct || 0 };
        }
        const s = this.settings;
        const exchange = String(state.source.exchange || '').toUpperCase();
        // Defaults keep the previous behaviour: AUTO_TRADE_SL_PERCENT / TP_PERCENT_* are % of
        // price, i.e. ROI% = price% × leverage.
        const initialSlRoiPct = s.initialSlRoiPct > 0 ? s.initialSlRoiPct : config.autoTrade.stopLossPercent * state.leverage;
        const tpPricePct = exchange === 'BINANCE'
            ? config.autoTrade.takeProfitPercentBinance
            : exchange === 'BITHUMB'
                ? config.autoTrade.takeProfitPercentBithumb
                : config.autoTrade.takeProfitPercentUpbit;
        return { initialSlRoiPct, tpRoiPctBySource: s.disableTp ? 0 : tpPricePct * state.leverage };
    }

    // ==================== MARK TICK: ROI / TRAILING / SOFTWARE SL ====================

    _onMarkTick() {
        for (const state of this.positions.values()) {
            if (state.status !== 'OPEN') continue;
            const mark = this.markStream.getFreshPrice(state.symbol, 5000);
            if (!mark) continue;

            const roi = calcCurrentRoiPct(state.side, state.entryPrice, mark, state.leverage);
            if (roi > state.peakRoiPct) state.peakRoiPct = roi;

            if (state.busy) continue;

            // Software-SL guard: mark is past the SL (or the SL never got placed) — verify on
            // the exchange shortly after and close if the position is still there.
            if (state.slPrice != null && this._isPast(state, mark, state.slPrice)) {
                const now = Date.now();
                if (now - state.lastSoftwareSlWakeAt >= SOFTWARE_SL_WAKE_MIN_MS) {
                    state.lastSoftwareSlWakeAt = now;
                    this._withLock(state, () => this._softwareSlCheck(state, mark)).catch(() => {});
                }
                continue;
            }

            if (this._trailDue(state, roi)) {
                this._withLock(state, () => this._advanceTrail(state, roi)).catch(e => this._log(`${state.symbol} trail error: ${errorText(e)}`, 'error'));
            }
        }
    }

    _isPast(state, mark, level) {
        return state.side === 'BUY' ? mark <= level : mark >= level;
    }

    _trailing(state) {
        return state.risk ? state.risk.trailing : this.settings.trailing;
    }

    _maxHoldMin(state) {
        return state.risk && state.risk.maxHoldMin != null ? state.risk.maxHoldMin : (this.settings.maxHoldMin || 0);
    }

    _trailDue(state, roi) {
        const t = this._trailing(state);
        if (!t || !(t.activateRoiPct > 0) || state.slPrice == null) return false;
        return roi >= t.activateRoiPct + state.trailLevel * t.stepRoiPct;
    }

    // pika position-manager.js "Trailing SL" block: new SL first, then cancel the old one;
    // the level advances even when the price ties the previous level (otherwise it freezes).
    async _advanceTrail(state, roiAtTrigger) {
        if (state.status !== 'OPEN') return;
        const mark = this.markStream.getFreshPrice(state.symbol, 5000);
        const roi = mark ? calcCurrentRoiPct(state.side, state.entryPrice, mark, state.leverage) : roiAtTrigger;
        if (!this._trailDue(state, roi)) return;

        const t = this._trailing(state);
        const nextThreshold = t.activateRoiPct + state.trailLevel * t.stepRoiPct;
        const newTrailLevel = state.trailLevel + 1;
        const newSlPrice = roundToTick(getTrailSlPrice(
            state.side, state.entryPrice, state.leverage,
            newTrailLevel, t.lockBufferPct, t.stepRoiPct, t.firstLockRoiPct,
            t.activateRoiPct, t.maxGivebackRoiPct
        ), this._tick(state.symbol));
        const lockRoiPct = getTrailLockRoiPct(
            newTrailLevel, t.lockBufferPct, t.stepRoiPct, t.firstLockRoiPct,
            t.activateRoiPct, t.maxGivebackRoiPct
        );
        const dir = state.side === 'BUY' ? 1 : -1;
        const isImproving = dir * (newSlPrice - state.slPrice) > 0;

        if (isImproving) {
            let newAlgoId;
            try {
                newAlgoId = await this._placeStop(state, 'STOP_MARKET', newSlPrice);
            } catch (error) {
                state.trailFailStreak++;
                this._log(`${state.symbol} trail SL ${newSlPrice} failed (streak ${state.trailFailStreak}): ${errorText(error)}`, 'error');
                if (isPastTrigger(error)) {
                    // Price fell back below the new level while we were placing it: the old SL
                    // is still resting, nothing to do until the next trigger.
                    return;
                }
                if (state.trailFailStreak >= TRAIL_FAIL_CLOSE_STREAK) {
                    await this._emergencyClose(state, `Trailing SL đặt lại thất bại ${state.trailFailStreak} lần liên tiếp`, 'SL_UNPLACEABLE');
                }
                return;
            }

            const oldAlgoId = state.slAlgoId;
            state.slAlgoId = newAlgoId;
            state.slPrice = newSlPrice;
            state.trailFailStreak = 0;
            if (oldAlgoId != null) {
                this.binance.trading.cancelAlgoOrder(oldAlgoId).catch(e => this._log(`${state.symbol} cancel old SL ${oldAlgoId}: ${errorText(e)}`, 'warn'));
            }
            this.notify(
                `📈 <b>Trailing SL — Level ${newTrailLevel}</b>\n` +
                `${state.symbol} ${state.side === 'BUY' ? 'LONG' : 'SHORT'}\n` +
                `ROI: ${roi.toFixed(2)}% ≥ +${nextThreshold}%\n` +
                `SL mới: ${newSlPrice} (khóa +${lockRoiPct.toFixed(0)}% ROI)`,
                'order'
            );
        }

        state.trailLevel = newTrailLevel;
        state.lockRoiPct = lockRoiPct;
        this._log(`${state.symbol} trail level ${newTrailLevel} | ROI=${roi.toFixed(1)}% ≥ ${nextThreshold}% | lock +${lockRoiPct.toFixed(0)}%` +
            (isImproving ? ` | SL=${newSlPrice}` : ' (SL unchanged, tied with previous level)'));
        this._persist();
    }

    async _softwareSlCheck(state, markAtTrigger) {
        await sleep(SOFTWARE_SL_GRACE_MS);
        if (state.status !== 'OPEN') return;
        const live = await this._fetchPosition(state.symbol);
        if (!live || live.quantity === 0) return; // exchange SL did its job; poll finalizes
        const mark = this.markStream.getFreshPrice(state.symbol, 5000) || markAtTrigger;
        if (!this._isPast(state, mark, state.slPrice)) return; // bounced back above SL
        await this._emergencyClose(state, `Mark ${mark} đã vượt SL ${state.slPrice} nhưng vị thế vẫn mở (software SL)`, state.trailLevel > 0 ? 'TRAIL' : 'SL');
    }

    // ==================== POLL: CLOSE DETECTION ====================

    async _fetchPosition(symbol) {
        const positions = await this.binance.account.getPositionInfo(symbol);
        const p = (positions || []).find(x => x.symbol === symbol && (x.positionSide === 'BOTH' || !x.positionSide));
        if (!p) return { quantity: 0 };
        const amt = parseFloat(p.positionAmt);
        return {
            quantity: Math.abs(amt),
            side: amt > 0 ? 'BUY' : amt < 0 ? 'SELL' : null,
            entryPrice: parseFloat(p.entryPrice),
            leverage: parseInt(p.leverage, 10) || null
        };
    }

    async _poll() {
        if (this.positions.size === 0) return;

        let positions;
        try {
            positions = await this.binance.account.getPositionInfo();
            this.lastPollError = null;
        } catch (error) {
            this.lastPollError = errorText(error);
            throw error;
        }
        const bySymbol = new Map((positions || []).filter(p => p.positionSide === 'BOTH' || !p.positionSide).map(p => [p.symbol, p]));

        for (const state of this.positions.values()) {
            if (state.busy || state.status === 'FINALIZING') continue;
            const p = bySymbol.get(state.symbol);
            const amt = p ? parseFloat(p.positionAmt) : 0;
            const quantity = Math.abs(amt);

            if (quantity === 0) {
                // pika confirms flat several times; two reads CLOSE_CONFIRM_DELAY_MS apart here.
                this._withLock(state, async () => {
                    await sleep(CLOSE_CONFIRM_DELAY_MS);
                    const live = await this._fetchPosition(state.symbol);
                    if (live.quantity === 0) await this._finalize(state, null);
                }).catch(e => this._log(`${state.symbol} close confirm error: ${errorText(e)}`, 'error'));
                continue;
            }

            // Time stop (backtest: listing moves play out within the first hour).
            const maxHoldMs = this._maxHoldMin(state) * 60000;
            if (maxHoldMs > 0 && Date.now() - state.openedAt >= maxHoldMs && state.status === 'OPEN') {
                this._withLock(state, () => this._emergencyClose(state, `Hết thời gian giữ lệnh (${this._maxHoldMin(state)} phút)`, 'TIME', { planned: true }))
                    .catch(e => this._log(`${state.symbol} time exit error: ${errorText(e)}`, 'error'));
                continue;
            }

            const side = amt > 0 ? 'BUY' : 'SELL';
            if (side !== state.side) {
                this._log(`${state.symbol} position flipped to ${side} outside the bot — stop managing`, 'warn');
                this.notify(`⚠️ <b>${state.symbol}</b>: vị thế đảo chiều ngoài bot (${side}) — ngừng quản lý`, 'order');
                this.positions.delete(state.symbol);
                this._persist();
                continue;
            }

            const stepSize = this.precisionOf(state.symbol)?.stepSize;
            if (Math.abs(quantity - state.quantity) >= (stepSize || 1e-8) - 1e-12) {
                this._withLock(state, () => this._resyncProtection(state, `quantity ${state.quantity} → ${quantity}`))
                    .catch(e => this._log(`${state.symbol} resync error: ${errorText(e)}`, 'error'));
            }
        }
    }

    /**
     * Quantity changed outside a full close (manual partial close, second entry): cancel and
     * re-place SL/TP for the live size, around the live average entry. Trailing restarts
     * from the current level's lock when the entry is unchanged.
     */
    async _resyncProtection(state, reason) {
        const live = await this._fetchPosition(state.symbol);
        if (!live.quantity) return;

        const entryChanged = Math.abs(live.entryPrice - state.entryPrice) / state.entryPrice > 1e-6;
        state.quantity = floorToStep(live.quantity, this.precisionOf(state.symbol)?.stepSize);
        if (entryChanged) {
            state.entryPrice = live.entryPrice;
            state.trailLevel = 0;
            state.lockRoiPct = null;
            state.peakRoiPct = 0;
        }

        await this.binance.trading.cancelAllSymbolOrders(state.symbol);
        state.slAlgoId = null;
        state.tpAlgoId = null;

        if (state.trailLevel > 0 && state.slPrice != null) {
            // keep the locked trailing SL price, re-placed for the new size
            const [sl, tp] = await Promise.allSettled([
                this._placeSlWithRetry(state, state.slPrice),
                state.tpPrice ? this._placeStop(state, 'TAKE_PROFIT_MARKET', state.tpPrice) : Promise.resolve(null)
            ]);
            state.slAlgoId = sl.status === 'fulfilled' ? sl.value : null;
            state.tpAlgoId = tp.status === 'fulfilled' ? tp.value : null;
        } else {
            await this._placeInitialProtection(state);
        }

        this._log(`${state.symbol} protection resynced (${reason}) qty=${state.quantity} entry=${state.entryPrice} SL=${state.slPrice} TP=${state.tpPrice}`);
        this._persist();
    }

    // ==================== CLOSE / FINALIZE ====================

    /**
     * Market reduce-only close with pika's retry policy (-4131 / 5xx / network: 3s, 5s).
     * On -2022 (reduce-only rejected) it re-checks the live position and closes without
     * reduceOnly only if the same-side position is really there (clamped to its size).
     */
    async _emergencyClose(state, reason, exitReasonCode, { planned = false } = {}) {
        if (state.status !== 'OPEN') return false;
        state.status = 'CLOSING';
        const closeSide = this._closeSide(state);

        for (let attempt = 0; ; attempt++) {
            try {
                let order;
                try {
                    order = await this.binance.trading.marketClose(state.symbol, closeSide, state.quantity);
                } catch (error) {
                    if (errorCode(error) !== -2022) throw error;
                    const live = await this._fetchPosition(state.symbol);
                    if (!live.quantity || live.side !== state.side) throw error;
                    order = await this.binance.trading.placeOrder({
                        symbol: state.symbol, side: closeSide, type: 'MARKET',
                        quantity: Math.min(state.quantity, live.quantity), newOrderRespType: 'RESULT'
                    });
                }
                // planned = rule-based exit (max hold time); the PnL message reports it, no alarm.
                this._log(`${state.symbol} ${planned ? 'closed' : 'emergency close'}: ${reason} | orderId=${order.orderId}`, planned ? 'info' : 'error');
                if (!planned) {
                    this.notify(`🚨 <b>EMERGENCY CLOSE</b>\n${state.symbol} ${state.side === 'BUY' ? 'LONG' : 'SHORT'} qty=${state.quantity}\nLý do: ${reason}`, 'order');
                }
                await this._finalize(state, exitReasonCode, reason);
                return true;
            } catch (error) {
                if (attempt < CLOSE_RETRY_DELAYS_MS.length && isRetryableCloseError(error)) {
                    await sleep(CLOSE_RETRY_DELAYS_MS[attempt]);
                    continue;
                }
                state.status = 'OPEN';
                this._log(`${state.symbol} EMERGENCY CLOSE FAILED: ${errorText(error)}`, 'error');
                this.notify(
                    `🚨 <b>EMERGENCY CLOSE FAIL — ĐÓNG THỦ CÔNG NGAY!</b>\n` +
                    `${state.symbol} ${state.side === 'BUY' ? 'LONG' : 'SHORT'} qty=${state.quantity}\n` +
                    `Lý do: ${reason}\nLỗi: ${errorText(error)}`,
                    'order'
                );
                return false;
            }
        }
    }

    _classifyExit(state, exitPrice) {
        if (!(exitPrice > 0)) return 'UNKNOWN';
        const near = (level) => level != null && Math.abs(exitPrice - level) / level <= 0.005;
        if (near(state.tpPrice)) return 'TP';
        if (near(state.slPrice)) return state.trailLevel > 0 ? 'TRAIL' : 'SL';
        return 'MANUAL/LIQ';
    }

    async _finalize(state, exitReasonCode = null, reasonText = null) {
        if (state.status === 'FINALIZING' || state.status === 'CLOSED') return;
        state.status = 'FINALIZING';

        await this.binance.trading.cancelAllSymbolOrders(state.symbol).catch(() => {});

        // Realized PnL straight from the exchange fills (includes fees and slippage).
        let exitPrice = null;
        let realizedPnl = null;
        let commission = 0;
        try {
            const trades = await this.binance.account.getUserTrades(state.symbol, state.openedAt - 5000);
            const closeSide = this._closeSide(state);
            const closing = trades.filter(t => t.side === closeSide);
            const closedQty = closing.reduce((s, t) => s + parseFloat(t.qty), 0);
            if (closedQty > 0) {
                exitPrice = closing.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.qty), 0) / closedQty;
            }
            realizedPnl = trades.reduce((s, t) => s + parseFloat(t.realizedPnl || 0), 0);
            commission = trades.reduce((s, t) => s + (t.commissionAsset === 'USDT' ? parseFloat(t.commission || 0) : 0), 0);
        } catch (error) {
            this._log(`${state.symbol} userTrades failed: ${errorText(error)}`, 'warn');
        }

        if (exitPrice == null) exitPrice = this.markStream.getFreshPrice(state.symbol, 30000);
        if (realizedPnl == null && exitPrice) {
            const dir = state.side === 'BUY' ? 1 : -1;
            realizedPnl = (exitPrice - state.entryPrice) * state.quantity * dir;
        }

        const netPnl = realizedPnl != null ? realizedPnl - commission : null;
        const margin = state.entryPrice * state.quantity / state.leverage;
        const roiPct = netPnl != null && margin > 0 ? netPnl / margin * 100 : null;
        const reason = exitReasonCode || this._classifyExit(state, exitPrice);

        state.status = 'CLOSED';
        this.positions.delete(state.symbol);
        this._persist();

        this._log(`${state.symbol} closed: ${reason} exit=${exitPrice} netPnl=${netPnl?.toFixed(4)} USDT roi=${roiPct?.toFixed(2)}%`);
        this.notify(this._pnlMessage(state, { exitPrice, netPnl, commission, roiPct, reason, reasonText }), 'pnl');
    }

    _pnlMessage(state, { exitPrice, netPnl, commission, roiPct, reason, reasonText }) {
        const win = netPnl != null && netPnl >= 0;
        const mode = config.binanceFutures.mode;
        const src = state.source || {};
        return `${win ? '🟢' : '🔴'} <b>${reason}${mode !== 'PRODUCTION' ? ` [${mode}]` : ''}</b> ${state.symbol} ${state.side === 'BUY' ? 'LONG' : 'SHORT'} ${state.leverage}x\n` +
            `════════════════════════\n` +
            `Entry: ${state.entryPrice} → Exit: ${exitPrice != null ? Number(exitPrice.toPrecision(8)) : '?'}\n` +
            `Qty: ${state.quantity}\n` +
            `PnL: <b>${netPnl != null ? `${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} USDT` : '?'}</b>` +
            `${roiPct != null ? ` (${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(2)}% ROI)` : ''}\n` +
            `Phí: ${commission.toFixed(4)} USDT\n` +
            `Peak ROI: ${state.peakRoiPct.toFixed(2)}% | Trail level: ${state.trailLevel}\n` +
            `Giữ lệnh: ${formatDuration(Date.now() - state.openedAt)}\n` +
            (src.exchange ? `Signal: ${src.exchange} ${src.category || ''}${state.risk && state.risk.name ? ` (${state.risk.name})` : ''}\n` : '') +
            (reasonText ? `Ghi chú: ${reasonText}\n` : '') +
            `#PnL #${state.symbol}`;
    }

    // ==================== HELPERS ====================

    _summary(state) {
        return {
            slPrice: state.slPrice,
            tpPrice: state.tpPrice,
            slAlgoId: state.slAlgoId,
            tpAlgoId: state.tpAlgoId,
            slError: state.slError || null
        };
    }

    // Serializes exchange mutations per position (trail update, resync, close, finalize).
    async _withLock(state, fn) {
        if (state.busy) return undefined;
        state.busy = true;
        try {
            return await fn();
        } finally {
            state.busy = false;
        }
    }

    _persist() {
        if (!this.storageFile) return;
        const snapshot = JSON.stringify(
            [...this.positions.values()].map(({ busy, ...rest }) => rest),
            null, 2
        );
        this.saveChain = this.saveChain.then(async () => {
            const tmp = `${this.storageFile}.tmp`;
            await fs.writeFile(tmp, snapshot, 'utf8');
            await fs.rename(tmp, this.storageFile);
        }).catch(e => this._log(`persist failed: ${e.message}`, 'error'));
    }

    async _load() {
        if (!this.storageFile) return;
        try {
            const items = JSON.parse(await fs.readFile(this.storageFile, 'utf8'));
            for (const item of items || []) {
                if (!item?.symbol) continue;
                this.positions.set(item.symbol, { ...item, status: 'OPEN', busy: false, lastSoftwareSlWakeAt: 0 });
            }
        } catch (error) {
            if (error.code !== 'ENOENT') this._log(`load ${this.storageFile} failed: ${error.message}`, 'warn');
        }
    }

    _log(message, level = 'info') {
        const line = `[POSITION] ${message}`;
        if (level === 'error') console.error(`❌ ${line}`);
        else if (level === 'warn') console.warn(`⚠️ ${line}`);
        else console.log(`📊 ${line}`);
    }
}

function createPositionManager() {
    const binance = require('./binance-futures');
    const { markPriceStream } = require('./price-stream');
    const fastCache = require('../automation/fast-cache');
    const telegram = require('../notifications');

    return new PositionManager({
        binance,
        markStream: markPriceStream,
        precisionOf: symbol => fastCache.symbolPrecision.get(symbol) || null,
        notify: (message, channel) => telegram.notify(message, channel),
        settings: config.positionManager,
        storageFile: path.join(__dirname, '../../', config.storage.positionsFile)
    });
}

module.exports = { PositionManager, createPositionManager, roundToTick, floorToStep };
