const TelegramBot = require('node-telegram-bot-api');
const config = require('../../config/config');

/**
 * Telegram Notification Service
 */

function escapeHtml(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class TelegramService {
    constructor() {
        this.bot = new TelegramBot(config.telegram.botToken, { polling: false });
        this.chats = {
            signal: config.telegram.chatId,
            order: config.telegram.orderChatId,
            pnl: config.telegram.pnlChatId
        };
        this.chatId = this.chats.signal;
    }

    /**
     * channel: 'signal' (announcements) | 'order' (fills, order errors) | 'pnl' (closed positions).
     * Never throws: a Telegram outage must not affect detection or trading.
     */
    async sendMessage(message, channel = 'signal') {
        const chatId = this.chats[channel] || this.chats.signal;
        if (!config.telegram.botToken || !chatId) return false;

        try {
            await this.bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
            return true;
        } catch (error) {
            console.error(`❌ Telegram send error (${channel}): ${error.message}`);
            return false;
        }
    }

    /** Fire-and-forget wrapper for hot paths (detection / order flow). */
    notify(message, channel = 'signal') {
        this.sendMessage(message, channel).catch(() => {});
    }
    
    createAnnouncementMessage(announcement) {
        const { exchange, category, url, tokens = [] } = announcement;
        const title = escapeHtml(announcement.title);
        const formattedDate = announcement.formattedDate
            || new Date(announcement.releaseDate || announcement.detectedAt || Date.now()).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
        
        const exchangeConfig = config.exchanges[exchange.toLowerCase()] || { emoji: '📢', name: exchange };
        const emoji = exchangeConfig.emoji;
        const exchangeName = exchangeConfig.name;
        
        let header = '', actionEmoji = '';
        
        switch(category) {
            case 'LISTING':
                header = '🚀 NEW LISTING';
                actionEmoji = '🎉';
                break;
            case 'DELISTING':
                header = '🗑️ DELISTING';
                actionEmoji = '⚠️';
                break;
            case 'WARNING':
                header = '🔴 TRADING WARNING';
                actionEmoji = '🚨';
                break;
            default:
                header = '📢 ANNOUNCEMENT';
                actionEmoji = '📢';
        }
        
        let message = `${emoji} <b>[${exchangeName}] ${header}</b>\n`;
        message += '════════════════════════\n\n';
        
        if (exchange === 'UPBIT') {
            const englishCategory = this.translateUpbitCategory(title);
            message += `<b>${englishCategory}</b>\n`;
        }
        
        message += `<b>${title}</b>\n\n`;
        
        if (tokens.length > 0) {
            message += `<b>🔸 Token${tokens.length > 1 ? 's' : ''}:</b>\n`;
            tokens.forEach((token, index) => {
                message += `${index + 1}. <code>${token}</code>\n`;
            });
            message += '\n';
        }
        
        message += `<b>📅 Time:</b> ${formattedDate}\n`;
        
        message += `<b>🔗 Source:</b> <a href="${url}">${exchangeName} announcement</a>\n`;
        
        message += `\n<b>🏦 Exchange:</b> ${exchangeName}\n\n`;
        message += '════════════════════════\n';
        
        const hashtags = [`#${exchangeName}`];
        if (category === 'LISTING') hashtags.push('#Listing', '#NewCoin');
        if (category === 'DELISTING') hashtags.push('#Delisting', '#Warning');
        if (category === 'WARNING') hashtags.push('#TradingWarning', '#Caution');
        hashtags.push('#Crypto');
        
        message += hashtags.join(' ');
        
        return message;
    }
    
    /**
     * @param tradeResult one successful result from lightningTrader.executeLight
     * @param announcement the triggering announcement (exchange, category, detectedAt)
     */
    createTradeMessage(tradeResult, announcement = {}) {
        const { token, symbol, orderId, executedQty, quantity, leverage, amount, entryPrice, stopLoss, takeProfit, duration } = tradeResult;
        const side = announcement.category === 'DELISTING' ? 'SHORT' : 'LONG';
        const totalMs = announcement.detectedAt ? Date.now() - announcement.detectedAt : null;
        const mode = config.binanceFutures.mode;

        return `🤖 <b>ORDER FILLED${mode !== 'PRODUCTION' ? ` [${mode}]` : ''}</b>\n` +
            `════════════════════════\n\n` +
            `<b>Signal:</b> ${escapeHtml(announcement.exchange || '')} ${escapeHtml(announcement.category || '')}\n` +
            `Token: <code>${escapeHtml(token)}</code>\n\n` +
            `<b>🟡 Binance Futures</b>\n` +
            `Symbol: ${escapeHtml(symbol)} | ${side} | ${leverage}x\n` +
            `Qty: ${executedQty || quantity} (~${amount} USDT)\n` +
            `Entry: ${entryPrice}\n` +
            `SL: ${stopLoss} | TP: ${takeProfit}\n` +
            `Order ID: <code>${orderId}</code>\n` +
            `Order: ${duration}ms${totalMs !== null ? ` | detect→now: ${totalMs}ms` : ''}\n\n` +
            `#AutoTrade #${escapeHtml(announcement.exchange || 'Signal')}`;
    }
    
    createErrorMessage(token, symbol, error) {
        return `⚠️ <b>AUTO-TRADE FAILED</b>\n` +
            `════════════════════════\n\n` +
            `Token: <code>${escapeHtml(token)}</code>\n` +
            `Symbol: ${escapeHtml(symbol)}\n` +
            `Error: ${escapeHtml(error)}\n\n` +
            `#AutoTrade #Error`;
    }
    
    translateUpbitCategory(koreanTitle) {
        const mapping = {
            '신규 거래지원 안내': 'New Trading Support',
            '거래지원 종료 안내': 'Trading Support Termination',
            '거래 유의 종목 지정 안내': 'Trading Caution Designation',
            '거래 유의 종목 지정 기간 연장 안내': 'Trading Caution Period Extension',
            '유의 촉구 안내': 'Caution Urged'
        };
        
        for (const [korean, english] of Object.entries(mapping)) {
            if (koreanTitle.includes(korean)) {
                return english;
            }
        }
        
        return 'Trade Announcement';
    }
}

module.exports = new TelegramService();
