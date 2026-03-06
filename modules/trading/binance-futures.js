const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const config = require('../../config/config');

/**
 * Binance USDS-M Futures Trading Module
 */

const BASE_URL = config.binanceFutures.useTestnet 
    ? config.binanceFutures.testnetUrl 
    : config.binanceFutures.productionUrl;

const API_KEY = config.binanceFutures.apiKey;
const API_SECRET = config.binanceFutures.apiSecret;

// Keep-alive client for lower latency on repeated requests
const httpClient = axios.create({
    timeout: 10000,
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 50
    })
});

// Signature & Request helpers
function createSignature(queryString) {
    return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

function buildQueryString(params) {
    return Object.keys(params)
        .filter(key => params[key] !== undefined && params[key] !== null)
        .map(key => {
            const value = params[key];
            // Convert objects to JSON string (for takeProfit, stopLoss, etc)
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
            return `${key}=${stringValue}`;
        })
        .join('&');
}

function buildQueryStringForUrl(params) {
    return Object.keys(params)
        .filter(key => params[key] !== undefined && params[key] !== null)
        .map(key => {
            const value = params[key];
            // Convert objects to JSON string (for takeProfit, stopLoss, etc)
            const stringValue = typeof value === 'object' ? JSON.stringify(value) : value;
            return `${key}=${encodeURIComponent(stringValue)}`;
        })
        .join('&');
}

async function makeRequest(method, endpoint, params = {}, requiresSignature = false) {
    const timestamp = Date.now();
    const requestParams = { ...params };
    
    if (requiresSignature) {
        requestParams.timestamp = timestamp;
        // Signature must be calculated on non-URL-encoded string
        const queryString = buildQueryString(requestParams);
        requestParams.signature = createSignature(queryString);
    }
    
    const config = {
        method,
        url: `${BASE_URL}${endpoint}`,
        headers: {
            'X-MBX-APIKEY': API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000,
        paramsSerializer: (params) => {
            // axios automatically URL-encodes params
            return buildQueryStringForUrl(params);
        }
    };
    
    // For Binance API, all parameters (including signature) must be in query string
    config.params = requestParams;
    
    const response = await httpClient(config);
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
            newClientOrderId,
            newOrderRespType
        } = orderParams;
        
        const params = { symbol, side, type, positionSide };
        
        // Use quantity
        if (quantity !== undefined) {
            params.quantity = quantity;
        }
        // Don't add quantity if using closePosition
        if (closePosition !== undefined && closePosition === true) {
            delete params.quantity;
        }
        
        // timeInForce is only for LIMIT orders, not MARKET or STOP orders
        if (type === 'LIMIT' && timeInForce !== undefined) params.timeInForce = timeInForce;
        
        if (price !== undefined) params.price = price;
        if (stopPrice !== undefined) params.stopPrice = stopPrice;
        if (reduceOnly !== undefined) params.reduceOnly = reduceOnly;
        if (closePosition !== undefined) params.closePosition = closePosition;
        if (newClientOrderId !== undefined) params.newClientOrderId = newClientOrderId;
        if (newOrderRespType !== undefined) params.newOrderRespType = newOrderRespType;
        
        return await makeRequest('POST', '/fapi/v1/order', params, true);
    },
    
    async marketBuy(symbol, quantity, positionSide = 'BOTH') {
        return await this.placeOrder({
            symbol,
            side: 'BUY',
            type: 'MARKET',
            positionSide,
            quantity,
            newOrderRespType: 'RESULT'
        });
    },
    
    /**
     * Market Buy with Take Profit and Stop Loss
     * Handles the complete flow: BUY → get entry price → place TP/SL
     */
    async marketBuyWithTPSL(symbol, usdtAmount, tpPercent, slPercent, positionSide = 'BOTH', precision = null) {
        // Get precision if not provided
        if (!precision) {
            precision = await utils.getSymbolPrecision(symbol);
        }
        
        // Get current price to calculate quantity from USDT amount
        const priceData = await marketData.getPrice(symbol);
        const currentPrice = parseFloat(priceData.price);
        
        if (currentPrice <= 0) throw new Error('Invalid price');
        
        // Calculate quantity from USDT amount
        const quantity = utils.formatQuantity(
            usdtAmount / currentPrice,
            precision.quantityPrecision
        );
        
        // Place BUY order
        const order = await this.marketBuy(symbol, quantity, positionSide);
        let entryPrice = parseFloat(order.avgPrice);

        // Fallback: fetch entry price from current position when avgPrice is missing
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            try {
                const positions = await account.getPositionInfo(symbol);
                const position = positions.find(p => p.symbol === symbol && p.positionSide === positionSide);
                const positionEntryPrice = position ? parseFloat(position.entryPrice) : NaN;
                if (Number.isFinite(positionEntryPrice) && positionEntryPrice > 0) {
                    entryPrice = positionEntryPrice;
                }
            } catch (_) {
                // keep fallback below
            }
        }

        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            entryPrice = currentPrice;
        }
        
        // Calculate TP and SL prices
        const takeProfitPrice = entryPrice * (1 + tpPercent / 100);
        const stopLossPrice = entryPrice * (1 - slPercent / 100);
        
        // Place TP and SL orders (wait for confirmation)
        const [tpOrder, slOrder] = await Promise.all([
            this.placeOrder({
                symbol,
                side: 'SELL',
                type: 'TAKE_PROFIT_MARKET',
                positionSide,
                stopPrice: utils.formatPrice(takeProfitPrice, precision.pricePrecision),
                closePosition: true
            }),
            this.placeOrder({
                symbol,
                side: 'SELL',
                type: 'STOP_MARKET',
                positionSide,
                stopPrice: utils.formatPrice(stopLossPrice, precision.pricePrecision),
                closePosition: true
            })
        ]);
        
        return {
            ...order,
            quantity,
            entryPrice,
            takeProfitOrderId: tpOrder?.orderId,
            stopLossOrderId: slOrder?.orderId,
            takeProfitPrice: takeProfitPrice.toFixed(precision.pricePrecision),
            stopLossPrice: stopLossPrice.toFixed(precision.pricePrecision)
        };
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
    },
    
    /**
     * Place Stop Loss Order (STOP_MARKET)
     * Automatically closes position when price hits stop price
     */
    async stopLoss(symbol, quantity, stopPrice, positionSide = 'BOTH') {
        return await this.placeOrder({
            symbol,
            side: 'SELL',
            type: 'STOP_MARKET',
            positionSide,
            stopPrice,
            quantity,
            closePosition: true
        });
    },
    
    /**
     * Place Take Profit Order (TAKE_PROFIT_MARKET)
     * Automatically closes position when price hits take profit price
     */
    async takeProfit(symbol, quantity, takeProfitPrice, positionSide = 'BOTH') {
        return await this.placeOrder({
            symbol,
            side: 'SELL',
            type: 'TAKE_PROFIT_MARKET',
            positionSide,
            stopPrice: takeProfitPrice,
            quantity,
            closePosition: true
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
    stopLoss: trading.stopLoss.bind(trading),
    takeProfit: trading.takeProfit.bind(trading),
    getSymbolPrecision: utils.getSymbolPrecision,
    formatQuantity: utils.formatQuantity,
    formatPrice: utils.formatPrice
};
