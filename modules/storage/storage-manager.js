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
        this.mainFile = path.join(__dirname, '../../', config.storage.mainFile);
        this.binanceFile = path.join(__dirname, '../../', config.storage.binanceFile);
        this.upbitFile = path.join(__dirname, '../../', config.storage.upbitFile);
        
        // Changed from Set to Object to store detailed metadata
        this.sentAnnouncements = {};
        this.binanceSentAnnouncements = {};
        this.upbitSentAnnouncements = {};
    }
    
    async loadAll() {
        await Promise.all([
            this.loadMain(),
            this.loadBinance(),
            this.loadUpbit()
        ]);
    }
    
    async loadMain() {
        try {
            const data = await fs.readFile(this.mainFile, 'utf8');
            const parsed = JSON.parse(data);
            this.sentAnnouncements = parsed || {};
            console.log(`✅ Loaded ${Object.keys(this.sentAnnouncements).length} sent announcements`);
        } catch (error) {
            console.log('ℹ️ No main storage found, starting fresh');
            this.sentAnnouncements = {};
        }
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
    
    async saveAll() {
        await Promise.all([
            this.saveMain(),
            this.saveBinance(),
            this.saveUpbit()
        ]);
    }
    
    async saveMain() {
        try {
            const data = JSON.stringify(this.sentAnnouncements, null, 2);
            await fs.writeFile(this.mainFile, data, 'utf8');
        } catch (error) {
            console.error('❌ Error saving main storage:', error.message);
        }
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
    
    /**
     * Check if announcement already processed
     */
    has(hash, exchange = null) {
        if (exchange === 'BINANCE') {
            return hash in this.binanceSentAnnouncements;
        } else if (exchange === 'UPBIT') {
            return hash in this.upbitSentAnnouncements;
        }
        return hash in this.sentAnnouncements;
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
        
        this.sentAnnouncements[hash] = detailedEntry;
        
        if (exchange === 'BINANCE') {
            this.binanceSentAnnouncements[hash] = detailedEntry;
        } else if (exchange === 'UPBIT') {
            this.upbitSentAnnouncements[hash] = detailedEntry;
        }
    }
    
    /**
     * Update announcement with order timestamp (after trade executed)
     */
    recordOrderExecution(hash, orderedAt, exchange = null) {
        const detectedAt = this.getDetectionTime(hash, exchange);
        const latency = orderedAt - detectedAt;
        
        const update = { orderedAt, latency };
        
        if (hash in this.sentAnnouncements) {
            this.sentAnnouncements[hash] = { ...this.sentAnnouncements[hash], ...update };
        }
        
        if (exchange === 'BINANCE' && hash in this.binanceSentAnnouncements) {
            this.binanceSentAnnouncements[hash] = { ...this.binanceSentAnnouncements[hash], ...update };
        } else if (exchange === 'UPBIT' && hash in this.upbitSentAnnouncements) {
            this.upbitSentAnnouncements[hash] = { ...this.upbitSentAnnouncements[hash], ...update };
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
        } else if (hash in this.sentAnnouncements) {
            return this.sentAnnouncements[hash].detectedAt;
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
        } else if (hash in this.sentAnnouncements) {
            return this.sentAnnouncements[hash];
        }
        return null;
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            total: Object.keys(this.sentAnnouncements).length,
            binance: Object.keys(this.binanceSentAnnouncements).length,
            upbit: Object.keys(this.upbitSentAnnouncements).length
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
        }
        return this.sentAnnouncements;
    }
}

module.exports = new StorageManager();
