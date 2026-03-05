const binanceMonitor = require('./binance-monitor');
const upbitMonitor = require('./upbit-monitor');

module.exports = {
    binance: binanceMonitor,
    upbit: upbitMonitor,
    
    // Placeholder for future exchanges
    // coinbase: require('./coinbase-monitor'),
    // kraken: require('./kraken-monitor'),
};
