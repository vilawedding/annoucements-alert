# ⚡ Quick Start Guide - Lightning Fast Bot

## 1. Setup (2 minutes)

### Install Dependencies
```bash
npm install
```

### Configure Environment
Copy template and fill in your credentials:
```bash
cp .env.example .env
```

**Minimum required in .env**:
```env
# Telegram (get from @BotFather on Telegram)
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklmnoPQRstuvWXYZ
TELEGRAM_CHAT_ID=987654321

# Binance API (for auto-trading)
BINANCE_API_KEY=your_binance_key_here
BINANCE_API_SECRET=your_binance_secret_here

# Safety: Use testnet for first run
BINANCE_USE_TESTNET=true
```

### Test Configuration
```bash
npm test
```

Expected output: ✅ INTEGRATION TEST PASSED

---

## 2. Run the Bot (1 command)

### Production Mode
```bash
npm start
```

Or with logging:
```bash
npm start 2>&1 | tee bot.log
```

Expected output:
```
⚡ MULTI-EXCHANGE CRYPTO MONITOR - LIGHTNING FAST
================================================
Alert → Trade in <1 second

✅ Configuration loaded
🤖 Telegram Bot: Connected

📊 Enabled exchanges:
   ✅ Binance (500ms interval)
   ✅ Upbit (500ms interval)

⚡ Auto-trading (Lightning Fast):
   ✅ Auto-trade ENABLED
   💰 Trade Amount: 10 USDT
   📊 Leverage: 5x
   🔵 Upbit Listing: ENABLED
   🌐 Binance: TESTNET

⚡ Optimizations enabled:
   ✅ Non-blocking Telegram queue
   ✅ Parallel price & precision fetching
   ✅ Smart caching for symbol data
   ✅ Async leverage setting
   ✅ Minimal delays between trades
   ✅ Fast token extraction

🚀 Health server running on port 3003
📊 Check performance: curl http://localhost:3003

✅ Binance monitor started (500ms interval)
✅ Upbit monitor started (500ms interval)

⚡ Bot is now running with LIGHTNING FAST execution!
```

---

## 3. Monitor Performance

### Check Health in Another Terminal
```bash
curl http://localhost:3003 | jq .
```

Key metrics to watch:
- `performance.totalLatency.last` - Should be <1000ms
- `stats.upbitSent` - Tracks announcements detected

### Real-Time Logs
```bash
# Show only trading activity
tail -f bot.log
```

Filter by type:
```bash
# Upbit announcements only
grep "🔵 \[UPB\]"

# Auto-trades only
grep "⚡ \[AUTO-TRADE\]"

# Errors only
grep "❌"
```

---

## 4. What It Does

### On Upbit Listing
```
Upbit broadcasts: "Listing Announcement: NEW TRADING PAIR XYZ/KRW"
         ↓ (detected in 500ms)
Extract token: XYZ
         ↓ (1-2ms)
Binance lookup: XYZUSDT
         ↓ (50-100ms parallel fetch)
Set leverage: 5x (async, non-blocking)
         ↓ (0ms wait)
Market buy: 10 USDT worth of XYZ
         ↓ (50-150ms)
Queue notification: Send Telegram message (async)
         ↓ (in background)
Total time: <300ms ⚡
```

### Telegram Message
```
📢 NEW LISTING DETECTED - Upbit

🆕 Announcement: "Listing XYZ/KRW"
🔍 Token: XYZ
🚀 Status: Trading started

------ AUTO-TRADE ------
📊 Pair: XYZUSDT
💰 Amount: 10 USDT
📈 Leverage: 5x
⏱️ Execution: 245ms
✅ Order ID: 123456789
```

---

## 5. Test Auto-Trading (Optional)

### Interactive Test
```bash
node --require ./preload.js test-auto-trade.js
```

Walk through:
1. Select a token to trade
2. Choose action (buy/sell)
3. Confirm order
4. Watch execution metrics

---

## 6. Safety Tips

### For Testing/Development
✅ **Always use testnet first**:
```env
BINANCE_USE_TESTNET=true
```

✅ **Start with small amounts**:
```env
AUTO_TRADE_AMOUNT=1
```

✅ **Disable auto-trading initially**:
```env
AUTO_TRADE_ENABLED=false
```

