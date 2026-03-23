require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { EMA } = require('technicalindicators');

// ==========================================
// CONFIGURATION
// ==========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TIMEFRAME = 'Min15'; // MEXC uses Min1, Min5, Min15, etc.
const MIN_VOLUME_USDT = 20000000; // MEXC volume is often lower than Binance
const EXCLUDED_COINS = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'MX_USDT'];
const PROXIMITY_THRESHOLD = 0.002; 

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

let activeSetups = new Map();
let signaledPairs = new Set();

// ==========================================
// 1. MARKET STRUCTURE (MEXC REST API)
// ==========================================
async function fetchMarketStructure() {
    console.log(`\n--- 🔄 MEXC SCAN START: ${new Date().toLocaleTimeString()} ---`);
    try {
        // MEXC Futures Ticker endpoint
        const { data } = await axios.get('https://contract.mexc.com/api/v1/contract/ticker');
        
        if (!data.success) throw new Error("MEXC API fetch failed");

        const tradablePairs = data.data
            .filter(t => {
                const vol = parseFloat(t.amount24); // 24h Volume in USDT
                return t.symbol.endsWith('_USDT') && vol > MIN_VOLUME_USDT && !EXCLUDED_COINS.includes(t.symbol);
            })
            .map(t => t.symbol);

        console.log(`🔎 MEXC Filtering: Found ${tradablePairs.length} pairs with >$${(MIN_VOLUME_USDT/1000000).toFixed(0)}M volume.`);

        const newSetups = new Map();

        for (const symbol of tradablePairs) {
            try {
                // MEXC Klines: interval=Min15
                const kResponse = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${TIMEFRAME}`);
                if (kResponse.data.success) {
                    const rawData = kResponse.data.data;
                    const klines = rawData.time.map((t, i) => ({
                        open: rawData.open[i],
                        high: rawData.high[i],
                        low: rawData.low[i],
                        close: rawData.close[i]
                    })).slice(-50); // Get last 50 candles

                    const setup = analyzeSetup(symbol, klines);
                    if (setup) {
                        newSetups.set(symbol, setup);
                        console.log(`✨ [PATTERN] ${symbol}: ${setup.direction} detected. Entry: ${setup.entry.toFixed(5)}`);
                    }
                }
            } catch (e) {
                // Silent catch for individual pair errors
            }
            await new Promise(resolve => setTimeout(resolve, 50)); 
        }

        activeSetups = newSetups;
        signaledPairs.clear(); 
        console.log(`✅ SCAN COMPLETE. Monitoring ${activeSetups.size} setups.`);
    } catch (error) {
        console.error('🚨 MEXC REST Error:', error.message);
    }
}

function analyzeSetup(symbol, klines) {
    if (klines.length < 50) return null;
    const closes = klines.map(k => k.close);
    const ema8 = EMA.calculate({ period: 8, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });

    const currentEma8 = ema8[ema8.length - 1];
    const currentEma50 = ema50[ema50.length - 1];

    const c1 = klines[klines.length - 4]; 
    const c2 = klines[klines.length - 3]; 
    const c3 = klines[klines.length - 2]; 

    const isUptrend = currentEma8 > currentEma50;
    const isDowntrend = currentEma8 < currentEma50;

    if (isUptrend && c1.high < c3.low) {
        const entry = (c3.low + c1.high) / 2;
        return { symbol, direction: 'LONG 🟢', type: 'FVG', entry, sl: c1.low, tp: entry + ((entry - c1.low) * 2) };
    }

    if (isDowntrend && c1.low > c3.high) {
        const entry = (c1.low + c3.high) / 2;
        return { symbol, direction: 'SHORT 🔴', type: 'FVG', entry, sl: c1.high, tp: entry - ((c1.high - entry) * 2) };
    }
    return null;
}

// ==========================================
// 2. REAL-TIME MONITORING (MEXC WS)
// ==========================================
function startWebSocket() {
    const ws = new WebSocket('wss://contract.mexc.com/ws');

    ws.on('open', () => {
        console.log('🟢 MEXC WebSocket Connected');
        // MEXC requires a subscription message for tickers
        ws.send(JSON.stringify({ "method": "sub.ticker", "param": {} }));
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);
        
        // MEXC ticker channel usually returns data in 'data' or 'push.ticker'
        if (response.channel === "push.ticker") {
            const ticker = response.data;
            const symbol = ticker.symbol;
            const currentPrice = parseFloat(ticker.lastPrice);

            if (activeSetups.has(symbol) && !signaledPairs.has(symbol)) {
                const setup = activeSetups.get(symbol);
                const distanceRatio = Math.abs(currentPrice - setup.entry) / setup.entry;

                const isApproachingLong = setup.direction.includes('LONG') && currentPrice > setup.entry && distanceRatio <= PROXIMITY_THRESHOLD;
                const isApproachingShort = setup.direction.includes('SHORT') && currentPrice < setup.entry && distanceRatio <= PROXIMITY_THRESHOLD;

                if (isApproachingLong || isApproachingShort) {
                    console.log(`🔥 [MEXC TRIGGER] ${symbol} @ ${currentPrice}`);
                    sendEarlySignal(setup, currentPrice);
                    signaledPairs.add(symbol); 
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('🔴 MEXC WS Closed. Reconnecting...');
        setTimeout(startWebSocket, 5000);
    });
}

function sendEarlySignal(setup, currentPrice) {
    const message = `
⚠️ MEXC HEADS UP: Entry Zone
🔥 $${setup.symbol.replace('_', '')} | ${setup.direction}
━━━━━━━━━━━━━━━━━━
Current Price: ${currentPrice.toFixed(5)}
⏳ Approaching FVG Midpoint!

📍 Limit Entry: ${setup.entry.toFixed(5)}
🎯 Take Profit: ${setup.tp.toFixed(5)}
🛑 Stop Loss: ${setup.sl.toFixed(5)}

Strategy: ${setup.type} (MEXC Futures)
━━━━━━━━━━━━━━━━━━
    `;
    bot.sendMessage(CHAT_ID, message).catch(e => console.error(`Telegram Error: ${e.message}`));
}

async function init() {
    console.log("🚀 MEXC Scalper Bot Initializing for Railway...");
    await fetchMarketStructure();
    setInterval(fetchMarketStructure, 15 * 60 * 1000);
    startWebSocket();
}

init();