// End-to-end check of the Bybit spot client with BYBIT_API_KEY / BYBIT_API_SECRET:
// market BUY `usdt` of a pair, then market SELL the whole coin balance. Testnet unless BYBIT_TESTNET=false.
// Run: npm run check:bybit-spot -- [SYMBOL=BTCUSDT] [USDT=10]
require('dotenv').config();
const config = require('../../config/config');
const { BybitSpot } = require('../../modules/trading/bybit-spot');

const symbol = process.argv[2] || 'BTCUSDT';
const usdt = Number(process.argv[3] || 10);

(async () => {
    const client = new BybitSpot();
    if (!client.enabled) throw new Error('BYBIT_API_KEY / BYBIT_API_SECRET not set');
    console.log(`${config.bybit.testnet ? 'TESTNET' : '⚠️ MAINNET'} ${config.bybit.baseUrl}`);
    if (!config.bybit.testnet && !process.argv.includes('--mainnet')) throw new Error('mainnet: add --mainnet to really trade');

    console.log(`USDT free: ${await client.freeBalance('USDT')}`);
    await client.loadInstruments();
    if (!client.hasPair(symbol)) throw new Error(`${symbol} is not a trading USDT pair here`);

    let t = Date.now();
    const buy = await client.marketBuy(symbol, usdt);
    console.log(`BUY  ${symbol} ${buy.qty} @ ${buy.avgPrice} value ${buy.value} fee ${buy.fee} (${Date.now() - t}ms)`);

    t = Date.now();
    const sell = await client.marketSellAll(symbol);
    console.log(sell ? `SELL ${symbol} ${sell.qty} @ ${sell.avgPrice} value ${sell.value} fee ${sell.fee} (${Date.now() - t}ms)` : 'SELL: nothing sellable');
    if (sell) console.log(`PnL ${(sell.value - sell.fee - buy.value).toFixed(4)} USDT`);
})().catch(error => {
    console.error('❌', error.message);
    process.exit(1);
});
