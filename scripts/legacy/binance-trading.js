require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

/**
 * Binance USDS-M Futures Trading API
 * Documentation: https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
 */

// ==================== CONFIGURATION ====================
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const BINANCE_FUTURES_BASE_URL = 'https://fapi.binance.com';
const BINANCE_TESTNET_BASE_URL = 'https://testnet.binancefuture.com';

// Use testnet for safety during development
const USE_TESTNET = process.env.BINANCE_USE_TESTNET === 'true';
const BASE_URL = USE_TESTNET ? BINANCE_TESTNET_BASE_URL : BINANCE_FUTURES_BASE_URL;

// ==================== HELPER FUNCTIONS ====================

/**
 * Create HMAC SHA256 signature for authenticated requests
 */
function createSignature(queryString) {
    return crypto
        .createHmac('sha256', BINANCE_API_SECRET)
        .update(queryString)
        .digest('hex');
}

/**
 * Build query string from parameters object
 */
function buildQueryString(params) {
    return Object.keys(params)
        .filter(key => params[key] !== undefined && params[key] !== null)
        .map(key => `${key}=${encodeURIComponent(params[key])}`)
        .join('&');
}

/**
 * Make authenticated request to Binance API
 */
async function makeRequest(method, endpoint, params = {}, requiresSignature = false) {
    try {
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
                'X-MBX-APIKEY': BINANCE_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        };
        
        if (method === 'GET' || method === 'DELETE') {
            config.params = requestParams;
        } else {
            config.data = requestParams;
        }
        
        const startTime = Date.now();
        const response = await axios(config);
        const duration = Date.now() - startTime;
        
        console.log(`✅ [BINANCE] ${method} ${endpoint} - ${duration}ms`);
        return response.data;
        
    } catch (error) {
        console.error(`❌ [BINANCE] ${method} ${endpoint} - Error:`, error.response?.data || error.message);
        throw error;
    }
}

// ==================== MARKET DATA ENDPOINTS ====================

/**
 * Test connectivity to the REST API
 */
async function testConnectivity() {
    return await makeRequest('GET', '/fapi/v1/ping');
}

/**
 * Get server time
 */
async function getServerTime() {
    const data = await makeRequest('GET', '/fapi/v1/time');
    return data.serverTime;
}

/**
 * Get exchange trading rules and symbol information
 */
async function getExchangeInfo() {
    return await makeRequest('GET', '/fapi/v1/exchangeInfo');
}

/**
 * Get order book depth
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {number} limit - Default 500; max 1000. Valid limits: 5, 10, 20, 50, 100, 500, 1000
 */
async function getOrderBook(symbol, limit = 20) {
    return await makeRequest('GET', '/fapi/v1/depth', { symbol, limit });
}

/**
 * Get recent trades
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {number} limit - Default 500; max 1000
 */
async function getRecentTrades(symbol, limit = 100) {
    return await makeRequest('GET', '/fapi/v1/trades', { symbol, limit });
}

/**
 * Get kline/candlestick data
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {string} interval - e.g., '1m', '5m', '15m', '1h', '4h', '1d'
 * @param {number} limit - Default 500; max 1500
 */
async function getKlines(symbol, interval = '1m', limit = 100) {
    return await makeRequest('GET', '/fapi/v1/klines', { symbol, interval, limit });
}

/**
 * Get 24hr ticker price change statistics
 * @param {string} symbol - Optional. If not sent, tickers for all symbols will be returned
 */
async function get24hrTicker(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await makeRequest('GET', '/fapi/v1/ticker/24hr', params);
}

/**
 * Get latest price for a symbol or symbols
 * @param {string} symbol - Optional. If not sent, prices for all symbols will be returned
 */
async function getPrice(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await makeRequest('GET', '/fapi/v1/ticker/price', params);
}

/**
 * Get best price/qty on the order book for a symbol or symbols
 * @param {string} symbol - Optional
 */
async function getBookTicker(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await makeRequest('GET', '/fapi/v1/ticker/bookTicker', params);
}

// ==================== ACCOUNT ENDPOINTS ====================

/**
 * Get current account information
 */
async function getAccountInfo() {
    return await makeRequest('GET', '/fapi/v2/account', {}, true);
}

/**
 * Get account balance
 */
async function getBalance() {
    return await makeRequest('GET', '/fapi/v2/balance', {}, true);
}

/**
 * Get current position information
 */
async function getPositionInfo(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await makeRequest('GET', '/fapi/v2/positionRisk', params, true);
}

/**
 * Change initial leverage
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {number} leverage - 1 to 125
 */
