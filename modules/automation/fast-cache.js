/**
 * Fast Cache Layer for Exchange Data
 * Cache symbol precision, exchange info to reduce API calls
 */

class FastCache {
    constructor() {
        this.symbolPrecision = new Map();
        this.exchangeInfo = null;
        this.lastExchangeInfoUpdate = 0;
        this.CACHE_TTL = 60000; // 1 minute
    }
    
    async getSymbolPrecision(symbol, binance) {
        // Return cached if available
        if (this.symbolPrecision.has(symbol)) {
            return this.symbolPrecision.get(symbol);
        }
        
        try {
            const precision = await binance.getSymbolPrecision(symbol);
            this.symbolPrecision.set(symbol, precision);
            return precision;
        } catch (error) {
            return null;
        }
    }
    
    async getExchangeInfo(binance) {
        // Return cached if still valid
        const now = Date.now();
        if (this.exchangeInfo && (now - this.lastExchangeInfoUpdate) < this.CACHE_TTL) {
            return this.exchangeInfo;
        }
        
        try {
            this.exchangeInfo = await binance.getExchangeInfo();
            this.lastExchangeInfoUpdate = now;
            return this.exchangeInfo;
        } catch (error) {
            return null;
        }
    }
    
    cacheSymbolPrecision(symbol, precision) {
        this.symbolPrecision.set(symbol, precision);
    }
    
    clear() {
        this.symbolPrecision.clear();
        this.exchangeInfo = null;
        this.lastExchangeInfoUpdate = 0;
    }
}

module.exports = new FastCache();
