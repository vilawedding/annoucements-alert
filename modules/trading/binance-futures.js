const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const config = require('../../config/config');
const priceStream = require('./price-stream');

// Max age of a streamed price that may be used to size an order instead of a REST call.
const STREAM_PRICE_MAX_AGE_MS = parseInt(process.env.AUTO_TRADE_STREAM_PRICE_MAX_AGE_MS || '2000', 10);

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
// symbol -> contract delivery time (ms); a perpetual that Binance is delisting carries a near date
const deliveryTimes = new Map();
// symbol -> leverage brackets [{ initialLeverage, notionalFloor, notionalCap }] ascending by notional
const leverageBrackets = new Map();
// symbols confirmed on ISOLATED margin this run
const isolatedSymbols = new Set();
// symbol -> leverage last pre-set this run
const presetLeverages = new Map();
let isServerTimeSyncing = false;

function syncServerTimeInBackground() {
    if (isServerTimeSyncing) return;
    isServerTimeSyncing = true;

    marketData.getServerTime()
        .then((serverTime) => {
            const now = Date.now();
            serverTimeCache.time = serverTime;
            serverTimeCache.lastFetch = now;
            serverTimeCache.offsetMs = serverTime - now;
        })
        .catch(() => {})
        .finally(() => {
            isServerTimeSyncing = false;
        });
}

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
        // Use cached server time when available, otherwise local time + last known offset
        const now = Date.now();
        const timeSinceLastFetch = now - serverTimeCache.lastFetch;
        
        // If cache is fresh (within 30s), use it
        if (serverTimeCache.time && timeSinceLastFetch < 30000) {
            requestParams.timestamp = serverTimeCache.time + timeSinceLastFetch;
        } else {
            requestParams.timestamp = now + (serverTimeCache.offsetMs || 0);
            syncServerTimeInBackground();
        }

        // Tolerate small local/server drift without extra blocking call
        if (requestParams.recvWindow === undefined) {
            requestParams.recvWindow = 5000;
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

    /**
     * One exchangeInfo call (~1s, large payload) fills the tradable-symbol cache and
     * returns precision for every tradable perpetual, so no order has to download it.
     */
    async loadTradableSymbolPrecisions() {
        const exchangeInfo = await this.getExchangeInfo();
        const precisions = new Map();

        // Crypto perpetuals only: TRADIFI_PERPETUAL are stocks/metals whose tickers can
        // collide with coins (COINUSDT, GMEUSDT, HOODUSDT).
        // PENDING_TRADING = futures listing already announced: precision is known before
        // trading opens, so a signal right at open doesn't fall back to a ~1s exchangeInfo download.
        for (const s of exchangeInfo?.symbols || []) {
            if (!s || s.contractType !== 'PERPETUAL') continue;
            if (s.status === 'TRADING' || s.status === 'PENDING_TRADING') {
                precisions.set(s.symbol, utils.extractPrecision(s));
                deliveryTimes.set(s.symbol, Number(s.deliveryDate) || 0);
            }
        }

        // Fast pre-filter (isSymbolTradableCached) = "known crypto perpetual". Pending symbols
        // are included so one that opens between refreshes is not rejected locally; if it is
        // not open yet, Binance rejects the order and sniperRetry retries.
        tradableSymbolsCache = {
            symbols: new Set(precisions.keys()),
            lastFetch: Date.now()
        };

        return precisions;
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
    },

    /** Contract delivery time in ms from the preloaded exchangeInfo (null = unknown). */
    getDeliveryTimeCached(symbol) {
        return deliveryTimes.get(symbol) || null;
    },

    isSymbolTradableCached(symbol) {
        if (!tradableSymbolsCache.symbols) return null;
        return tradableSymbolsCache.symbols.has(symbol);
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

    /**
     * One signed call for every symbol's leverage brackets (this account's, so it reflects any
     * per-account limits), cached so an order never waits on it. Returns the number of symbols.
     */
    async loadLeverageBrackets() {
        const data = await makeRequest('GET', '/fapi/v1/leverageBracket', {}, true);
        for (const entry of Array.isArray(data) ? data : []) {
            const brackets = (entry?.brackets || [])
                .map(b => ({
                    initialLeverage: Number(b.initialLeverage),
                    notionalFloor: Number(b.notionalFloor) || 0,
                    notionalCap: Number(b.notionalCap) || Infinity
                }))
                .filter(b => b.initialLeverage > 0)
                .sort((a, b) => a.notionalFloor - b.notionalFloor);
            if (entry?.symbol && brackets.length) leverageBrackets.set(entry.symbol, brackets);
        }
        return leverageBrackets.size;
    },

    /**
     * Max leverage Binance allows for a position of this notional on the symbol
     * (null = brackets not loaded / unknown symbol, e.g. a listing newer than the last refresh).
     */
    getMaxLeverageCached(symbol, notional = 0) {
        const brackets = leverageBrackets.get(symbol);
        if (!brackets) return null;
        const bracket = brackets.find(b => notional < b.notionalCap) || brackets[brackets.length - 1];
        return bracket.initialLeverage;
    },
    
    /**
     * Highest leverage L such that a position of margin x L still fits a bracket allowing L
     * (sizing is margin x leverage, so the bracket depends on the leverage itself).
     */
    getMaxLeverageForMargin(symbol, margin) {
        const brackets = leverageBrackets.get(symbol);
        if (!brackets || !(margin > 0)) return null;
        let best = 0;
        for (const b of brackets) {
            const byCap = Number.isFinite(b.notionalCap) ? Math.ceil(b.notionalCap / margin) - 1 : Infinity;
            best = Math.max(best, Math.min(b.initialLeverage, byCap));
        }
        return best || null;
    },

    /** Put the symbol on ISOLATED margin once (remembered). -4046 = already isolated. */
    async ensureIsolated(symbol) {
        if (isolatedSymbols.has(symbol)) return;
        try {
            await makeRequest('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }, true);
        } catch (error) {
            const code = error.response?.data?.code;
            if (code !== -4046) throw error;
        }
        isolatedSymbols.add(symbol);
    },

    /** Isolate every USDT symbol (startup / refresh; skips ones already done). Returns { done, failed }. */
    async isolateAll(concurrency = 8) {
        const symbols = [...leverageBrackets.keys()].filter(s => s.endsWith('USDT') && !isolatedSymbols.has(s));
        let done = 0;
        let failed = 0;
        let next = 0;
        const worker = async () => {
            while (next < symbols.length) {
                const symbol = symbols[next++];
                try { await account.ensureIsolated(symbol); done++; } catch { failed++; }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        return { done, failed };
    },

    /**
     * Pre-set each USDT symbol's leverage so the first order already opens with it (the per-order
     * change races the order). Symbols already at the wanted value this run are skipped.
     */
    async presetLeverageAll(leverageFor, concurrency = 8) {
        const symbols = [...leverageBrackets.keys()].filter(s => s.endsWith('USDT'));
        let done = 0;
        let failed = 0;
        let next = 0;
        const worker = async () => {
            while (next < symbols.length) {
                const symbol = symbols[next++];
                const leverage = leverageFor(symbol);
                if (!leverage || presetLeverages.get(symbol) === leverage) continue;
                try {
                    await account.changeInitialLeverage(symbol, leverage);
                    presetLeverages.set(symbol, leverage);
                    done++;
                } catch { failed++; }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        return { done, failed };
    },

    async changeMarginType(symbol, marginType) {
        return await makeRequest('POST', '/fapi/v1/marginType', { symbol, marginType }, true);
    },

    /** Fills of this account on a symbol since startTime (realizedPnl + commission per fill). */
    async getUserTrades(symbol, startTime, limit = 1000) {
        return await makeRequest('GET', '/fapi/v1/userTrades', { symbol, startTime, limit }, true);
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
     * Reduce-only STOP_MARKET / TAKE_PROFIT_MARKET straight on the Algo Order API.
     * Production and demo both reject these on /fapi/v1/order with -4120 (checked on demo
     * 2026-10-13), so going algo-first saves one round trip per protective order.
     * Returns { algoId, ... }.
     */
    async placeConditional({ symbol, side, type, stopPrice, quantity, positionSide = 'BOTH' }) {
        return await this.placeAlgoOrder({
            symbol, side, type, positionSide, quantity, stopPrice,
            reduceOnly: true,
            workingType: 'MARK_PRICE'
        });
    },

    async cancelAlgoOrder(algoId) {
        return await makeRequest('DELETE', '/fapi/v1/algoOrder', { algoId }, true);
    },

    /** Cancels every resting regular and algo (conditional) order on the symbol. */
    async cancelAllSymbolOrders(symbol) {
        const results = await Promise.allSettled([
            makeRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true),
            makeRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol }, true)
        ]);
        return results.map(r => (r.status === 'fulfilled' ? 'ok' : (r.reason?.response?.data?.msg || r.reason?.message)));
    },

    /**
     * Market entry only (protective orders are the position manager's job).
     * side: 'BUY' (long) | 'SELL' (short). Returns { order, quantity, entryPrice, referencePrice }.
     * entryPrice: avgPrice from the order, else the position's entryPrice (demo answers
     * MARKET orders without avgPrice), else the reference price used for sizing.
     */
    async marketEntry(symbol, side, usdtAmount, precision, positionSide = 'BOTH') {
        if (!precision) {
            precision = await utils.getSymbolPrecision(symbol);
        }

        const referencePrice = await utils.getReferencePrice(symbol);
        if (!(referencePrice > 0)) throw new Error('Invalid price');

        const quantity = utils.formatQuantity(
            usdtAmount / referencePrice,
            precision.stepSize || precision.quantityPrecision
        );
        if (!(quantity > 0)) throw new Error(`Quantity rounds to 0 (amount=${usdtAmount} USDT, price=${referencePrice})`);

        const order = side === 'SELL'
            ? await this.marketSell(symbol, quantity, positionSide)
            : await this.marketBuy(symbol, quantity, positionSide);

        let entryPrice = parseFloat(order.avgPrice);
        if (!(entryPrice > 0)) {
            try {
                const positions = await account.getPositionInfo(symbol);
                const position = positions.find(p => p.symbol === symbol && p.positionSide === positionSide);
                const positionEntryPrice = position ? parseFloat(position.entryPrice) : NaN;
                if (positionEntryPrice > 0) entryPrice = positionEntryPrice;
            } catch (_) {}
        }
        if (!(entryPrice > 0)) entryPrice = referencePrice;

        const executedQty = parseFloat(order.executedQty);
        return {
            order,
            quantity: executedQty > 0 ? executedQty : quantity,
            entryPrice,
            referencePrice
        };
    },

    async marketClose(symbol, side, quantity, positionSide = 'BOTH') {
        return await this.placeOrder({
            symbol,
            side,
            type: 'MARKET',
            positionSide,
            quantity,
            reduceOnly: true,
            newOrderRespType: 'RESULT'
        });
    },
    
    /**
     * Market Buy with Take Profit and Stop Loss
     * Handles the complete flow: BUY → place SL → place TP with algo endpoint fallback
     * For newly listed symbols that require Algo Order API, automatically detects and switches
     */
    async marketBuyWithTPSL(symbol, usdtAmount, tpPercent, slPercent, positionSide = 'BOTH', precision = null, options = {}) {
        const { delayMs = 0, asyncProtection = false } = options;

        if (!precision) {
            precision = await utils.getSymbolPrecision(symbol);
        }
        
        const currentPrice = await utils.getReferencePrice(symbol);
        
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
        
        const placeProtectionOrders = async () => {
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
                slOrder,
                tpOrder
            };
        };

        if (asyncProtection) {
            placeProtectionOrders().catch((e) => {
                console.error(`[PROTECTION] ${symbol} async TP/SL failed: ${e.message}`);
            });

            return {
                ...order,
                quantity,
                entryPrice,
                takeProfitOrderId: null,
                stopLossOrderId: null,
                takeProfitPrice,
                stopLossPrice,
                protectionStatus: 'PENDING'
            };
        }

        await placeProtectionOrders();
        
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
        const { delayMs = 0, asyncProtection = false } = options;

        if (!precision) {
            precision = await utils.getSymbolPrecision(symbol);
        }
        
        const currentPrice = await utils.getReferencePrice(symbol);
        
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
        
        const placeProtectionOrders = async () => {
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
                slOrder,
                tpOrder
            };
        };

        if (asyncProtection) {
            placeProtectionOrders().catch((e) => {
                console.error(`[PROTECTION] ${symbol} async TP/SL failed: ${e.message}`);
            });

            return {
                ...order,
                quantity,
                entryPrice,
                takeProfitOrderId: null,
                stopLossOrderId: null,
                takeProfitPrice,
                stopLossPrice,
                protectionStatus: 'PENDING'
            };
        }

        await placeProtectionOrders();
        
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
        
        return utils.extractPrecision(symbolInfo);
    },

    extractPrecision(symbolInfo) {
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
    
    /**
     * Price used to size the order: streamed last price when fresh (saves one REST
     * round trip on the critical path), otherwise GET /ticker/price.
     */
    async getReferencePrice(symbol) {
        const streamed = priceStream.getFreshPrice(symbol, STREAM_PRICE_MAX_AGE_MS);
        if (streamed) return streamed;

        const priceData = await marketData.getPrice(symbol);
        return parseFloat(priceData.price);
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
    isSymbolTradableCached: marketData.isSymbolTradableCached.bind(marketData),
    getDeliveryTimeCached: marketData.getDeliveryTimeCached.bind(marketData),
    getPositionInfo: account.getPositionInfo,
    changeInitialLeverage: account.changeInitialLeverage,
    loadLeverageBrackets: account.loadLeverageBrackets,
    getMaxLeverageCached: account.getMaxLeverageCached,
    getMaxLeverageForMargin: account.getMaxLeverageForMargin,
    ensureIsolated: account.ensureIsolated,
    isolateAll: account.isolateAll,
    presetLeverageAll: account.presetLeverageAll,
    getSymbolPrecision: utils.getSymbolPrecision,
    loadTradableSymbolPrecisions: marketData.loadTradableSymbolPrecisions.bind(marketData),
    testConnectivity: marketData.testConnectivity,
    priceStream
};
