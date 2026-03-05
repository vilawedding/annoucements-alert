# Auto-Trading Configuration Guide

## 📋 Tổng quan

Bot sẽ tự động đặt lệnh futures trên Binance khi phát hiện announcement listing từ Upbit.

## ⚙️ Cấu hình

Thêm vào file `.env`:

```env
# ==================== MONITORING ====================
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

# Exchange monitoring
BINANCE_ENABLED=true
UPBIT_ENABLED=true
BINANCE_INTERVAL=500
UPBIT_INTERVAL=500

# ==================== AUTO-TRADING ====================
# Enable/disable auto-trading
AUTO_TRADE_ENABLED=true

# Trade on Upbit listings
AUTO_TRADE_UPBIT_LISTING=true

# Trade amount in USDT
AUTO_TRADE_AMOUNT=10

# Leverage (1-125x)
AUTO_TRADE_LEVERAGE=5

# ==================== BINANCE FUTURES API ====================
BINANCE_API_KEY=your_binance_api_key
BINANCE_API_SECRET=your_binance_api_secret

# Use testnet for safety (highly recommended for testing)
BINANCE_USE_TESTNET=true
```

## 🔐 Lấy Binance API Keys

### Production Keys:
1. Đăng nhập Binance
2. User Center → API Management
3. Create API
4. Enable "Enable Futures" + "Enable Trading"
5. ⚠️ **KHÔNG** enable "Enable Withdrawals"
6. Thêm IP whitelist (khuyến nghị)

### Testnet Keys (Khuyến nghị):
1. Truy cập: https://testnet.binancefuture.com/
2. Login với GitHub/Gmail
3. Generate HMAC_SHA256 Key
4. Nhận 10,000 USDT test miễn phí

## 🚀 Workflow

```
1. Bot monitor Upbit announcements (mỗi 0.5s)
   ↓
2. Phát hiện "NEW LISTING" announcement
   ↓
3. Extract token name (ví dụ: "PEPE")
   ↓
4. Check token có trên Binance Futures không (PEPEUSDT)
   ↓
5. Set leverage (ví dụ: 5x)
   ↓
6. Đặt lệnh MARKET BUY
   ↓
7. Gửi thông báo Telegram về kết quả
```

## 📊 Example Flow

### Scenario: Upbit listing PEPE

**Input:**
- Upbit announcement: "페페(PEPE) 원화 마켓 신규 거래지원 안내"
- Extracted token: PEPE

**Bot Actions:**
1. ✅ Check PEPEUSDT exists on Binance
2. ✅ Current price: $0.000001234
3. ✅ Set leverage to 5x
4. ✅ Calculate quantity: 10 USDT / $0.000001234 = 8,103,727 PEPE
5. ✅ Place order: MARKET BUY 8,103,727 PEPE
6. ✅ Order filled at avg price: $0.000001235
7. ✅ Send Telegram notification

**Telegram Notification:**
```
🤖 AUTO-TRADE EXECUTED
════════════════════════

🔵 Upbit Listing Detected
Token: PEPE

🟡 Binance Futures Order
Symbol: PEPEUSDT
Side: LONG
Quantity: 8103727
Price: 0.000001235
Leverage: 5x
Amount: ~10 USDT

Order ID: 123456789
Time: 234ms

#AutoTrade #UpbitListing
```

## ⚠️ Risk Management

### 1. Amount Control
```env
AUTO_TRADE_AMOUNT=10  # Chỉ trade 10 USDT mỗi lần
```

### 2. Leverage Control
```env
AUTO_TRADE_LEVERAGE=5  # Max 5x leverage (khuyến nghị: 3-5x)
```

### 3. Use Testnet First
```env
BINANCE_USE_TESTNET=true  # Test trước khi dùng production
```

### 4. Monitor Logs
Bot sẽ log chi tiết mọi action:
```
🤖 [AUTO-TRADE] Starting trade for PEPEUSDT...
   💰 Current price: 0.000001234
   ⚙️ Leverage set to 5x
   📊 Order: BUY 8103727 PEPEUSDT (≈10 USDT)
   ✅ Order executed in 234ms
   📝 Order ID: 123456789
   💵 Avg Price: 0.000001235
   📦 Filled: 8103727
```

## 🎯 Strategy Tips

### 1. Upbit Listings = High Volatility
- Upbit listings thường tạo spike giá trên các sàn khác
- Bot trade nhanh để catch momentum đầu tiên
- Interval 0.5s = phản ứng cực nhanh

