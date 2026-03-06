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
    const requestParams = { ...params };
    
    if (requiresSignature) {
        // Use server time instead of local time to avoid timestamp drift
        const serverTime = await marketData.getServerTime().catch(() => Date.now());
        requestParams.timestamp = serverTime;
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
        paramsSerializer: (params) => buildQueryStringForUrl(params)
    };
    
    // For Binance API, all parameters (including signature) must be in query string
    config.params = requestParams;
    
    try {
        const response = await httpClient(config);
        return response.data;
    } catch (err) {
        const errorData = err.response?.data || err.message;
        console.error(`[BINANCE ERROR] ${method} ${endpoint}`, JSON.stringify(errorData, null, 2));
        throw err;
    }
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
            newOrderRespType,
            workingType
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
        // LIMIT, STOP, TAKE_PROFIT orders support timeInForce (defaults to GTC)
        if (['LIMIT', 'STOP', 'TAKE_PROFIT'].includes(type) && timeInForce !== undefined) {
            params.timeInForce = timeInForce;
        }
        
        if (price !== undefined) params.price = price;
        if (stopPrice !== undefined) params.stopPrice = stopPrice;
        if (reduceOnly !== undefined) params.reduceOnly = reduceOnly ? 'true' : 'false';
        if (closePosition !== undefined) params.closePosition = closePosition ? 'true' : 'false';
        if (newClientOrderId !== undefined) params.newClientOrderId = newClientOrderId;
        if (newOrderRespType !== undefined) params.newOrderRespType = newOrderRespType;
        if (workingType !== undefined) params.workingType = workingType;
        
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
     * Place Algo Order (for symbols that require it)
     * Used when regular /fapi/v1/order returns -4120 error
     * Endpoint: POST /fapi/v1/algoOrder (NOTE: different from /fapi/v1/algo/order)
     */
    async placeAlgoOrder(orderParams) {
        const {
            symbol,
            side,
            type,
            positionSide = 'BOTH',
            quantity,
            stopPrice,
            reduceOnly,
            workingType,
            closePosition,
            priceProtect,
            clientAlgoId,
            timeInForce = 'GTC'
        } = orderParams;

        // Algo Order requires algoType='CONDITIONAL' and uses triggerPrice instead of stopPrice
        const params = {
            algoType: 'CONDITIONAL',
            symbol,
            side,
            type,
            positionSide,
            timeInForce
        };

        if (quantity !== undefined) params.quantity = quantity;
        if (stopPrice !== undefined) params.triggerPrice = stopPrice;  // Map stopPrice to triggerPrice
        if (reduceOnly !== undefined) params.reduceOnly = reduceOnly ? 'true' : 'false';
        if (closePosition !== undefined) params.closePosition = closePosition ? 'true' : 'false';
        if (workingType !== undefined) params.workingType = workingType;
        if (priceProtect !== undefined) params.priceProtect = priceProtect ? 'TRUE' : 'FALSE';
        if (clientAlgoId !== undefined) params.clientAlgoId = clientAlgoId;

        return await makeRequest('POST', '/fapi/v1/algoOrder', params, true);
    },
    
    /**
     * Market Buy with Take Profit and Stop Loss
     * Handles the complete flow: BUY → place SL → place TP with algo endpoint fallback
     * For newly listed symbols that require Algo Order API, automatically detects and switches
     */
    async marketBuyWithTPSL(symbol, usdtAmount, tpPercent, slPercent, positionSide = 'BOTH', precision = null, options = {}) {
        const { delayMs = 0 } = options;

        if (!precision) {
            precision = await utils.getSymbolPrecision(symbol);
        }
        
        const priceData = await marketData.getPrice(symbol);
        const currentPrice = parseFloat(priceData.price);
        
        if (currentPrice <= 0) throw new Error('Invalid price');
        
        // Calculate and format quantity using stepSize
        const quantity = utils.formatQuantity(
            usdtAmount / currentPrice,
            precision.stepSize || precision.quantityPrecision
        );
        
        // Place BUY order
        const order = await this.marketBuy(symbol, quantity, positionSide);
        let entryPrice = parseFloat(order.avgPrice);

        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            try {
                const positions = await account.getPositionInfo(symbol);
                const position = positions.find(p => p.symbol === symbol && p.positionSide === positionSide);
                const positionEntryPrice = position ? parseFloat(position.entryPrice) : NaN;
                if (Number.isFinite(positionEntryPrice) && positionEntryPrice > 0) {
                    entryPrice = positionEntryPrice;
                }
            } catch (_) {}
        }

        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            entryPrice = currentPrice;
        }
        
        // Calculate TP and SL prices
        let takeProfitPrice = entryPrice * (1 + tpPercent / 100);
        let stopLossPrice = entryPrice * (1 - slPercent / 100);
        
        // Format prices using tickSize
        takeProfitPrice = utils.formatPrice(takeProfitPrice, precision.tickSize || precision.pricePrecision);
        stopLossPrice = utils.formatPrice(stopLossPrice, precision.tickSize || precision.pricePrecision);
        
        // Validate STOP/TAKE_PROFIT direction before placing orders
        const markPrice = currentPrice;
        
        if (stopLossPrice >= markPrice) {
            console.error(`[VALIDATION] STOP_MARKET direction invalid: stopLossPrice (${stopLossPrice}) >= markPrice (${markPrice})`);
            throw new Error(`STOP_MARKET invalid. stopLossPrice >= markPrice`);
        }
        
        if (takeProfitPrice <= markPrice) {
            console.error(`[VALIDATION] TAKE_PROFIT_MARKET direction invalid: takeProfitPrice (${takeProfitPrice}) <= markPrice (${markPrice})`);
            throw new Error(`TAKE_PROFIT_MARKET invalid. takeProfitPrice <= markPrice`);
        }
        
        // Small delay for position to sync on exchange (important for newly listed symbols)
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        // Place SL first (more critical), then TP
        let slOrder = null;
        let tpOrder = null;
        
        // ===== PLACE STOP LOSS (SL is more critical) =====
        const slParams = {
            symbol,
            side: 'SELL',
            type: 'STOP_MARKET',
            positionSide,
            stopPrice: stopLossPrice,
            quantity,
            workingType: 'MARK_PRICE',
            reduceOnly: true
        };
        
        try {
            slOrder = await this.placeOrder(slParams);
            console.log(`[SL PLACED] ${symbol} @ ${stopLossPrice}`);
        } catch (e) {
            // Check if error is -4120 (order type not supported for endpoint)
            if (e.response?.data?.code === -4120) {
                console.warn(`[SL ALGO FALLBACK] ${symbol} - using /fapi/v1/algoOrder`);
                try {
                    slOrder = await this.placeAlgoOrder(slParams);
                    console.log(`[SL ALGO PLACED] ${symbol} @ ${stopLossPrice}`);
                } catch (algoErr) {
                    console.error(`[SL ALGO FAILED] ${symbol}`, algoErr.response?.data || algoErr.message);
                }
            } else {
                console.error(`[SL FAILED] ${symbol}`, e.response?.data || e.message);
            }
        }
        
        // ===== PLACE TAKE PROFIT (only if SL succeeded) =====
        const tpParams = {
            symbol,
            side: 'SELL',
            type: 'TAKE_PROFIT_MARKET',
            positionSide,
            stopPrice: takeProfitPrice,
            quantity,
            workingType: 'MARK_PRICE',
            reduceOnly: true
        };
        
        try {
            tpOrder = await this.placeOrder(tpParams);
            console.log(`[TP PLACED] ${symbol} @ ${takeProfitPrice}`);
        } catch (e) {
            // Check if error is -4120 (order type not supported for endpoint)
            if (e.response?.data?.code === -4120) {
                console.warn(`[TP ALGO FALLBACK] ${symbol} - using /fapi/v1/algoOrder`);
                try {
                    tpOrder = await this.placeAlgoOrder(tpParams);
                    console.log(`[TP ALGO PLACED] ${symbol} @ ${takeProfitPrice}`);
                } catch (algoErr) {
                    console.error(`[TP ALGO FAILED] ${symbol}`, algoErr.response?.data || algoErr.message);
                }
            } else {
                console.error(`[TP FAILED] ${symbol}`, e.response?.data || e.message);
            }
        }
        
        // Fail if both SL and TP failed (position unprotected)
        if (!slOrder && !tpOrder) {
            throw new Error('Both TP and SL orders failed - position has no protection');
        }
        
        // Warn if only TP failed (SL still protects)
        if (!tpOrder) {
            console.warn(`[WARNING] TP failed but SL is active for ${symbol}`);
        }
        
        return {
            ...order,
            quantity,
            entryPrice,
            takeProfitOrderId: tpOrder?.orderId ?? tpOrder?.algoId,
            stopLossOrderId: slOrder?.orderId ?? slOrder?.algoId,
            takeProfitPrice,
            stopLossPrice
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
     * Closes position at market price when stop price is hit
     */
    async stopLoss(symbol, stopPrice, positionSide = 'BOTH') {
        // Get current position to determine quantity
        const positions = await account.getPositionInfo(symbol);
        const position = positions.find(p => p.symbol === symbol && p.positionSide === positionSide);
        
        if (!position || parseFloat(position.positionAmt) === 0) {
            throw new Error(`No open position for ${symbol} ${positionSide}`);
        }
        
        const quantity = Math.abs(parseFloat(position.positionAmt));
        
        return await this.placeOrder({
            symbol,
            side: 'SELL',
            type: 'STOP_MARKET',
            positionSide,
            stopPrice,
            quantity,
            workingType: 'MARK_PRICE',
            reduceOnly: true
        });
    },
    
    /**
     * Place Take Profit Order (TAKE_PROFIT_MARKET)
     * Closes position at market price when take profit price is hit
     */
    async takeProfit(symbol, takeProfitPrice, positionSide = 'BOTH') {
        // Get current position to determine quantity
        const positions = await account.getPositionInfo(symbol);
        const position = positions.find(p => p.symbol === symbol && p.positionSide === positionSide);
        
        if (!position || parseFloat(position.positionAmt) === 0) {
            throw new Error(`No open position for ${symbol} ${positionSide}`);
        }
        
        const quantity = Math.abs(parseFloat(position.positionAmt));
        
        return await this.placeOrder({
            symbol,
            side: 'SELL',
            type: 'TAKE_PROFIT_MARKET',
            positionSide,
            stopPrice: takeProfitPrice,
            quantity,
            workingType: 'MARK_PRICE',
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
        
        // Extract filter values for proper formatting
        const lotSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
        
        return {
            pricePrecision: symbolInfo.pricePrecision,
            quantityPrecision: symbolInfo.quantityPrecision,
            baseAssetPrecision: symbolInfo.baseAssetPrecision,
            quotePrecision: symbolInfo.quotePrecision,
            stepSize: lotSize ? parseFloat(lotSize.stepSize) : null,
            tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : null,
            filters: symbolInfo.filters
        };
    },
    
    formatQuantity(quantity, stepSize) {
        if (!stepSize || stepSize <= 0) return parseFloat(quantity.toFixed(8));
        const precision = Math.log10(1 / stepSize);
        const adjusted = Math.floor(quantity / stepSize) * stepSize;
        return parseFloat(adjusted.toFixed(precision));
    },
    
    formatPrice(price, tickSize) {
        if (!tickSize || tickSize <= 0) return parseFloat(price.toFixed(8));
        const precision = Math.log10(1 / tickSize);
        const adjusted = Math.floor(price / tickSize) * tickSize;
        return parseFloat(adjusted.toFixed(precision));
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
    placeAlgoOrder: trading.placeAlgoOrder.bind(trading),
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
