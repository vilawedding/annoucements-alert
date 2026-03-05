const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config/config');

/**
 * Binance USDS-M Futures Trading Module
 */

const BASE_URL = config.binanceFutures.useTestnet 
    ? config.binanceFutures.testnetUrl 
    : config.binanceFutures.productionUrl;

const API_KEY = config.binanceFutures.apiKey;
const API_SECRET = config.binanceFutures.apiSecret;

// Signature & Request helpers
function createSignature(queryString) {
    return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

function buildQueryString(params) {
    return Object.keys(params)
        .filter(key => params[key] !== undefined && params[key] !== null)
        .map(key => `${key}=${encodeURIComponent(params[key])}`)
        .join('&');
}

async function makeRequest(method, endpoint, params = {}, requiresSignature = false) {
    const timestamp = Date.now();
    const requestParams = { ...params };
    
    if (requiresSignature) {
        requestParams.timestamp = timestamp;
        const queryString = buildQueryString(requestParams);
        requestParams.signature = createSignature(queryString);
    }
    
    const config = {
        method,
        url: `${BASE_URL}${endpoint}`,
        headers: {
            'X-MBX-APIKEY': API_KEY,
            'Content-Type': 'application/json'
        },
        timeout: 10000
    };
    
    if (method === 'GET' || method === 'DELETE') {
        config.params = requestParams;
    } else {
        config.data = requestParams;
    }
    
    const response = await axios(config);
    return response.data;
}

// Market Data APIs
const marketData = {
    async testConnectivity() {
        return await makeRequest('GET', '/fapi/v1/ping');
    },
    
    async getServerTime() {
        const data = await makeRequest('GET', '/fapi/v1/time');
        return data.serverTime;
    },
    
    async getPrice(symbol = null) {
        const params = symbol ? { symbol } : {};
        return await makeRequest('GET', '/fapi/v1/ticker/price', params);
    },
    
    async get24hrTicker(symbol = null) {
        const params = symbol ? { symbol } : {};
        return await makeRequest('GET', '/fapi/v1/ticker/24hr', params);
    },
    
    async getOrderBook(symbol, limit = 20) {
        return await makeRequest('GET', '/fapi/v1/depth', { symbol, limit });
    },
    
    async getExchangeInfo() {
        return await makeRequest('GET', '/fapi/v1/exchangeInfo');
    }
};

// Account APIs
const account = {
    async getBalance() {
        return await makeRequest('GET', '/fapi/v2/balance', {}, true);
    },
    
    async getPositionInfo(symbol = null) {
        const params = symbol ? { symbol } : {};
        return await makeRequest('GET', '/fapi/v2/positionRisk', params, true);
    },
    
    async changeInitialLeverage(symbol, leverage) {
        return await makeRequest('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
    },
    
    async changeMarginType(symbol, marginType) {
        return await makeRequest('POST', '/fapi/v1/marginType', { symbol, marginType }, true);
    }
};

// Trading APIs
const trading = {
    async placeOrder(orderParams) {
        const {
            symbol,
            side,
            type,
            positionSide = 'BOTH',
            quantity,
            price,
            timeInForce = 'GTC',
            stopPrice,
            reduceOnly,
            closePosition,
            newClientOrderId
        } = orderParams;
        
        const params = { symbol, side, type, positionSide, quantity, timeInForce };
        
        if (price !== undefined) params.price = price;
        if (stopPrice !== undefined) params.stopPrice = stopPrice;
        if (reduceOnly !== undefined) params.reduceOnly = reduceOnly;
        if (closePosition !== undefined) params.closePosition = closePosition;
        if (newClientOrderId !== undefined) params.newClientOrderId = newClientOrderId;
        
        return await makeRequest('POST', '/fapi/v1/order', params, true);
    },
    
    async marketBuy(symbol, quantity, positionSide = 'BOTH') {
        return await this.placeOrder({
            symbol,
            side: 'BUY',
            type: 'MARKET',
            positionSide,
            quantity
        });
    },
    
    async marketSell(symbol, quantity, positionSide = 'BOTH') {
        return await this.placeOrder({
            symbol,
            side: 'SELL',
            type: 'MARKET',
            positionSide,
            quantity
        });
    },
    
    async limitBuy(symbol, quantity, price, positionSide = 'BOTH', timeInForce = 'GTC') {
        return await this.placeOrder({
            symbol,
            side: 'BUY',
            type: 'LIMIT',
            positionSide,
            quantity,
            price,
            timeInForce
        });
    },
    
    async cancelOrder(symbol, orderId) {
        return await makeRequest('DELETE', '/fapi/v1/order', { symbol, orderId }, true);
    },
    
    async getOpenOrders(symbol = null) {
        const params = symbol ? { symbol } : {};
        return await makeRequest('GET', '/fapi/v1/openOrders', params, true);
    },
    
    async closePosition(symbol, positionSide = 'BOTH') {
        const positions = await account.getPositionInfo(symbol);
        const position = positions.find(p => p.symbol === symbol && p.positionSide === positionSide);
        
        if (!position || parseFloat(position.positionAmt) === 0) {
            throw new Error(`No open position found for ${symbol} ${positionSide}`);
        }
        
        const positionAmt = parseFloat(position.positionAmt);
        const side = positionAmt > 0 ? 'SELL' : 'BUY';
        const quantity = Math.abs(positionAmt);
        
        return await this.placeOrder({
            symbol,
            side,
            type: 'MARKET',
            positionSide,
            quantity,
            reduceOnly: true
        });
    }
};

// Utilities
const utils = {
    async getSymbolPrecision(symbol) {
        const exchangeInfo = await marketData.getExchangeInfo();
        const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
        
        if (!symbolInfo) {
            throw new Error(`Symbol ${symbol} not found`);
        }
        
        return {
            pricePrecision: symbolInfo.pricePrecision,
            quantityPrecision: symbolInfo.quantityPrecision,
            baseAssetPrecision: symbolInfo.baseAssetPrecision,
            quotePrecision: symbolInfo.quotePrecision,
            filters: symbolInfo.filters
        };
    },
    
    formatQuantity(quantity, precision) {
        return parseFloat(quantity.toFixed(precision));
    },
    
    formatPrice(price, precision) {
        return parseFloat(price.toFixed(precision));
    }
};

module.exports = {
    BASE_URL,
    USE_TESTNET: config.binanceFutures.useTestnet,
    marketData,
    account,
    trading,
    utils,
    
    // Backward compatibility exports
    testConnectivity: marketData.testConnectivity,
    getServerTime: marketData.getServerTime,
    getPrice: marketData.getPrice,
    get24hrTicker: marketData.get24hrTicker,
    getOrderBook: marketData.getOrderBook,
    getExchangeInfo: marketData.getExchangeInfo,
    getBalance: account.getBalance,
    getPositionInfo: account.getPositionInfo,
    changeInitialLeverage: account.changeInitialLeverage,
    changeMarginType: account.changeMarginType,
    placeOrder: trading.placeOrder.bind(trading),
    marketBuy: trading.marketBuy.bind(trading),
    marketSell: trading.marketSell.bind(trading),
    limitBuy: trading.limitBuy.bind(trading),
    cancelOrder: trading.cancelOrder,
    getOpenOrders: trading.getOpenOrders,
    closePosition: trading.closePosition.bind(trading),
    getSymbolPrecision: utils.getSymbolPrecision,
    formatQuantity: utils.formatQuantity,
    formatPrice: utils.formatPrice
};
