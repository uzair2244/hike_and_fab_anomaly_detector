require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { EMA } = require('technicalindicators');
const express = require('express');

// ==========================================
// CONFIGURATION
// ==========================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 8080;

const TIMEFRAME = 'Min15';
const MIN_VOLUME_USDT = 20000000;
const EXCLUDED_COINS = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'MX_USDT'];
const PROXIMITY_THRESHOLD = 0.002; 

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
let activeSetups = new Map();
let signaledPairs = new Set();

// ==========================================
// RAILWAY HEALTH SERVER
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('Bot is active. Monitoring MEXC Edge...'));
app.listen(PORT, () => console.log(`🚀 Railway Health Server on port ${PORT}`));

// ==========================================
// 1. MARKET SCANNER (REST)
// ==========================================
async function fetchMarketStructure() {
    console.log(`\n--- 🔄 MEXC SCAN START: ${new Date().toLocaleTimeString()} ---`);
    try {
        const { data } = await axios.get('https://contract.mexc.com/api/v1/contract/ticker');
        if (!data.success) throw new Error("MEXC API fetch failed");

        const tradablePairs = data.data
            .filter(t => {
                const vol = parseFloat(t.amount24); 
                return t.symbol.endsWith('_USDT') && vol > MIN_VOLUME_USDT && !EXCLUDED_COINS.includes(t.symbol);
            })
            .map(t => t.symbol);

        const newSetups = new Map();
        for (const symbol of tradablePairs) {
            try {
                const kResponse = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${TIMEFRAME}`);
                if (kResponse.data.success) {
                    const rawData = kResponse.data.data;
                    const klines = rawData.time.map((t, i) => ({
                        open: rawData.open[i], high: rawData.high[i],
                        low: rawData.low[i], close: rawData.close[i]
                    })).slice(-50);

                    const setup = analyzeSetup(symbol, klines);
                    if (setup) newSetups.set(symbol, setup);
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 40)); 
        }

        activeSetups = newSetups;
        signaledPairs.clear(); 
        console.log(`✅ SCAN COMPLETE. Found ${activeSetups.size} setups.`);
    } catch (error) {
        console.error('🚨 REST Error:', error.message);
    }
}

function analyzeSetup(symbol, klines) {
    if (klines.length < 50) return null;
    const closes = klines.map(k => k.close);
    const ema8 = EMA.calculate({ period: 8, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });

    const currentEma8 = ema8[ema8.length - 1];
    const currentEma50 = ema50[ema50.length - 1];
    const [c1, c2, c3] = [klines[klines.length-4], klines[klines.length-3], klines[klines.length-2]];

    if (currentEma8 > currentEma50 && c1.high < c3.low) {
        const entry = (c3.low + c1.high) / 2;
        return { symbol, direction: 'LONG 🟢', entry, sl: c1.low, tp: entry + ((entry - c1.low) * 2) };
    }
    if (currentEma8 < currentEma50 && c1.low > c3.high) {
        const entry = (c1.low + c3.high) / 2;
        return { symbol, direction: 'SHORT 🔴', entry, sl: c1.high, tp: entry - ((c1.high - entry) * 2) };
    }
    return null;
}

// ==========================================
// 2. REAL-TIME MONITORING (FIXED WS URL)
// ==========================================
function startWebSocket() {
    // UPDATED ENDPOINT TO PREVENT 404
    const ws = new WebSocket('wss://contract.mexc.com/edge');
    let pingInterval;

    ws.on('open', () => {
        console.log('🟢 MEXC Edge WebSocket Connected');
        
        // Subscription for All Tickers
        ws.send(JSON.stringify({ "method": "sub.ticker", "param": {} }));

        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ "method": "ping" }));
            }
        }, 20000);
    });

    ws.on('message', (data) => {
        try {
            const response = JSON.parse(data);
            
            // MEXC Edge uses "channel": "push.ticker"
            if (response.channel === "push.ticker") {
                const ticker = response.data;
                const symbol = ticker.symbol;
                const currentPrice = parseFloat(ticker.lastPrice);

                if (activeSetups.has(symbol) && !signaledPairs.has(symbol)) {
                    const setup = activeSetups.get(symbol);
                    const distance = Math.abs(currentPrice - setup.entry) / setup.entry;

                    if (distance <= PROXIMITY_THRESHOLD) {
                        sendEarlySignal(setup, currentPrice);
                        signaledPairs.add(symbol); 
                    }
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        console.log('🔴 WS Closed. Reconnecting in 5s...');
        clearInterval(pingInterval);
        setTimeout(startWebSocket, 5000);
    });

    ws.on('error', (err) => {
        console.error('❌ WS Error:', err.message);
    });
}

function sendEarlySignal(setup, currentPrice) {
    const msg = `⚠️ *MEXC ENTRY ZONE*\n🔥 $${setup.symbol.replace('_', '')} | ${setup.direction}\n━━━━━━━━━━━━━━━━━━\nPrice: ${currentPrice.toFixed(5)}\nEntry: ${setup.entry.toFixed(5)}\nTP: ${setup.tp.toFixed(5)}\nSL: ${setup.sl.toFixed(5)}\n━━━━━━━━━━━━━━━━━━`;
    bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
    console.log(`✉️ Signal sent for ${setup.symbol}`);
}

async function init() {
    await fetchMarketStructure();
    setInterval(fetchMarketStructure, 15 * 60 * 1000);
    startWebSocket();
}

init();