### Before Going Live
1. Test with testnet for 24 hours
2. Verify Telegram notifications work
3. Monitor performance metrics
4. Then switch to production:
```env
BINANCE_USE_TESTNET=false
AUTO_TRADE_AMOUNT=10
AUTO_TRADE_ENABLED=true
```

---

## 7. File Structure

```
annoucements-alert/
├─ index-new.js                              # Main entry point (Lightning Fast)
├─ test-integration.js                       # Integration tests
├─ test-auto-trade.js                        # Interactive trading test
├─ config/
│  └─ config.js                              # Centralized configuration
├─ modules/
│  ├─ trading/
│  │  ├─ binance-futures.js                  # Binance USDS-M Futures API
│  │  └─ index.js
│  ├─ monitoring/
│  │  ├─ binance-monitor.js                  # Binance announcement checker
│  │  ├─ upbit-monitor.js                    # Upbit announcement checker
│  │  └─ index.js
│  ├─ notifications/
│  │  ├─ telegram.js                         # Telegram messaging
│  │  └─ index.js
│  ├─ storage/
│  │  ├─ storage-manager.js                  # File-based persistence
│  │  └─ index.js
│  └─ automation/
│     ├─ lightning-trader.js                 # ⚡ Ultra-fast auto-trader
│     ├─ fast-cache.js                       # Symbol data caching
│     ├─ performance-optimizer.js            # Latency tracking
│     └─ index.js
├─ .env                                      # Your configuration (DON'T COMMIT)
├─ .env.example                              # Template
├─ package.json                              # Dependencies
├─ preload.js                                # Electron/Node fix
├─ LIGHTNING_FAST_OPTIMIZATION.md            # Technical deep dive
└─ README.md
```

---

## 8. Troubleshooting

### Bot won't start
```bash
# Check Node version (needs 14+)
node --version

# Check dependencies installed
npm ls

# Check for port conflicts
lsof -i :3003
```

### No Telegram messages
```bash
# Verify bot token is correct
grep TELEGRAM_BOT_TOKEN .env

# Check if bot is started
curl http://localhost:3003

# Check logs for telegram errors
grep "Telegram" /tmp/bot.log
```

### Trades not executing
```bash
# Verify API keys set
grep BINANCE_API .env

# Check testnet mode
grep BINANCE_USE_TESTNET .env

# Run auto-trade test
node --require ./preload.js test-auto-trade.js
```

### Performance slow
```bash
# Check network latency
curl -w "Time: %{time_total}s\n" https://api.binance.com/api/v1/ping

# Monitor system resources
top -p $(pgrep -f "index-new.js")

# Check performance stats endpoint
curl http://localhost:3003 | jq .performance
```

---

## 9. Commands Reference

### Start Bot
```bash
node --require ./preload.js index-new.js
```

### Test Configuration
```bash
node test-integration.js
```

### Test Auto-Trading
```bash
node --require ./preload.js test-auto-trade.js
```

### Kill Bot
```bash
# From another terminal
lsof -i :3003 | grep node | awk '{print $2}' | xargs kill -9
# OR
Ctrl+C in bot terminal
```

### Check Health
```bash
curl http://localhost:3003 | jq .
```

### View Logs
```bash
tail -f /tmp/bot.log
```

---

## 10. Next Steps

### If It's Working
🎉 Congrats! Your bot is now:
- ✅ Monitoring Binance & Upbit announcements
- ✅ Executing trades in <300ms
- ✅ Sending Telegram notifications
- ✅ Tracking performance metrics

### Optional Enhancements
1. **Add more exchanges** → Create new monitor module
2. **Add risk management** → Update lightning-trader.js
3. **Dashboard** → Add WebSocket server
4. **Analytics** → Store metrics in SQLite

See [LIGHTNING_FAST_OPTIMIZATION.md](./LIGHTNING_FAST_OPTIMIZATION.md) for details.

---

## 11. Support

### Check Documentation
- [LIGHTNING_FAST_OPTIMIZATION.md](./LIGHTNING_FAST_OPTIMIZATION.md) - Technical details
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design
- [BINANCE_TRADING.md](./BINANCE_TRADING.md) - API reference
- [AUTO_TRADING_GUIDE.md](./AUTO_TRADING_GUIDE.md) - Trading guide

### Debug Mode
```javascript
// Add to index-new.js for extra logging
process.env.DEBUG = 'lightning:*';
```

---

**Ready to trade at lightning speed!** ⚡🚀
