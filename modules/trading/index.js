/**
 * Trading module index - Export all trading exchanges
 * Easy to add new exchanges (MEXC, Bybit, etc.)
 */

const binanceFutures = require('./binance-futures');

module.exports = {
    binance: binanceFutures,
    
    // Placeholder for future exchanges
    // mexc: require('./mexc-futures'),
    // bybit: require('./bybit-futures'),
    // okx: require('./okx-futures'),
};
