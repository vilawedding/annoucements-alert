const fs = require('fs').promises;
const path = require('path');
const config = require('../../config/config');

/**
 * Storage Manager - Handle persistent storage for announcements with detailed metadata
 * 
 * New format:
 * {
 *   "hash": {
 *     "symbol": "BTCUSDT",
 *     "title": "New listing: Bitcoin",
 *     "link": "https://...",
 *     "exchange": "BINANCE",
 *     "detectedAt": 1709348923456,      // milliseconds
 *     "orderedAt": 1709348924123,       // milliseconds (after trade executed)
 *     "latency": 667                    // ms from detection to order
 *   }
 * }
 */

class StorageManager {
    constructor() {
        this.binanceFile = path.join(__dirname, '../../', config.storage.binanceFile);
        this.upbitFile = path.join(__dirname, '../../', config.storage.upbitFile);
        this.bithumbFile = path.join(__dirname, '../../', config.storage.bithumbFile);
        
        // Changed from Set to Object to store detailed metadata
        this.binanceSentAnnouncements = {};
        this.upbitSentAnnouncements = {};
        this.bithumbSentAnnouncements = {};
    }
    
    async loadAll() {
        await Promise.all([
            this.loadBinance(),
            this.loadUpbit(),
            this.loadBithumb()
        ]);
    }
    
    async loadBinance() {
        try {
            const data = await fs.readFile(this.binanceFile, 'utf8');
            const parsed = JSON.parse(data);
            this.binanceSentAnnouncements = parsed || {};
            console.log(`✅ Loaded ${Object.keys(this.binanceSentAnnouncements).length} Binance announcements`);
        } catch (error) {
            console.log('ℹ️ No Binance storage found, starting fresh');
            this.binanceSentAnnouncements = {};
        }
    }
    
    async loadUpbit() {
        try {
            const data = await fs.readFile(this.upbitFile, 'utf8');
            const parsed = JSON.parse(data);
            this.upbitSentAnnouncements = parsed || {};
            console.log(`✅ Loaded ${Object.keys(this.upbitSentAnnouncements).length} Upbit announcements`);
        } catch (error) {
            console.log('ℹ️ No Upbit storage found, starting fresh');
            this.upbitSentAnnouncements = {};
        }
    }

    async loadBithumb() {
        try {
            const data = await fs.readFile(this.bithumbFile, 'utf8');
            const parsed = JSON.parse(data);
            this.bithumbSentAnnouncements = parsed || {};
            console.log(`✅ Loaded ${Object.keys(this.bithumbSentAnnouncements).length} Bithumb announcements`);
        } catch (error) {
            console.log('ℹ️ No Bithumb storage found, starting fresh');
            this.bithumbSentAnnouncements = {};
        }
    }
    
    async saveAll() {
        await Promise.all([
            this.saveBinance(),
            this.saveUpbit(),
            this.saveBithumb()
        ]);
    }
    
    async saveBinance() {
        try {
            const data = JSON.stringify(this.binanceSentAnnouncements, null, 2);
            await fs.writeFile(this.binanceFile, data, 'utf8');
        } catch (error) {
            console.error('❌ Error saving Binance storage:', error.message);
        }
    }
    
    async saveUpbit() {
        try {
            const data = JSON.stringify(this.upbitSentAnnouncements, null, 2);
            await fs.writeFile(this.upbitFile, data, 'utf8');
        } catch (error) {
            console.error('❌ Error saving Upbit storage:', error.message);
        }
    }

    async saveBithumb() {
        try {
            const data = JSON.stringify(this.bithumbSentAnnouncements, null, 2);
            await fs.writeFile(this.bithumbFile, data, 'utf8');
        } catch (error) {
            console.error('❌ Error saving Bithumb storage:', error.message);
        }
    }
    
    /**
     * Check if announcement already processed
     */
    has(hash, exchange = null) {
        if (exchange === 'BINANCE') {
            return hash in this.binanceSentAnnouncements;
        } else if (exchange === 'UPBIT') {
            return hash in this.upbitSentAnnouncements;
        } else if (exchange === 'BITHUMB') {
            return hash in this.bithumbSentAnnouncements;
        }
        return false;
    }
    
