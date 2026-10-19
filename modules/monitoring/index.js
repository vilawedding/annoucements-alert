const binanceMonitor = require('./binance-monitor');
const upbitMonitor = require('./upbit-monitor');
const bithumbMonitor = require('./bithumb-monitor');
const cryptolistingMonitor = require('./cryptolisting-monitor');

module.exports = {
    binance: binanceMonitor,
    upbit: upbitMonitor,
    bithumb: bithumbMonitor,
    cryptolisting: cryptolistingMonitor,
    
    // Placeholder for future exchanges
    // coinbase: require('./coinbase-monitor'),
    // kraken: require('./kraken-monitor'),
};
