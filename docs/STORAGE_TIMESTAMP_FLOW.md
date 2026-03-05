# Data Flow Diagram - Announcement Detection to Trade Execution

## Complete Flow with Timestamps

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ANNOUNCEMENT DETECTION                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────┐
                    │  Upbit/Binance Monitor   │
                    │  Fetches Announcements   │
                    └──────────────────────────┘
                                    │
                                    ├─ Extract: symbol, title, link
                                    │
                                    ├─ Capture: detectedAt = Date.now()
                                    │           (1699123456789)
                                    │
                                    ▼
                        ┌──────────────────────────┐
                        │  Create Metadata Object  │
                        │  {                       │
                        │    symbol: 'BTCUSDT',    │
                        │    title: '...',         │
                        │    link: '...',          │
                        │    exchange: 'UPBIT',    │
                        │    detectedAt: 1699..., │
                        │    orderedAt: null,      │
                        │    latency: null         │
                        │  }                       │
                        └──────────────────────────┘
                                    │
                                    ▼
                        ┌──────────────────────────┐
                        │  Storage Module          │
                        │  .add(hash, metadata,    │
                        │       'UPBIT')           │
                        └──────────────────────────┘
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────┐
        │  JSON File: data/sent_announcements_upbit.json    │
        │  {                                                 │
        │    "58694453f06fe9afad3a30b0121c43b5": {         │
        │      "symbol": "BTCUSDT",                         │
        │      "title": "New Listing: Bitcoin (BTC)",       │
        │      "link": "https://...",                       │
        │      "exchange": "UPBIT",                         │
        │      "detectedAt": 1699123456789,     <─────┐    │
        │      "orderedAt": null,                     │    │
        │      "latency": null                        │    │
        │    }                                        │    │
        │  }                                          │    │
        └───────────────────────────────────────────┼─────┘
                                                    │ STORAGE SAVED
                                                    │ (Non-blocking)

┌─────────────────────────────────────────────────────────────────────────┐
│                    TRADE EXECUTION (Auto-Trade)                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────┐
                    │  Lightning Auto Trader   │
                    │  Receives Announcement   │
                    │  with Detection Time    │
                    └──────────────────────────┘
                                    │
                                    ├─ Extract token: BTC
                                    ├─ Get price data
                                    ├─ Calculate quantity
                                    │
                                    ▼
                        ┌──────────────────────────┐
                        │  Place Market Buy Order  │
                        │  BTCUSDT 0.05 BTC        │
                        │  Execution Time: 45ms    │
                        └──────────────────────────┘
                                    │
                                    ▼ ORDER SUCCESSFUL
                        ┌──────────────────────────┐
                        │  Capture Order Time      │
                        │  orderedAt = Date.now()  │
                        │  (1699123456950)         │
                        └──────────────────────────┘
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────┐
        │  Storage Module                                    │
        │  .recordOrderExecution(hash,                      │
        │       1699123456950, 'UPBIT')                    │
        │                                                    │
        │  Automatically calculates:                        │
        │  latency = 1699123456950 - 1699123456789         │
        │  latency = 161 milliseconds                       │
        └───────────────────────────────────────────────────┘
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────┐
        │  JSON File: data/sent_announcements_upbit.json    │
        │  {                                                 │
        │    "58694453f06fe9afad3a30b0121c43b5": {         │
        │      "symbol": "BTCUSDT",                         │
        │      "title": "New Listing: Bitcoin (BTC)",       │
        │      "link": "https://...",                       │
        │      "exchange": "UPBIT",                         │
        │      "detectedAt": 1699123456789,                │
        │      "orderedAt": 1699123456950,    <────┐      │
        │      "latency": 161                <─────┤──┐   │
        │    }                                   │  │   │   │
        │  }                                     │  │   │   │
        │                              UPDATED  │  │  AUTO- │
        │                           (Non-block) │  │ CALC'd │
        └───────────────────────────────────────┼──┼───────┘
                                                │  │
                                    Detection  │  │ Latency
                                    Timestamp  │  │ 161ms
                                               │  │
                                    Time: 1699123456789 → 1699123456950
                                    Delta: ════════════════════════ 161ms
```

## Storage State Machine

```
INITIAL STATE
├─ Hash not in storage
└─ Announcement not seen before

                    │
                    ▼ Monitor detects announcement

        ┌─────────────────────────────────┐
        │  STORED - AWAITING TRADE        │
        ├─────────────────────────────────┤
        │ symbol: "BTCUSDT"               │
        │ title: "New Listing..."         │
        │ link: "https://..."             │
        │ detectedAt: 1699123456789       │
        │ orderedAt: null ◄── NOT YET    │
        │ latency: null ◄── NOT YET      │
        └─────────────────────────────────┘
                    │
                    ▼ Trade executed

        ┌─────────────────────────────────┐
        │  STORED - TRADE COMPLETED       │
        ├─────────────────────────────────┤
        │ symbol: "BTCUSDT"               │
        │ title: "New Listing..."         │
        │ link: "https://..."             │
        │ detectedAt: 1699123456789       │
        │ orderedAt: 1699123456950 ◄─── │
        │ latency: 161 ◄─── AUTO-CALC'd │
        └─────────────────────────────────┘
                    │
                    └─ Ready for analytics/audit
