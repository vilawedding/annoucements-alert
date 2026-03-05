/**
 * Performance Optimization Utilities
 * Reduce latency throughout the system
 */

class PerformanceOptimizer {
    constructor() {
        this.metrics = {
            announcementDetection: [],
            tokenExtraction: [],
            tradingExecution: [],
            totalLatency: []
        };
    }
    
    recordMetric(type, duration) {
        if (this.metrics[type]) {
            this.metrics[type].push(duration);
            // Keep only last 100 readings
            if (this.metrics[type].length > 100) {
                this.metrics[type].shift();
            }
        }
    }
    
    getAverage(type) {
        const metrics = this.metrics[type];
        if (!metrics || metrics.length === 0) return 0;
        return Math.round(metrics.reduce((a, b) => a + b, 0) / metrics.length);
    }
    
    getStats() {
        return {
            announcementDetection: {
                avg: this.getAverage('announcementDetection'),
                last: this.metrics.announcementDetection[this.metrics.announcementDetection.length - 1] || 0
            },
            tokenExtraction: {
                avg: this.getAverage('tokenExtraction'),
                last: this.metrics.tokenExtraction[this.metrics.tokenExtraction.length - 1] || 0
            },
            tradingExecution: {
                avg: this.getAverage('tradingExecution'),
                last: this.metrics.tradingExecution[this.metrics.tradingExecution.length - 1] || 0
            },
            totalLatency: {
                avg: this.getAverage('totalLatency'),
                last: this.metrics.totalLatency[this.metrics.totalLatency.length - 1] || 0
            }
        };
    }
}

module.exports = new PerformanceOptimizer();
