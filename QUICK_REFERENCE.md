# Quick Reference - Detailed Metadata Storage

## 🎯 What Was Done

Updated announcement storage system to track detailed metadata with millisecond-precision timestamps:
- **Detection time** (when bot detected announcement)
- **Order time** (when trade was executed)
- **Latency** (milliseconds from detection to execution)
- **Symbol, title, link** (full announcement details)

---

## 📊 Storage Format

### Before ❌
```json
["hash1", "hash2", "hash3"]
```

### After ✅
```json
{
  "hash1": {
    "symbol": "BTCUSDT",
    "title": "New Listing",
    "link": "https://...",
    "exchange": "UPBIT",
    "detectedAt": 1699123456789,
    "orderedAt": 1699123456950,
    "latency": 161
  }
}
```

---

## 🔧 Modified Files

| File | Changes | Status |
|------|---------|--------|
| modules/storage/storage-manager.js | Complete refactor: Set → Object, new API methods | ✅ |
| modules/monitoring/upbit-monitor.js | Capture detectedAt, pass metadata to storage | ✅ |
| modules/monitoring/binance-monitor.js | Capture detectedAt, pass metadata to storage | ✅ |
| modules/automation/lightning-trader.js | Record orderedAt, auto-calculate latency | ✅ |

---

## 🔄 Data Flow

```
Announcement Detected
  ↓
Monitoring captures: detectedAt = Date.now()
  ↓
storage.add(hash, {symbol, title, link, detectedAt}, exchange)
  ↓
JSON saved with metadata

Trade Executed
  ↓
Trader captures: orderedAt = Date.now()
  ↓
storage.recordOrderExecution(hash, orderedAt, exchange)
  ↓
Auto-calc: latency = orderedAt - detectedAt
  ↓
JSON updated with orderedAt & latency
```

---

## 📱 API Methods

```javascript
// Store announcement with metadata
storage.add(hash, {
  symbol: 'BTCUSDT',
  title: 'New Listing...',
  link: 'https://...',
  exchange: 'UPBIT',
  detectedAt: Date.now(),
  orderedAt: null,
  latency: null
}, 'UPBIT');

// Record trade execution (auto-calculates latency)
storage.recordOrderExecution(hash, Date.now(), 'UPBIT');

// Get detection timestamp
const detected = storage.getDetectionTime(hash, 'UPBIT');

// Get all details
const details = storage.getDetails(hash, 'UPBIT');

// Get all announcements
const all = storage.getAll('UPBIT');
```

---

## ⏱️ Timestamps

All times are **milliseconds since epoch** (Date.now()):
- `detectedAt`: 1699123456789 (when announcement detected)
- `orderedAt`: 1699123456950 (when order executed)
- `latency`: 161 (milliseconds difference)

**Example calculation**:
```
latency = orderedAt - detectedAt
161ms = 1699123456950 - 1699123456789
```

---

## 📂 JSON Files

New format files created in `data/`:
- `sent_announcements_upbit.json` - Upbit announcements
- `sent_announcements_binance.json` - Binance announcements
- `sent_announcements.json` - All combined

Each uses object format with hash as key, metadata as value.

---

## ✨ Key Features

✅ **Millisecond Precision** - Date.now() for exact timestamps  
✅ **Automatic Latency** - Calculated when order recorded  
✅ **Full Metadata** - Symbol, title, link per announcement  
✅ **Audit Trail** - Complete history of every announcement  
✅ **Rich Queries** - Get details, detection time, all announcements  
✅ **Non-blocking** - Async JSON saves don't slow bot  
✅ **Readable JSON** - 2-space indentation for debugging  

---

## 🚀 Usage

```bash
# Start bot (uses new format automatically)
npm start

# Check latency statistics
node -e "
  const storage = require('./modules/storage');
  const all = storage.getAll('UPBIT');
  const latencies = Object.values(all)
    .filter(a => a.latency)
    .map(a => a.latency);
  console.log('Average latency:', 
    (latencies.reduce((a,b)=>a+b,0)/latencies.length).toFixed(2), 'ms');
"

# View sample announcement
cat data/sent_announcements_upbit.json | jq '.[keys[0]]'
```

---

## 📊 Sample Output

```json
{
  "symbol": "BTCUSDT",
  "title": "New Listing: Bitcoin (BTC)",
  "link": "https://www.upbit.com/notice",
  "exchange": "UPBIT",
  "detectedAt": 1699123456789,
  "orderedAt": 1699123456950,
  "latency": 161
}
```

---

## ❓ FAQ

**Q: What about announcements not yet traded?**  
A: `orderedAt` and `latency` remain `null` until trade executes

**Q: How accurate are the timestamps?**  
A: Millisecond precision using JavaScript Date.now()

**Q: Will old JSON files still work?**  
A: No - new bot will overwrite with new format on first run

**Q: Does this slow down the bot?**  
A: No - metadata captured asynchronously, saves are non-blocking

**Q: Can I query by symbol?**  
A: Current API doesn't support it, but data structure allows it

---

## 📖 More Info

For detailed information, see:
- **STORAGE_FORMAT_MIGRATION.md** - Format overview & API reference
- **STORAGE_TIMESTAMP_FLOW.md** - Flow diagrams & examples
- **IMPLEMENTATION_DETAILS.md** - Technical deep-dive
- **COMPLETION_REPORT.md** - Full implementation report

---

## ✅ Status

🟢 **COMPLETE & PRODUCTION READY**

All components integrated, tested, and documented.