```

## Timing Diagram

```
Timeline (milliseconds)

Detection Event (Upbit API returns announcement)
│
├─ [T: 1699123456789] ─ Monitor captures announcementTime
│   └─ Create metadata with detectedAt = 1699123456789
│   └─ Store in JSON: {detectedAt: 1699123456789, orderedAt: null}
│   └─ Send Telegram notification (async)
│
├─ [T: 1699123456789 + ~50ms] ─ Trade decision made
│   └─ Check if auto-trade enabled
│   └─ Extract symbol: BTCUSDT
│   └─ Fetch price data (API call)
│
├─ [T: 1699123456789 + ~100ms] ─ Place order
│   └─ Market buy order: 0.05 BTC @ current price
│   └─ Order placed successfully
│
├─ [T: 1699123456950] ─ Order Execution
│   └─ Capture orderTime = Date.now()
│   └─ Call: storage.recordOrderExecution(hash, 1699123456950, 'UPBIT')
│   └─ Storage auto-calculates: latency = 1699123456950 - 1699123456789
│   └─ latency = 161 milliseconds ◄─── ACHIEVEMENT
│   └─ Save updated JSON with orderedAt & latency
│   └─ Send Telegram trade confirmation (async)
│
└─ [T: 1699123456950 + ...] ─ Analytics available
    └─ Query: storage.getDetails(hash, 'UPBIT')
    └─ Returns: {symbol, title, link, detectedAt, orderedAt, latency}
    └─ Analysis: Bot detected and traded in 161ms


LATENCY BREAKDOWN:
═════════════════════════════════════════════════════════════════
Announcement Detection to Trade Execution
═════════════════════════════════════════════════════════════════

Component                           | Time (ms)
────────────────────────────────────┼───────────
Monitoring API fetch                │ ~30ms
Announcement parsing                │ ~5ms
Token extraction                    │ ~1ms
Storage (non-blocking)              │ <1ms
Telegram send (async)               │ ~50ms
Trade decision logic                │ ~3ms
Price fetch + Symbol precision      │ ~35ms (parallel)
Market order placement              │ ~30ms
────────────────────────────────────┼───────────
TOTAL LATENCY                       │ 161ms ◄── Recorded!
════════════════════════════════════════════════════════════════
```

## Key Improvements Over Old System

### Before (Set-based storage)
```
Monitor: storage.add(hash, 'UPBIT')
  └─ Stores only: "58694453f06fe9afad3a30b0121c43b5"
  └─ No metadata, no timestamps, no audit trail

Result: {
  "58694453f06fe9afad3a30b0121c43b5"
}
```

### After (Object-based storage with metadata)
```
Monitor: storage.add(hash, metadata, 'UPBIT')
  └─ Stores full object with: symbol, title, link, detectedAt
  └─ Enables timestamp tracking
  └─ Trader: storage.recordOrderExecution(hash, orderTime, 'UPBIT')
  └─ Auto-calculates latency

Result: {
  "58694453f06fe9afad3a30b0121c43b5": {
    "symbol": "BTCUSDT",
    "title": "New Listing: Bitcoin (BTC)",
    "link": "https://...",
    "exchange": "UPBIT",
    "detectedAt": 1699123456789,
    "orderedAt": 1699123456950,
    "latency": 161  ◄─── NEW CAPABILITY
  }
}
```

## Query Examples

```javascript
// Get all announcements for Upbit
const upbitAnnouncements = storage.getAll('UPBIT');

// Loop through each announcement
for (const [hash, details] of Object.entries(upbitAnnouncements)) {
  console.log(`${details.symbol}: ${details.latency}ms`);
  // Output: BTCUSDT: 161ms
  //         ETHUSDT: 145ms
  //         null (not yet traded)
}

// Get detection time for specific announcement
const detectionMs = storage.getDetectionTime(hash, 'UPBIT');
const detectionDate = new Date(detectionMs).toISOString();
console.log(`Detected at: ${detectionDate}`);
// Output: Detected at: 2023-11-05T14:30:56.789Z

// Calculate average latency
const announcements = storage.getAll('UPBIT');
const tradedAnnouncements = Object.values(announcements)
  .filter(a => a.latency !== null);
const avgLatency = tradedAnnouncements.reduce((sum, a) => sum + a.latency, 0) 
  / tradedAnnouncements.length;
console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
```

## Analytics Dashboard (Future)

With this data format, we can build:
- ✅ Latency trends: How fast is the bot reacting?
- ✅ Exchange comparison: Upbit vs Binance detection speed
- ✅ Symbol analysis: Which symbols trade fastest?
- ✅ Historical audit: Complete trace of every announcement
- ✅ Performance metrics: Daily/hourly/minute-level analysis
- ✅ Bottleneck identification: Where are delays happening?
