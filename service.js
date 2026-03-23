require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { EMA } = require('technicalindicators');
const express = require('express');

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
let lastHeartbeat = Date.now();

const app = express();
app.get('/', (req, res) => res.send('MEXC Bot Active & Logging...'));
app.listen(PORT, () => console.log(`🚀 Railway Health Server on port ${PORT}`));

async function fetchMarketStructure() {
    console.log(`\n--- 🔄 SCAN START: ${new Date().toLocaleTimeString()} ---`);
    try {
        const { data } = await axios.get('https://contract.mexc.com/api/v1/contract/ticker');
        if (!data.success) throw new Error("MEXC API fetch failed");

        const tradablePairs = data.data
            .filter(t => {
                const vol = parseFloat(t.amount24); 
                return t.symbol.endsWith('_USDT') && vol > MIN_VOLUME_USDT && !EXCLUDED_COINS.includes(t.symbol);
            })
            .map(t => t.symbol);

        console.log(`🔎 Filtering: ${tradablePairs.length} high-volume pairs found.`);

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
                    if (setup) {
                        newSetups.set(symbol, setup);
                        console.log(`✅ [STRATEGY] ${symbol}: ${setup.direction} Setup Identified. Target Entry: ${setup.entry.toFixed(5)}`);
                    }
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 40)); 
        }

        activeSetups = newSetups;
        signaledPairs.clear(); 
        console.log(`📊 MONITORING: ${activeSetups.size} active FVG setups in memory.`);
        console.log(`-----------------------------------------------\n`);
    } catch (error) {
        console.error('🚨 REST Error:', error.message);
    }
}

function analyzeSetup(symbol, klines) {
    if (klines.length < 50) return null;
    const closes = klines.map(k => k.close);
    const ema8 = EMA.calculate({ period: 8, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });

    const cur8 = ema8[ema8.length - 1];
    const cur50 = ema50[ema50.length - 1];
    const [c1, c2, c3] = [klines[klines.length-4], klines[klines.length-3], klines[klines.length-2]];

    if (cur8 > cur50 && c1.high < c3.low) {
        const entry = (c3.low + c1.high) / 2;
        return { symbol, direction: 'LONG 🟢', entry, sl: c1.low, tp: entry + ((entry - c1.low) * 2) };
    }
    if (cur8 < cur50 && c1.low > c3.high) {
        const entry = (c1.low + c3.high) / 2;
        return { symbol, direction: 'SHORT 🔴', entry, sl: c1.high, tp: entry - ((c1.high - entry) * 2) };
    }
    return null;
}

function startWebSocket() {
    const ws = new WebSocket('wss://contract.mexc.com/edge');
    let pingInterval;
    let logInterval;

    ws.on('open', () => {
        console.log('🌐 MEXC WebSocket: CONNECTION ESTABLISHED');
        ws.send(JSON.stringify({ "method": "sub.ticker", "param": {} }));

        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ "method": "ping" }));
        }, 20000);

        // Operational Log: Every 30 seconds, show the status of the closest monitored coin
        logInterval = setInterval(() => {
            if (activeSetups.size > 0) {
                console.log(`[WS HEARTBEAT] ${new Date().toLocaleTimeString()} - Monitoring ${activeSetups.size} symbols...`);
            }
        }, 30000);
    });

    ws.on('message', (data) => {
        try {
            const response = JSON.parse(data);
            if (response.channel === "push.ticker") {
                const ticker = response.data;
                const symbol = ticker.symbol;
                const currentPrice = parseFloat(ticker.lastPrice);

                if (activeSetups.has(symbol) && !signaledPairs.has(symbol)) {
                    const setup = activeSetups.get(symbol);
                    const distance = Math.abs(currentPrice - setup.entry) / setup.entry;

                    // Log proximity if within 1%
                    if (distance <= 0.01) {
                        console.log(`👀 [TRACKING] ${symbol}: Price ${currentPrice} is ${(distance * 100).toFixed(2)}% from Entry ${setup.entry.toFixed(5)}`);
                    }

                    if (distance <= PROXIMITY_THRESHOLD) {
                        console.log(`🎯 [TARGET HIT] ${symbol} triggered proximity threshold (${PROXIMITY_THRESHOLD * 100}%)`);
                        sendEarlySignal(setup, currentPrice);
                        signaledPairs.add(symbol); 
                    }
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        console.log('🔴 WS DISCONNECTED: Reconnecting...');
        clearInterval(pingInterval);
        clearInterval(logInterval);
        setTimeout(startWebSocket, 5000);
    });

    ws.on('error', (err) => console.error('❌ WS Error:', err.message));
}

function sendEarlySignal(setup, currentPrice) {
    const msg = `⚠️ *MEXC SCALP ALERT*\n🔥 $${setup.symbol.replace('_', '')} | ${setup.direction}\n━━━━━━━━━━━━━━━━━━\nPrice: ${currentPrice.toFixed(5)}\nEntry: ${setup.entry.toFixed(5)}\nTP: ${setup.tp.toFixed(5)}\nSL: ${setup.sl.toFixed(5)}\n━━━━━━━━━━━━━━━━━━`;
    bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' })
       .then(() => console.log(`✉️ TELEGRAM: Signal delivered for ${setup.symbol}`))
       .catch(err => console.error(`❌ TELEGRAM FAIL: ${err.message}`));
}

async function init() {
    console.log("🚀 STARTING MEXC SCALPER ENGINE...");
    await fetchMarketStructure();
    setInterval(fetchMarketStructure, 15 * 60 * 1000);
    startWebSocket();
}

init();