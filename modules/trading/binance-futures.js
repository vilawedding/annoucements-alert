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

// Server time cache for ultra-fast execution (avoid repeated server time calls)
let serverTimeCache = { time: null, lastFetch: 0, offsetMs: 0 };
let tradableSymbolsCache = { symbols: null, lastFetch: 0 };

// Keep-alive client for lower latency on repeated requests
const httpClient = axios.create({
    timeout: 5000,
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 100,
        keepAliveMsecs: 1000
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
        // Use cached server time or current local time with offset (ultra-fast)
        const now = Date.now();
        const timeSinceLastFetch = now - serverTimeCache.lastFetch;
        
        // If cache is fresh (within 30s), use it; otherwise, fetch new server time
        if (serverTimeCache.time && timeSinceLastFetch < 30000) {
            // Calculate current server time by adding elapsed time to cached time
            requestParams.timestamp = serverTimeCache.time + timeSinceLastFetch;
        } else {
            // Fetch new server time asynchronously (non-blocking - won't wait if possible)
            const serverTime = await marketData.getServerTime().catch(() => Date.now());
            serverTimeCache.time = serverTime;
            serverTimeCache.lastFetch = now;
            requestParams.timestamp = serverTime;
        }
        
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
        timeout: 5000,
        paramsSerializer: (params) => buildQueryStringForUrl(params)
    };
    
    // For Binance API, all parameters (including signature) must be in query string
    config.params = requestParams;
    
    try {
        const response = await httpClient(config);
        return response.data;
    } catch (err) {
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
    },

    async getTradableSymbols(forceRefresh = false) {
        const now = Date.now();
        const cacheFresh = tradableSymbolsCache.symbols && (now - tradableSymbolsCache.lastFetch) < 10000;

        if (!forceRefresh && cacheFresh) {
            return tradableSymbolsCache.symbols;
        }

        const exchangeInfo = await this.getExchangeInfo();
        const symbols = new Set(
            (exchangeInfo?.symbols || [])
                .filter(s => s && s.status === 'TRADING' && s.contractType === 'PERPETUAL')
                .map(s => s.symbol)
        );

        tradableSymbolsCache = {
            symbols,
            lastFetch: now
        };

        return symbols;
    },

    async isSymbolTradable(symbol, forceRefresh = false) {
        const symbols = await this.getTradableSymbols(forceRefresh);
        return symbols.has(symbol);
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

    async marketSell(symbol, quantity, positionSide = 'BOTH') {
        return await this.placeOrder({
            symbol,
            side: 'SELL',
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
            throw new Error(`STOP_MARKET invalid. stopLossPrice >= markPrice`);
        }
        
        if (takeProfitPrice <= markPrice) {
            throw new Error(`TAKE_PROFIT_MARKET invalid. takeProfitPrice <= markPrice`);
        }
        
        // Small delay for position to sync on exchange (important for newly listed symbols)
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        // Place SL first (more critical), then TP
        let slOrder = null;
        let tpOrder = null;
        
        // ===== PLACE BOTH SL AND TP IN PARALLEL (Ultra-fast execution) =====
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
        
        // Execute both orders in parallel
        const [slResult, tpResult] = await Promise.allSettled([
            (async () => {
                try {
                    const result = await this.placeOrder(slParams);
                    return { success: true, order: result, type: 'regular' };
                } catch (e) {
                    if (e.response?.data?.code === -4120) {
                        try {
                            const result = await this.placeAlgoOrder(slParams);
                            return { success: true, order: result, type: 'algo' };
                        } catch (algoErr) {
                            return { success: false, error: algoErr };
                        }
                    } else {
                        return { success: false, error: e };
                    }
                }
            })(),
            (async () => {
                try {
                    const result = await this.placeOrder(tpParams);
                    return { success: true, order: result, type: 'regular' };
                } catch (e) {
                    if (e.response?.data?.code === -4120) {
                        try {
                            const result = await this.placeAlgoOrder(tpParams);
                            return { success: true, order: result, type: 'algo' };
                        } catch (algoErr) {
                            return { success: false, error: algoErr };
                        }
                    } else {
                        return { success: false, error: e };
                    }
                }
            })()
        ]);
        
        // Extract results from Promise.allSettled
        if (slResult.status === 'fulfilled' && slResult.value.success) {
            slOrder = slResult.value.order;
        }
        if (tpResult.status === 'fulfilled' && tpResult.value.success) {
            tpOrder = tpResult.value.order;
        }
        
        // Fail if both SL and TP failed (position unprotected)
        if (!slOrder && !tpOrder) {
            throw new Error('Both TP and SL orders failed - position has no protection');
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

    /**
     * Market Sell (SHORT) with Take Profit and Stop Loss
     * For delisting scenarios - reversed TP/SL logic
     */
    async marketSellWithTPSL(symbol, usdtAmount, tpPercent, slPercent, positionSide = 'BOTH', precision = null, options = {}) {
        const { delayMs = 0 } = options;

        if (!precision) {
            precision = await utils.getSymbolPrecision(symbol);
        }
        
        const priceData = await marketData.getPrice(symbol);
        const currentPrice = parseFloat(priceData.price);
        
        if (currentPrice <= 0) throw new Error('Invalid price');
        
        const quantity = utils.formatQuantity(
            usdtAmount / currentPrice,
            precision.stepSize || precision.quantityPrecision
        );
        
        // Place SELL order (SHORT)
        const order = await this.marketSell(symbol, quantity, positionSide);
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
        
        // Calculate TP and SL prices (REVERSED for SHORT)
        let takeProfitPrice = entryPrice * (1 - tpPercent / 100);  // TP below entry
        let stopLossPrice = entryPrice * (1 + slPercent / 100);    // SL above entry
        
        takeProfitPrice = utils.formatPrice(takeProfitPrice, precision.tickSize || precision.pricePrecision);
        stopLossPrice = utils.formatPrice(stopLossPrice, precision.tickSize || precision.pricePrecision);
        
        // Validate direction for SHORT position
        const markPrice = currentPrice;
        
        if (stopLossPrice <= markPrice) {
            throw new Error(`STOP_MARKET invalid for SHORT. stopLossPrice <= markPrice`);
        }
        
        if (takeProfitPrice >= markPrice) {
            throw new Error(`TAKE_PROFIT_MARKET invalid for SHORT. takeProfitPrice >= markPrice`);
        }
        
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        let slOrder = null;
        let tpOrder = null;
        
        // SL: BUY to close SHORT position when price goes UP
        const slParams = {
            symbol,
            side: 'BUY',
            type: 'STOP_MARKET',
            positionSide,
            stopPrice: stopLossPrice,
            quantity,
            workingType: 'MARK_PRICE',
            reduceOnly: true
        };
        
        // TP: BUY to close SHORT position when price goes DOWN
        const tpParams = {
            symbol,
            side: 'BUY',
            type: 'TAKE_PROFIT_MARKET',
            positionSide,
            stopPrice: takeProfitPrice,
            quantity,
            workingType: 'MARK_PRICE',
            reduceOnly: true
        };
        
        const [slResult, tpResult] = await Promise.allSettled([
            (async () => {
                try {
                    const result = await this.placeOrder(slParams);
                    return { success: true, order: result, type: 'regular' };
                } catch (e) {
                    if (e.response?.data?.code === -4120) {
                        try {
                            const result = await this.placeAlgoOrder(slParams);
                            return { success: true, order: result, type: 'algo' };
                        } catch (algoErr) {
                            return { success: false, error: algoErr };
                        }
                    } else {
                        return { success: false, error: e };
                    }
                }
            })(),
            (async () => {
                try {
                    const result = await this.placeOrder(tpParams);
                    return { success: true, order: result, type: 'regular' };
                } catch (e) {
                    if (e.response?.data?.code === -4120) {
                        try {
                            const result = await this.placeAlgoOrder(tpParams);
                            return { success: true, order: result, type: 'algo' };
                        } catch (algoErr) {
                            return { success: false, error: algoErr };
                        }
                    } else {
                        return { success: false, error: e };
                    }
                }
            })()
        ]);
        
        if (slResult.status === 'fulfilled' && slResult.value.success) {
            slOrder = slResult.value.order;
        }
        if (tpResult.status === 'fulfilled' && tpResult.value.success) {
            tpOrder = tpResult.value.order;
        }
        
        if (!slOrder && !tpOrder) {
            throw new Error('Both TP and SL orders failed - position has no protection');
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
    
    // Essential exports only
    getPrice: marketData.getPrice,
    getExchangeInfo: marketData.getExchangeInfo,
    isSymbolTradable: marketData.isSymbolTradable.bind(marketData),
    getPositionInfo: account.getPositionInfo,
    changeInitialLeverage: account.changeInitialLeverage,
    getSymbolPrecision: utils.getSymbolPrecision
};
