const binanceMonitor = require('./binance-monitor');
const upbitMonitor = require('./upbit-monitor');
const bithumbMonitor = require('./bithumb-monitor');

module.exports = {
    binance: binanceMonitor,
    upbit: upbitMonitor,
    bithumb: bithumbMonitor,
    
    // Placeholder for future exchanges
    // coinbase: require('./coinbase-monitor'),
    // kraken: require('./kraken-monitor'),
};