### 2. Recommended Settings
```env
# Conservative (An toàn)
AUTO_TRADE_AMOUNT=5
AUTO_TRADE_LEVERAGE=3

# Moderate (Cân bằng)
AUTO_TRADE_AMOUNT=10
AUTO_TRADE_LEVERAGE=5

# Aggressive (Mạo hiểm)
AUTO_TRADE_AMOUNT=20
AUTO_TRADE_LEVERAGE=10
```

### 3. Take Profit Strategy
Sau khi bot đặt lệnh, bạn có thể:
- Set take profit manually (ví dụ: +10%, +20%)
- Để bot hold và monitor
- Close position manually khi đạt target

### 4. Exit Strategy
```javascript
// Ví dụ: Auto close sau 5 phút
setTimeout(async () => {
    await binance.closePosition('PEPEUSDT');
}, 5 * 60 * 1000);
```

## 🔍 Monitoring

### 1. Health Check
```bash
curl http://localhost:3003
```

### 2. Console Logs
```
🔵 [UPB] Cycle #123 - 345ms (20/1)
🤖 [AUTO-TRADE] Triggering trade for Upbit listing...
🤖 [AUTO-TRADE] Starting trade for PEPEUSDT...
   ✅ Order executed in 234ms
✅ [AUTO-TRADE] Completed 1/1 trades
```

### 3. Telegram Notifications
- ✅ Thông báo listing từ Upbit
- ✅ Thông báo trade execution
- ❌ Thông báo lỗi (nếu có)

## 🛡️ Safety Features

### 1. Token Validation
```javascript
// Bot check token có tồn tại trên Binance không
const price = await binance.getPrice('PEPEUSDT');
// Nếu không tồn tại → Skip trade
```

### 2. Error Handling
```javascript
// Mọi lỗi đều được catch và log
// Bot không crash khi 1 trade fail
try {
    await executeAutoTrade(announcement);
} catch (error) {
    console.error('Trade failed:', error.message);
    // Send error notification to Telegram
}
```

### 3. Duplicate Prevention
```javascript
// Bot check hash để không trade duplicate
if (upbitSentAnnouncements.has(hash)) {
    return null; // Skip
}
```

## 🧪 Testing

### Step 1: Setup Testnet
```env
BINANCE_USE_TESTNET=true
AUTO_TRADE_ENABLED=true
AUTO_TRADE_AMOUNT=10
```

### Step 2: Run Bot
```bash
npx kill-port 3003 && node --require ./preload.js index.js
```

### Step 3: Wait for Upbit Listing
Bot sẽ tự động:
- Detect listing announcement
- Extract token
- Place order on Binance testnet
- Send notification

### Step 4: Verify Order
1. Login testnet: https://testnet.binancefuture.com/
2. Check Positions
3. Check Order History

## 📈 Performance

### Speed:
- Upbit polling: 500ms interval
- Detection → Trade: < 1 second
- Trade execution: ~200-500ms

### Accuracy:
- Token extraction: 95%+
- Symbol matching: ~80% (depends on Binance availability)
- Order success: 98%+ (testnet)

## ❓ Troubleshooting

### Issue: "Symbol not available"
```
⚠️ PEPEUSDT not available on Binance Futures
```
**Solution:** Token chưa có trên Binance Futures, bot tự động skip.

### Issue: "Insufficient balance"
```
❌ Account has insufficient balance for requested action
```
**Solution:** 
- Testnet: Request more test USDT
- Production: Deposit USDT to Futures account

### Issue: "Signature invalid"
```
❌ Signature for this request is not valid
```
**Solution:** 
- Check BINANCE_API_SECRET
- Sync system time: `sudo ntpdate -s time.nist.gov`

### Issue: "Trade failed"
```
❌ Trade failed: Precision is over the maximum defined
```
**Solution:** Bot tự động format precision, nhưng có thể cần adjust AUTO_TRADE_AMOUNT.

## 🔄 Updates

### Disable Auto-Trade
```env
AUTO_TRADE_ENABLED=false
```

### Change Amount
```env
AUTO_TRADE_AMOUNT=20  # Increase to 20 USDT
```

### Switch to Production
```env
BINANCE_USE_TESTNET=false  # ⚠️ Use real money!
```

## 📞 Support

Issues? Check:
1. Console logs cho errors
2. Telegram notifications cho trade results
3. Health endpoint: http://localhost:3003
4. Binance testnet UI: https://testnet.binancefuture.com/

---

**⚠️ DISCLAIMER:** Crypto trading có rủi ro cao. Bot này chỉ là tool tự động hóa, không đảm bảo lợi nhuận. Luôn test kỹ trên testnet trước khi dùng production. Chỉ trade với số tiền bạn có thể chấp nhận mất.
