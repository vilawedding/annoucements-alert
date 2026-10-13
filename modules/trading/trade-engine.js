/**
 * SL / TP / trailing-SL price formulas, ported verbatim from pika
 * (pika/backend/lib/core/trade-engine.js). All in ROI % of margin:
 *   ROI% = (price - entry) / entry * leverage * 100 * dir
 * side = 'BUY' (long) | 'SELL' (short).
 */

// SL price: ROI = -initialSlRoiPct%
function calcInitialSlPrice(side, averageEntry, leverage, initialSlRoiPct) {
    const dir = side === 'BUY' ? 1 : -1;
    return averageEntry * (1 - dir * initialSlRoiPct / (leverage * 100));
}

// TP price: ROI = +tpRoiPct%
function calcTpPrice(side, averageEntry, leverage, tpRoiPct) {
    const dir = side === 'BUY' ? 1 : -1;
    return averageEntry * (1 + dir * tpRoiPct / (leverage * 100));
}

// Trail level N triggers at ROI >= activate + (N-1)*step and locks (N-1)*(step-buffer)% ROI.
// With buffer 0 the lock ladder and the trigger ladder climb by the same step, so the giveback
// (peak ROI - locked ROI) is pinned at `activate` for every level from 3 up regardless of step.
// maxGivebackRoiPct caps that: the lock is raised to trigger - giveback whenever that is tighter
// than the ladder. 0 (default) leaves the ladder untouched.
//
// The cap never loosens a lock (Math.max) and never reaches the trigger itself
// (MIN_TRAIL_GAP_ROI_PCT floor): an SL at or past the mark is rejected by Binance with -2021.
const MIN_TRAIL_GAP_ROI_PCT = 5;

function getTrailLockRoiPct(
    trailLevel, bufferPct = 0, stepPct = 25, firstLockRoiPct = 0,
    activateRoiPct = 0, maxGivebackRoiPct = 0
) {
    const ladderLock = Math.max(firstLockRoiPct, (trailLevel - 1) * (stepPct - bufferPct));
    if (maxGivebackRoiPct <= 0 || activateRoiPct <= 0) return ladderLock;
    const triggerRoiPct = activateRoiPct + (trailLevel - 1) * stepPct;
    const giveback = Math.max(maxGivebackRoiPct, MIN_TRAIL_GAP_ROI_PCT);
    return Math.max(ladderLock, triggerRoiPct - giveback);
}

function getTrailSlPrice(
    side, averageEntry, leverage, trailLevel, bufferPct = 0, stepPct = 25, firstLockRoiPct = 0,
    activateRoiPct = 0, maxGivebackRoiPct = 0
) {
    const lockRoiPct = getTrailLockRoiPct(
        trailLevel, bufferPct, stepPct, firstLockRoiPct, activateRoiPct, maxGivebackRoiPct
    );
    const dir = side === 'BUY' ? 1 : -1;
    return averageEntry * (1 + dir * lockRoiPct / (leverage * 100));
}

function calcCurrentRoiPct(side, averageEntry, markPrice, leverage) {
    if (averageEntry <= 0 || markPrice <= 0) return 0;
    const dir = side === 'BUY' ? 1 : -1;
    return (markPrice - averageEntry) / averageEntry * leverage * 100 * dir;
}

module.exports = {
    MIN_TRAIL_GAP_ROI_PCT,
    calcInitialSlPrice,
    calcTpPrice,
    getTrailLockRoiPct,
    getTrailSlPrice,
    calcCurrentRoiPct
};
