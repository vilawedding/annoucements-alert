/**
 * Ladder (scale-in) entry math, ported verbatim from pika (pika/backend/lib/core/ladder.js).
 *
 * NOT wired into the announcement bot's entry path: pika computes rung distances from the
 * ATR / candle range of an EMA-cross signal, which listing announcements don't have, and a
 * listing pump rarely pulls back to resting LIMIT rungs. Kept here (with its config, see
 * config.ladder) so it can be used later; LADDER_COUNT=1 (default) = single market entry.
 *
 * signal: { side: 'BUY'|'SELL', signalClose, signalHigh, signalLow, atr, suggestMarketT1 }
 */

// Min/max step constraints between consecutive ladder entries (E1, E2, E3...)
function applyLadderStepBounds(distances, price, minStepPct, maxStepPct, e1MaxPct = 0) {
    if (price <= 0) return distances;
    const minStep = minStepPct > 0 ? price * (minStepPct / 100) : 0;
    const maxStep = maxStepPct > 0 ? price * (maxStepPct / 100) : Infinity;
    const e1MaxAbs = e1MaxPct > 0 ? price * (e1MaxPct / 100) : Infinity;
    if (minStep === 0 && maxStep === Infinity && e1MaxAbs === Infinity) return distances;
    const result = [...distances];
    // E1: cap only, no min enforced
    if (e1MaxAbs < Infinity) result[0] = Math.min(result[0], e1MaxAbs);
    for (let i = 1; i < result.length; i++) {
        result[i] = Math.max(result[i], result[i - 1] + minStep);
        if (maxStep < Infinity) result[i] = Math.min(result[i], result[i - 1] + maxStep);
    }
    return result;
}

function buildLadderEntries(signal, baseOrderUsdtSize, multipliers, weights, multipliersStrong = null, minStepPct = 0, maxStepPct = 0, e1MaxPct = 0, e1CandlePct = 0, e1CandlePctStrong = 0) {
    const isStrong = signal.suggestMarketT1 === true && multipliersStrong != null;
    const activeMults = isStrong ? multipliersStrong : multipliers;
    const rawDistances = activeMults.map(multiple => signal.atr * multiple);
    const activeCandlePct = isStrong ? e1CandlePctStrong : e1CandlePct;
    if (activeCandlePct > 0 && signal.signalHigh != null && signal.signalLow != null) {
        rawDistances[0] = (signal.signalHigh - signal.signalLow) * activeCandlePct / 100;
    }
    const useE1MaxPct = activeCandlePct > 0 ? 0 : e1MaxPct;
    const distances = applyLadderStepBounds(rawDistances, signal.signalClose, minStepPct, maxStepPct, useE1MaxPct);
    return distances.map((distance, index) => {
        const weight = weights[index] ?? 1;
        const price = signal.side === 'BUY'
            ? signal.signalClose - distance
            : signal.signalClose + distance;
        return { index: index + 1, weight, price, type: 'LIMIT', orderUsdtSize: baseOrderUsdtSize * weight };
    });
}

// Weight-weighted projected average entry of a ladder (pika position-runner.js).
function computeWeightedAverageEntry(entries, fallbackPrice) {
    const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
    if (totalWeight <= 0) return fallbackPrice;
    return entries.reduce((s, e) => s + (e.price ?? fallbackPrice) * e.weight, 0) / totalWeight;
}

module.exports = { applyLadderStepBounds, buildLadderEntries, computeWeightedAverageEntry };
