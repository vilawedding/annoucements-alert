# Binance Futures Trading Module

Module để giao dịch Binance USDS-M Futures với Node.js

## 📦 Setup

### 1. Cài đặt dependencies
```bash
npm install axios dotenv crypto
```

### 2. Cấu hình API Keys

Thêm vào file `.env`:

```env
# Binance Futures API
BINANCE_API_KEY=your_api_key_here
BINANCE_API_SECRET=your_api_secret_here
BINANCE_USE_TESTNET=true  # true = testnet, false = production
```

⚠️ **QUAN TRỌNG:** 
- Luôn dùng **TESTNET** khi test code mới
- KHÔNG bao giờ commit API keys vào Git
- Testnet API keys lấy tại: https://testnet.binancefuture.com/

### 3. Lấy API Keys

**Production:**
1. Đăng nhập Binance
2. Vào API Management
3. Tạo API Key mới
4. Bật quyền "Enable Futures" và "Enable Trading"
5. Thêm IP whitelist (khuyến nghị)

**Testnet:**
1. Truy cập: https://testnet.binancefuture.com/
2. Đăng nhập bằng GitHub/Gmail
3. Generate HMAC_SHA256 key
4. Nhận test USDT miễn phí

## 🚀 Usage

### Import module

```javascript
const binance = require('./binance-trading');
```

### Market Data (không cần API key)

```javascript
// Test kết nối
await binance.testConnectivity();

// Lấy giá hiện tại
const price = await binance.getPrice('BTCUSDT');
console.log(price.price);

// Lấy 24h ticker
const ticker = await binance.get24hrTicker('BTCUSDT');
console.log(ticker.priceChangePercent);

// Lấy order book
const orderBook = await binance.getOrderBook('BTCUSDT', 20);
console.log(orderBook.bids); // [[price, quantity], ...]
console.log(orderBook.asks);

// Lấy best bid/ask
const bookTicker = await binance.getBookTicker('BTCUSDT');
console.log(`Bid: ${bookTicker.bidPrice}, Ask: ${bookTicker.askPrice}`);
```

### Account Info (cần API key)

```javascript
// Lấy balance
const balance = await binance.getBalance();
balance.forEach(asset => {
    if (parseFloat(asset.balance) > 0) {
        console.log(`${asset.asset}: ${asset.balance}`);
    }
});

// Lấy thông tin positions
const positions = await binance.getPositionInfo('BTCUSDT');
console.log(positions);

// Thay đổi leverage
await binance.changeInitialLeverage('BTCUSDT', 10); // 10x

// Thay đổi margin type
await binance.changeMarginType('BTCUSDT', 'ISOLATED'); // or 'CROSSED'
```

### Trading - Market Orders

```javascript
// Market Buy
const buyOrder = await binance.marketBuy('BTCUSDT', 0.001);
console.log('Order ID:', buyOrder.orderId);

// Market Sell
const sellOrder = await binance.marketSell('BTCUSDT', 0.001);
```

### Trading - Limit Orders

```javascript
// Limit Buy
const limitBuy = await binance.limitBuy(
    'BTCUSDT',  // symbol
    0.001,      // quantity
    40000,      // price
    'BOTH',     // positionSide
    'GTC'       // timeInForce
);

// Limit Sell
const limitSell = await binance.limitSell('BTCUSDT', 0.001, 45000);
```

### Order Management

```javascript
// Lấy open orders
const openOrders = await binance.getOpenOrders('BTCUSDT');
console.log(openOrders);

// Lấy thông tin 1 order
const order = await binance.getOrder('BTCUSDT', orderId);

// Cancel 1 order
await binance.cancelOrder('BTCUSDT', orderId);

// Cancel tất cả orders của symbol
await binance.cancelAllOpenOrders('BTCUSDT');

// Lấy lịch sử orders
const allOrders = await binance.getAllOrders('BTCUSDT', 100);
```

### Position Management

```javascript
// Close position
await binance.closePosition('BTCUSDT');

// Check position
const positions = await binance.getPositionInfo('BTCUSDT');
const position = positions.find(p => p.symbol === 'BTCUSDT');
console.log('Position Amount:', position.positionAmt);
console.log('Unrealized PnL:', position.unRealizedProfit);
```

### Utilities

```javascript
// Lấy precision của symbol
const precision = await binance.getSymbolPrecision('BTCUSDT');
console.log('Price Precision:', precision.pricePrecision);
console.log('Quantity Precision:', precision.quantityPrecision);

// Format quantity và price đúng precision
const qty = binance.formatQuantity(0.0012345, precision.quantityPrecision);
const price = binance.formatPrice(40123.456789, precision.pricePrecision);
```

## 📝 Examples

Chạy file example:

```bash
node binance-example.js
```

## 🔑 API Key Permissions

Cần enable các permissions sau:
- ✅ **Enable Reading** - Xem thông tin account
- ✅ **Enable Futures** - Trading futures
- ✅ **Enable Trading** - Đặt/hủy orders

## ⚡ Rate Limits

Binance có rate limits:
- Market data: 2400 requests/minute
- Orders: 1200 orders/minute
- Trading: 300 orders/10 seconds

Module tự động retry khi gặp rate limit errors.

## 🛡️ Security Best Practices

1. **KHÔNG** commit API keys vào Git
2. Luôn dùng **TESTNET** khi test
3. Enable **IP Whitelist** trên production
4. Dùng **Sub-accounts** cho trading bots
5. Set **API restrictions** (chỉ cho phép trading, không withdraw)
6. Rotate API keys định kỳ

## 📚 Documentation

- [Binance Futures API Docs](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)
- [API Rate Limits](https://www.binance.com/en/support/faq/360004492232)
- [Error Codes](https://binance-docs.github.io/apidocs/futures/en/#error-codes)

## 🐛 Common Errors

### "API-key format invalid"
- Check BINANCE_API_KEY trong .env
- Key phải có format đúng (64 ký tự)

### "Signature for this request is not valid"
- Check BINANCE_API_SECRET trong .env
- Đảm bảo system time đồng bộ

### "Insufficient balance"
- Check balance với `getBalance()`
- Dùng testnet để test với fake USDT

### "Precision is over the maximum defined"
- Dùng `getSymbolPrecision()` để lấy precision
- Format quantity/price với `formatQuantity()` / `formatPrice()`

## 📊 Trading Strategy Integration

Example: Auto trade khi có announcement mới

```javascript
const binance = require('./binance-trading');

async function tradeOnAnnouncement(token) {
    const symbol = `${token}USDT`;
    
    try {
        // Check if symbol exists
        const price = await binance.getPrice(symbol);
        
        // Set leverage
        await binance.changeInitialLeverage(symbol, 5);
        
        // Place market buy
        const order = await binance.marketBuy(symbol, 100); // 100 USDT
        
        console.log(`✅ Bought ${symbol} at ${order.avgPrice}`);
        
        // Set take profit at +5%
        const takeProfitPrice = parseFloat(order.avgPrice) * 1.05;
        await binance.limitSell(symbol, 100, takeProfitPrice);
        
    } catch (error) {
        console.error('Trading error:', error.message);
    }
}
```

## 📞 Support

- Binance API Support: https://www.binance.com/en/support
- Telegram: @BinanceAPI