async function changeInitialLeverage(symbol, leverage) {
    return await makeRequest('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
}

/**
 * Change margin type (ISOLATED or CROSS)
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {string} marginType - 'ISOLATED' or 'CROSSED'
 */
async function changeMarginType(symbol, marginType) {
    return await makeRequest('POST', '/fapi/v1/marginType', { symbol, marginType }, true);
}

// ==================== TRADING ENDPOINTS ====================

/**
 * Place a new order
 * @param {object} orderParams - Order parameters
 * @param {string} orderParams.symbol - e.g., 'BTCUSDT'
 * @param {string} orderParams.side - 'BUY' or 'SELL'
 * @param {string} orderParams.type - 'LIMIT', 'MARKET', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', etc.
 * @param {string} orderParams.positionSide - 'BOTH', 'LONG', or 'SHORT' (for hedge mode)
 * @param {number} orderParams.quantity - Order quantity
 * @param {number} orderParams.price - Price (required for LIMIT orders)
 * @param {string} orderParams.timeInForce - 'GTC', 'IOC', 'FOK', 'GTX'
 * @param {number} orderParams.stopPrice - Stop price for STOP orders
 */
async function placeOrder(orderParams) {
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
    
    const params = {
        symbol,
        side,
        type,
        positionSide,
        quantity,
        timeInForce
    };
    
    // Add optional parameters
    if (price !== undefined) params.price = price;
    if (stopPrice !== undefined) params.stopPrice = stopPrice;
    if (reduceOnly !== undefined) params.reduceOnly = reduceOnly;
    if (closePosition !== undefined) params.closePosition = closePosition;
    if (newClientOrderId !== undefined) params.newClientOrderId = newClientOrderId;
    
    return await makeRequest('POST', '/fapi/v1/order', params, true);
}

/**
 * Place a MARKET BUY order
 */
async function marketBuy(symbol, quantity, positionSide = 'BOTH') {
    return await placeOrder({
        symbol,
        side: 'BUY',
        type: 'MARKET',
        positionSide,
        quantity
    });
}

/**
 * Place a MARKET SELL order
 */
async function marketSell(symbol, quantity, positionSide = 'BOTH') {
    return await placeOrder({
        symbol,
        side: 'SELL',
        type: 'MARKET',
        positionSide,
        quantity
    });
}

/**
 * Place a LIMIT BUY order
 */
async function limitBuy(symbol, quantity, price, positionSide = 'BOTH', timeInForce = 'GTC') {
    return await placeOrder({
        symbol,
        side: 'BUY',
        type: 'LIMIT',
        positionSide,
        quantity,
        price,
        timeInForce
    });
}

/**
 * Place a LIMIT SELL order
 */
async function limitSell(symbol, quantity, price, positionSide = 'BOTH', timeInForce = 'GTC') {
    return await placeOrder({
        symbol,
        side: 'SELL',
        type: 'LIMIT',
        positionSide,
        quantity,
        price,
        timeInForce
    });
}

/**
 * Cancel an order
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {number} orderId - Order ID or origClientOrderId
 */
async function cancelOrder(symbol, orderId) {
    return await makeRequest('DELETE', '/fapi/v1/order', { symbol, orderId }, true);
}

/**
 * Cancel all open orders on a symbol
 * @param {string} symbol - e.g., 'BTCUSDT'
 */
async function cancelAllOpenOrders(symbol) {
    return await makeRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true);
}

/**
 * Get current open orders
 * @param {string} symbol - Optional. If not sent, orders for all symbols will be returned
 */
async function getOpenOrders(symbol = null) {
    const params = symbol ? { symbol } : {};
    return await makeRequest('GET', '/fapi/v1/openOrders', params, true);
}

/**
 * Get order by orderId
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {number} orderId - Order ID
 */
async function getOrder(symbol, orderId) {
    return await makeRequest('GET', '/fapi/v1/order', { symbol, orderId }, true);
}

/**
 * Get all orders (active, canceled, or filled)
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {number} limit - Default 500; max 1000
 */
async function getAllOrders(symbol, limit = 500) {
    return await makeRequest('GET', '/fapi/v1/allOrders', { symbol, limit }, true);
}

// ==================== POSITION MANAGEMENT ====================

/**
 * Close a position (market order to close entire position)
 * @param {string} symbol - e.g., 'BTCUSDT'
 * @param {string} positionSide - 'LONG' or 'SHORT'
 */
async function closePosition(symbol, positionSide = 'BOTH') {
    // Get current position
    const positions = await getPositionInfo(symbol);
    const position = positions.find(p => p.symbol === symbol && p.positionSide === positionSide);
    
    if (!position || parseFloat(position.positionAmt) === 0) {
        throw new Error(`No open position found for ${symbol} ${positionSide}`);
    }
    
    const positionAmt = parseFloat(position.positionAmt);
    const side = positionAmt > 0 ? 'SELL' : 'BUY';
    const quantity = Math.abs(positionAmt);
    
    return await placeOrder({
        symbol,
        side,
        type: 'MARKET',
        positionSide,
        quantity,
        reduceOnly: true
    });
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Get symbol precision info (for proper quantity/price formatting)
 */
async function getSymbolPrecision(symbol) {
    const exchangeInfo = await getExchangeInfo();
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
}

/**
 * Format quantity according to symbol precision
 */
function formatQuantity(quantity, precision) {
    return parseFloat(quantity.toFixed(precision));
}

/**
 * Format price according to symbol precision
 */
function formatPrice(price, precision) {
    return parseFloat(price.toFixed(precision));
}

// ==================== EXPORTS ====================
module.exports = {
    // Configuration
    BASE_URL,
    USE_TESTNET,
    
    // Market Data
    testConnectivity,
    getServerTime,
    getExchangeInfo,
    getOrderBook,
    getRecentTrades,
    getKlines,
    get24hrTicker,
    getPrice,
    getBookTicker,
    
    // Account
    getAccountInfo,
    getBalance,
    getPositionInfo,
    changeInitialLeverage,
    changeMarginType,
    
    // Trading
    placeOrder,
    marketBuy,
    marketSell,
    limitBuy,
    limitSell,
    cancelOrder,
    cancelAllOpenOrders,
    getOpenOrders,
    getOrder,
    getAllOrders,
    
    // Position Management
    closePosition,
    
    // Utilities
    getSymbolPrecision,
    formatQuantity,
    formatPrice
};
