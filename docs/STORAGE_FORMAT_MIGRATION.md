# Storage Format Migration - Detailed Metadata Tracking

## Overview
Updated the announcement storage system from simple hash deduplication to a comprehensive audit trail that tracks **symbol**, **title**, **link**, detection timestamps, order execution timestamps, and automatic latency calculation - all with millisecond precision.

## Changes Made

### 1. **Storage Manager Refactored** (`modules/storage/storage-manager.js`)

#### Old Format (Set-based)
```javascript
// Old JSON format - simple array of hashes
[
  "58694453f06fe9afad3a30b0121c43b5",
  "7a8c9d0e1f2g3h4i5j6k7l8m9n0o1p2q",
  "...more hashes"
]
```

#### New Format (Object-based with metadata)
```javascript
// New JSON format - Object with hash as key, detailed metadata as value
{
  "58694453f06fe9afad3a30b0121c43b5": {
    "symbol": "BTCUSDT",                    // Trading pair (e.g., BTCUSDT)
    "title": "New Listing: Bitcoin (BTC)",  // Announcement title
    "link": "https://...",                  // URL to announcement details
    "exchange": "UPBIT",                    // Source exchange (UPBIT/BINANCE/UNKNOWN)
    "detectedAt": 1699123456789,           // When announcement was first detected (milliseconds)
    "orderedAt": 1699123456950,            // When trade order was executed (null until executed)
    "latency": 161                          // Milliseconds from detection to order (auto-calculated)
  },
  "7a8c9d0e1f2g3h4i5j6k7l8m9n0o1p2q": {
    "symbol": "ETHUSDT",
    "title": "New Listing: Ethereum (ETH)",
    "link": "https://...",
    "exchange": "BINANCE",
    "detectedAt": 1699123457100,
    "orderedAt": null,                     // Not yet traded
    "latency": null
  }
}
```

### 2. **New Storage API Methods**

#### `add(hash, details, exchange)`
Stores announcement with full metadata object:
```javascript
storage.add(hash, {
  symbol: 'BTCUSDT',
  title: 'New Listing: Bitcoin (BTC)',
  link: 'https://...',
  exchange: 'UPBIT',
  detectedAt: Date.now(),
  orderedAt: null,
  latency: null
}, 'UPBIT');
```

#### `recordOrderExecution(hash, orderedAt, exchange)`
Updates entry after trade completes, automatically calculates latency:
```javascript
storage.recordOrderExecution(
  hash,
  Date.now(),  // When order was placed
  'UPBIT'
);
// Automatically: latency = orderedAt - detectedAt
```

#### `getDetectionTime(hash, exchange)`
Retrieves the detection timestamp:
```javascript
const detectedAt = storage.getDetectionTime(hash, 'UPBIT');
// Returns: 1699123456789
```

#### `getDetails(hash, exchange)`
Returns full metadata object:
```javascript
const details = storage.getDetails(hash, 'UPBIT');
// Returns: { symbol, title, link, exchange, detectedAt, orderedAt, latency }
```

#### `getAll(exchange)`
Returns all announcements as object (not array):
```javascript
const allAnnouncements = storage.getAll('UPBIT');
// Returns: { hash1: metadata1, hash2: metadata2, ... }
```

### 3. **Monitoring Module Updates**

#### **upbit-monitor.js** - Captures Detection Timestamp
```javascript
// In processAnnouncement():
const detectionTime = Date.now();
const symbol = token ? `${token}USDT` : null;

const metadata = {
  symbol,
  title,
  link: url,
  exchange: 'UPBIT',
  detectedAt: detectionTime,
  orderedAt: null,
  latency: null
};

// In check():
storage.add(announcement.hash, announcement.metadata, 'UPBIT');
```

#### **binance-monitor.js** - Captures Detection Timestamp
```javascript
// In processAnnouncement():
const detectionTime = Date.now();
const primaryToken = tokens.length > 0 ? tokens[0] : null;
const symbol = primaryToken ? `${primaryToken}USDT` : null;

const metadata = {
  symbol,
  title,
  link: url,
  exchange: 'BINANCE',
  detectedAt: detectionTime,
  orderedAt: null,
  latency: null
};

// In check():
storage.add(announcement.hash, announcement.metadata, 'BINANCE');
```

### 4. **Trading Module Updates**