    /**
     * Add announcement with metadata
     * @param {string} hash - Announcement hash/ID
     * @param {object} details - { symbol, title, link, exchange, detectedAt, orderedAt, latency }
     * @param {string} exchange - 'BINANCE' or 'UPBIT'
     */
    add(hash, details, exchange = null) {
        const detailedEntry = {
            symbol: details.symbol || '',
            title: details.title || '',
            link: details.link || '',
            exchange: exchange || details.exchange || 'UNKNOWN',
            detectedAt: details.detectedAt || Date.now(),  // milliseconds
            orderedAt: details.orderedAt || null,          // set after trade
            latency: details.latency || null               // ms from detection to order
        };
        
        if (exchange === 'BINANCE') {
            this.binanceSentAnnouncements[hash] = detailedEntry;
        } else if (exchange === 'UPBIT') {
            this.upbitSentAnnouncements[hash] = detailedEntry;
        } else if (exchange === 'BITHUMB') {
            this.bithumbSentAnnouncements[hash] = detailedEntry;
        }
    }
    
    /**
     * Update announcement with order timestamp (after trade executed)
     */
    recordOrderExecution(hash, orderedAt, exchange = null) {
        const detectedAt = this.getDetectionTime(hash, exchange);
        const latency = orderedAt - detectedAt;
        
        const update = { orderedAt, latency };
        
        if (exchange === 'BINANCE' && hash in this.binanceSentAnnouncements) {
            this.binanceSentAnnouncements[hash] = { ...this.binanceSentAnnouncements[hash], ...update };
        } else if (exchange === 'UPBIT' && hash in this.upbitSentAnnouncements) {
            this.upbitSentAnnouncements[hash] = { ...this.upbitSentAnnouncements[hash], ...update };
        } else if (exchange === 'BITHUMB' && hash in this.bithumbSentAnnouncements) {
            this.bithumbSentAnnouncements[hash] = { ...this.bithumbSentAnnouncements[hash], ...update };
        }
    }
    
    /**
     * Get detection timestamp for an announcement
     */
    getDetectionTime(hash, exchange = null) {
        if (exchange === 'BINANCE' && hash in this.binanceSentAnnouncements) {
            return this.binanceSentAnnouncements[hash].detectedAt;
        } else if (exchange === 'UPBIT' && hash in this.upbitSentAnnouncements) {
            return this.upbitSentAnnouncements[hash].detectedAt;
        } else if (exchange === 'BITHUMB' && hash in this.bithumbSentAnnouncements) {
            return this.bithumbSentAnnouncements[hash].detectedAt;
        }
        return null;
    }
    
    /**
     * Get full details for an announcement
     */
    getDetails(hash, exchange = null) {
        if (exchange === 'BINANCE' && hash in this.binanceSentAnnouncements) {
            return this.binanceSentAnnouncements[hash];
        } else if (exchange === 'UPBIT' && hash in this.upbitSentAnnouncements) {
            return this.upbitSentAnnouncements[hash];
        } else if (exchange === 'BITHUMB' && hash in this.bithumbSentAnnouncements) {
            return this.bithumbSentAnnouncements[hash];
        }
        return null;
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            total: Object.keys(this.binanceSentAnnouncements).length + Object.keys(this.upbitSentAnnouncements).length + Object.keys(this.bithumbSentAnnouncements).length,
            binance: Object.keys(this.binanceSentAnnouncements).length,
            upbit: Object.keys(this.upbitSentAnnouncements).length,
            bithumb: Object.keys(this.bithumbSentAnnouncements).length
        };
    }
    
    /**
     * Get all announcements with their details
     */
    getAll(exchange = null) {
        if (exchange === 'BINANCE') {
            return this.binanceSentAnnouncements;
        } else if (exchange === 'UPBIT') {
            return this.upbitSentAnnouncements;
        } else if (exchange === 'BITHUMB') {
            return this.bithumbSentAnnouncements;
        }
        return { ...this.binanceSentAnnouncements, ...this.upbitSentAnnouncements, ...this.bithumbSentAnnouncements };
    }
}

module.exports = new StorageManager();
