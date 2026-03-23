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
const PORT = process.env.PORT || 8080; // Railway dynamic port

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
app.get('/', (req, res) => res.send('Bot is running and monitoring MEXC...'));
app.listen(PORT, () => console.log(`🚀 Health server listening on ${PORT}`));

// ==========================================
// 1. MARKET STRUCTURE (NEW 2026 DOMAIN)
// ==========================================
async function fetchMarketStructure() {
    console.log(`\n--- 🔄 MEXC SCAN START: ${new Date().toLocaleTimeString()} ---`);
    try {
        const { data } = await axios.get('https://api.mexc.com/api/v1/contract/ticker');
        if (!data.success) throw new Error("MEXC API fetch failed");

        const tradablePairs = data.data
            .filter(t => {
                const vol = parseFloat(t.amount24); 
                return t.symbol.endsWith('_USDT') && vol > MIN_VOLUME_USDT && !EXCLUDED_COINS.includes(t.symbol);
            })
            .map(t => t.symbol);

        console.log(`🔎 MEXC Filtering: Found ${tradablePairs.length} pairs with >$${(MIN_VOLUME_USDT/1000000).toFixed(0)}M volume.`);

        const newSetups = new Map();
        for (const symbol of tradablePairs) {
            try {
                const kResponse = await axios.get(`https://api.mexc.com/api/v1/contract/kline/${symbol}?interval=${TIMEFRAME}`);
                if (kResponse.data.success) {
                    const rawData = kResponse.data.data;
                    const klines = rawData.time.map((t, i) => ({
                        open: rawData.open[i], high: rawData.high[i],
                        low: rawData.low[i], close: rawData.close[i]
                    })).slice(-50);

                    const setup = analyzeSetup(symbol, klines);
                    if (setup) {
                        newSetups.set(symbol, setup);
                        console.log(`✨ [PATTERN] ${symbol}: ${setup.direction} detected. Entry: ${setup.entry.toFixed(5)}`);
                    }
                }
            } catch (e) { /* silent catch for API timeouts */ }
            await new Promise(r => setTimeout(r, 40)); 
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
    const [c1, c2, c3] = [klines[klines.length-4], klines[klines.length-3], klines[klines.length-2]];

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
// 2. REAL-TIME MONITORING (WITH HEARTBEAT)
// ==========================================
function startWebSocket() {
    // New 2026 Futures Endpoint
    const ws = new WebSocket('wss://api.mexc.com/ws/futures');
    let pingInterval;

    ws.on('open', () => {
        console.log('🟢 MEXC WebSocket Connected (api.mexc.com)');
        ws.send(JSON.stringify({ "method": "sub.ticker", "param": {} }));

        // MEXC requires ping every 10-20 seconds
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ "method": "ping" }));
            }
        }, 20000);
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);
        
        // Handle Tickers
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
                    sendEarlySignal(setup, currentPrice);
                    signaledPairs.add(symbol); 
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('🔴 WS Closed. Reconnecting...');
        clearInterval(pingInterval);
        setTimeout(startWebSocket, 5000);
    });

    ws.on('error', (err) => console.error('❌ WS Error:', err.message));
}

function sendEarlySignal(setup, currentPrice) {
    const message = `
⚠️ MEXC HEADS UP: Entry Zone
🔥 $${setup.symbol.replace('_', '')} | ${setup.direction}
━━━━━━━━━━━━━━━━━━
Current Price: ${currentPrice.toFixed(5)}
📍 Limit Entry: ${setup.entry.toFixed(5)}
🎯 Take Profit: ${setup.tp.toFixed(5)}
🛑 Stop Loss: ${setup.sl.toFixed(5)}
Strategy: ${setup.type} (MEXC)
━━━━━━━━━━━━━━━━━━
    `;
    bot.sendMessage(CHAT_ID, message).catch(console.error);
    console.log(`✉️ Signal sent for ${setup.symbol}`);
}

async function init() {
    console.log("🚀 MEXC Scalper Bot Initializing...");
    await fetchMarketStructure();
    setInterval(fetchMarketStructure, 15 * 60 * 1000);
    startWebSocket();
}

init();