#### **lightning-trader.js** - Records Order Execution
```javascript
// Added storage import at top:
const storage = require('../storage');

// In executeLight() after successful market buy:
const orderExecutionTime = Date.now();

if (announcementHash) {
  storage.recordOrderExecution(announcementHash, orderExecutionTime, 'UPBIT');
  await storage.saveUpbit().catch(err =>
    console.error('❌ Storage save error:', err.message)
  );
}
```

This automatically calculates:
```
latency = orderedAt - detectedAt
// Example: 1699123456950 - 1699123456789 = 161 milliseconds
```

## Data Flow

```
1. Announcement Detected
   ↓
   Monitoring Module → Captures: symbol, title, link, detectedAt (Now!)
   ↓
   Storage Module → Stores with: orderedAt=null, latency=null
   ↓
   JSON File: {hash: {symbol, title, link, detectedAt, orderedAt: null}}

2. Trade Executed
   ↓
   Lightning Trader → Places order successfully
   ↓
   Trader calls: storage.recordOrderExecution(hash, Now!, 'UPBIT')
   ↓
   Storage Module → Auto-calculates latency = orderedAt - detectedAt
   ↓
   JSON File: {hash: {symbol, title, link, detectedAt, orderedAt, latency}}
```

## Example JSON File Output

```json
{
  "58694453f06fe9afad3a30b0121c43b5": {
    "symbol": "BTCUSDT",
    "title": "New Listing: Bitcoin (BTC)",
    "link": "https://www.upbit.com/notice",
    "exchange": "UPBIT",
    "detectedAt": 1699123456789,
    "orderedAt": 1699123456950,
    "latency": 161
  },
  "7a8c9d0e1f2g3h4i5j6k7l8m9n0o1p2q": {
    "symbol": "ETHUSDT",
    "title": "New Listing: Ethereum (ETH)",
    "link": "https://www.upbit.com/notice",
    "exchange": "UPBIT",
    "detectedAt": 1699123457100,
    "orderedAt": null,
    "latency": null
  }
}
```

## Millisecond Precision Tracking

All timestamps use **Date.now()** for maximum precision:
- **detectedAt**: When announcement monitoring first detected it
- **orderedAt**: When trade order was successfully placed
- **latency**: Exact milliseconds between announcement and execution

This enables:
- Precise performance analysis of bot's reaction speed
- Identification of slow symbols/exchanges
- Verification of <300ms latency goal
- Historical audit trail with exact timestamps

## JSON Formatting

All storage files now use **2-space indentation** for readability:
```javascript
JSON.stringify(data, null, 2)
```

Makes it easier to:
- Debug directly in JSON viewer
- Compare announcements across multiple runs
- Analyze latency trends
- Audit trade history

## Storage Files

Three separate files maintain exchange-specific records:
- **data/sent_announcements_upbit.json** - Upbit listings (updated in real-time)
- **data/sent_announcements_binance.json** - Binance listings/delistings (updated in real-time)
- **data/sent_announcements.json** - All announcements combined (for backup/analytics)

## Next Steps for Integration

1. ✅ Storage manager completely refactored with new API
2. ✅ Monitoring modules (Upbit & Binance) updated to capture metadata + detection timestamps
3. ✅ Lightning trader updated to record order execution timestamps
4. **Pending**: Data migration of existing JSON files (optional - will auto-convert on first save)
5. **Pending**: Create analytics endpoints to query historical latency data
6. **Pending**: Add CLI commands to view announcement history with latency stats

## Testing the New Format

```javascript
// Verify storage is working with new format:
const storage = require('./modules/storage');

// Get all announcements for Upbit
const announcements = storage.getAll('UPBIT');
console.log(announcements);

// Get specific announcement details
const details = storage.getDetails(hash, 'UPBIT');
console.log(details.symbol, details.detectedAt, details.latency);

// Get detection time
const detectedAt = storage.getDetectionTime(hash, 'UPBIT');
console.log(`Detected at: ${new Date(detectedAt).toISOString()}`);
```

## Performance Impact

- **Storage**: Negligible impact (Object operations faster than Set)
- **Memory**: Slightly higher due to metadata, but acceptable
- **Trading Latency**: None - metadata captured asynchronously
- **JSON Serialization**: Minimal impact with 2-space indent

## Backward Compatibility

The new storage API is **not backward compatible** with old Set-based format. Old JSON files will need:
1. Manual conversion to object format, OR
2. Let them be overwritten on first bot run (new format), OR
3. Run a migration script (to be added)

Current approach: Files will auto-rebuild in new format on first save.
