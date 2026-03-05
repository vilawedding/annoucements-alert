const TelegramBot = require('node-telegram-bot-api');
const config = require('../../config/config');

/**
 * Telegram Notification Service
 */

class TelegramService {
    constructor() {
        this.bot = new TelegramBot(config.telegram.botToken, { polling: false });
        this.chatId = config.telegram.chatId;
    }
    
    async sendMessage(message) {
        // try {
        //     await this.bot.sendMessage(this.chatId, message, {
        //         parse_mode: 'HTML',
        //     });
            return true;
        // } catch (error) {
        //     console.error('❌ Telegram send error:', error.message);
        //     return false;
        // }
    }
    
    createAnnouncementMessage(announcement) {
        const { exchange, category, title, url, tokens, formattedDate } = announcement;
        
        const exchangeConfig = config.exchanges[exchange.toLowerCase()];
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
        
        if (exchange === 'BINANCE') {
            message += `<b>🔗 Details:</b> <a href="${url}">View Official Announcement</a>\n`;
        } else {
            message += `<b>🔗 Source:</b> <a href="${url}">Upbit Notices</a>\n`;
        }
        
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
    
    createTradeMessage(tradeResult) {
        const { token, symbol, orderId, avgPrice, executedQty, leverage, amount } = tradeResult;
        
        const message = `🤖 <b>AUTO-TRADE EXECUTED</b>\n` +
            `════════════════════════\n\n` +
            `<b>🔵 Upbit Listing Detected</b>\n` +
            `Token: <code>${token}</code>\n\n` +
            `<b>🟡 Binance Futures Order</b>\n` +
            `Symbol: ${symbol}\n` +
            `Side: LONG\n` +
            `Quantity: ${executedQty}\n` +
            `Price: ${avgPrice}\n` +
            `Leverage: ${leverage}x\n` +
            `Amount: ~${amount} USDT\n\n` +
            `Order ID: <code>${orderId}</code>\n` +
            `Time: ${tradeResult.duration}ms\n\n` +
            `#AutoTrade #UpbitListing`;
        
        return message;
    }
    
    createErrorMessage(token, symbol, error) {
        return `⚠️ <b>AUTO-TRADE FAILED</b>\n` +
            `════════════════════════\n\n` +
            `Token: <code>${token}</code>\n` +
            `Symbol: ${symbol}\n` +
            `Error: ${error}\n\n` +
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
