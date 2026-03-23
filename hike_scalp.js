/**
 * MEXC Scalping Bot for XRP, NEO, ATOM
 * Detects small price movements (~1% / 100 "pips") for quick scalp trades
 * Uses MEXC WebSocket for real-time data + REST for confirmations
 * 
 * Targets: XRP/USDT, NEO/USDT, ATOM/USDT
 * Signal threshold: ~1% movement (100 pips equivalent)
 */


const { Telegraf } = require('telegraf');
const WebSocket = require('ws');
const https = require('https');


// ================= CONFIG =================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '7356098566:AAG2mE31mK-6reE0xoHeOiTuefZOMFBJQaE';
const CHAT_ID = process.env.CHAT_ID || '6650147748';

const MEXC_WS_URL = 'wss://wbs.mexc.com/ws';
const MEXC_REST = 'https://api.mexc.com';

// Scalping targets - only these 3 coins
const TARGET_PAIRS = ['XRPUSDT', 'NEOUSDT', 'ATOMUSDT'];

// Signal thresholds (1% = 100 "pips" for crypto scalping)
const PIP_THRESHOLD = 1.0;        // 1% move to trigger alert
const MIN_VOLUME_USDT = 50000;    // Minimum 24h volume filter
const PIP_SIZE = 0.01;            // 1% = 100 pips

// Timeframes for multi-timeframe analysis
const TIMEFRAMES = {
  scalp: '1m',      // Primary entry timeframe
  confirm: '5m',    // Confirmation timeframe
  trend: '15m'      // Trend direction
};

// Risk management
const RISK_REWARD_RATIO = 1.5;    // 1:1.5 R:R
const MAX_RISK_PCT = 0.5;         // 0.5% risk per scalp
const PIP_PROFIT_TARGET = 150;    // 1.5% take profit
const PIP_STOP_LOSS = 100;        // 1% stop loss

// Cooldown between signals (prevent spam)
const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per pair

// MEXC WS keepalive
const PING_INTERVAL_MS = 15000;
const WS_RECONNECT_DELAY_MS = 5000;

// =========================================

// --- Force IPv4 for Telegram ---
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { agent: new https.Agent({ family: 4 }) }
});

// --- App State ---
const state = {
  prices: {},           // Current prices
  priceHistory: {},     // Price history for pip calculation
  signalsSent: new Map(), // Cooldown tracking
  activePositions: new Map(), // Track active scalp positions
  wsConnections: new Map(), // WebSocket connections
  stats: {
    signalsGenerated: 0,
    longSignals: 0,
    shortSignals: 0,
    startTime: Date.now()
  }
};

// WS interval mapping
const WS_INTERVAL = {
  '1m': 'Min1', '5m': 'Min5', '15m': 'Min15', 
  '30m': 'Min30', '1h': 'Min60', '4h': 'Hour4'
};

// =====================================================
// HELPERS
// =====================================================

const formatPrice = (p, symbol) => {
  // XRP needs more decimals, NEO/ATOM less
  if (symbol.includes('XRP')) return p < 1 ? p.toFixed(4) : p.toFixed(2);
  if (symbol.includes('NEO') || symbol.includes('ATOM')) return p.toFixed(2);
  return p < 1 ? p.toFixed(4) : p.toFixed(2);
};

const formatPips = (pips) => {
  const direction = pips >= 0 ? '+' : '';
  return `${direction}${pips.toFixed(0)} pips (${(pips * PIP_SIZE).toFixed(2)}%)`;
};

const tradeUrl = (sym) => `https://www.mexc.com/exchange/${sym.replace('USDT', '')}_USDT`;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent: new https.Agent({ family: 4 }) }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchMexcKlines(symbol, interval, limit = 100) {
  const url = `${MEXC_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const klines = await fetchJson(url);
  if (!Array.isArray(klines)) throw new Error(`Klines error: ${JSON.stringify(klines).slice(0, 200)}`);
  return klines.map(k => ({
    timestamp: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    quoteVolume: parseFloat(k[7])
  }));
}

async function fetch24hTicker(symbol) {
  const url = `${MEXC_REST}/api/v3/ticker/24hr?symbol=${symbol}`;
  const data = await fetchJson(url);
  return {
    priceChange: parseFloat(data.priceChange),
    priceChangePercent: parseFloat(data.priceChangePercent),
    weightedAvgPrice: parseFloat(data.weightedAvgPrice),
    prevClosePrice: parseFloat(data.prevClosePrice),
    lastPrice: parseFloat(data.lastPrice),
    volume: parseFloat(data.volume),
    quoteVolume: parseFloat(data.quoteVolume),
    highPrice: parseFloat(data.highPrice),
    lowPrice: parseFloat(data.lowPrice)
  };
}

// =====================================================
// TECHNICAL INDICATORS
// =====================================================

function calculateEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * k + ema;
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateATR(klines, period = 14) {
  if (klines.length < period) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    trs.push(Math.max(tr1, tr2, tr3));
  }
  return calculateEMA(trs.slice(-period), period);
}

function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const sma = closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  const squaredDiffs = closes.slice(-period).map(c => Math.pow(c - sma, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: sma + (std * stdDev),
    middle: sma,
    lower: sma - (std * stdDev)
  };
}

// =====================================================
// SIGNAL GENERATION LOGIC
// =====================================================

async function analyzeScalpOpportunity(symbol) {
  try {
    // Fetch multi-timeframe data
    const [klines1m, klines5m, klines15m, ticker24h] = await Promise.all([
      fetchMexcKlines(symbol, TIMEFRAMES.scalp, 50),
      fetchMexcKlines(symbol, TIMEFRAMES.confirm, 50),
      fetchMexcKlines(symbol, TIMEFRAMES.trend, 50),
      fetch24hTicker(symbol)
    ]);

    // Volume filter
    if (ticker24h.quoteVolume < MIN_VOLUME_USDT) {
      return null;
    }

    const currentPrice = klines1m[klines1m.length - 1].close;
    const prevPrice = state.prices[symbol] || currentPrice;

    // Calculate pip movement (1% = 100 pips)
    const priceChangePct = ((currentPrice - prevPrice) / prevPrice) * 100;
    const pips = priceChangePct / PIP_SIZE;

    // Update price history
    state.prices[symbol] = currentPrice;
    if (!state.priceHistory[symbol]) state.priceHistory[symbol] = [];
    state.priceHistory[symbol].push({ price: currentPrice, timestamp: Date.now() });
    if (state.priceHistory[symbol].length > 100) state.priceHistory[symbol].shift();

    // Check cooldown
    const lastSignal = state.signalsSent.get(symbol);
    if (lastSignal && (Date.now() - lastSignal) < SIGNAL_COOLDOWN_MS) {
      return null;
    }

    // Calculate indicators
    const closes1m = klines1m.map(k => k.close);
    const closes5m = klines5m.map(k => k.close);
    const closes15m = klines15m.map(k => k.close);

    const ema9_1m = calculateEMA(closes1m, 9);
    const ema21_1m = calculateEMA(closes1m, 21);
    const rsi1m = calculateRSI(closes1m, 14);
    const atr1m = calculateATR(klines1m, 14);
    const bb1m = calculateBollingerBands(closes1m, 20, 2);

    const ema9_5m = calculateEMA(closes5m, 9);
    const rsi5m = calculateRSI(closes5m, 14);

    const ema9_15m = calculateEMA(closes15m, 9);
    const trendDirection = closes15m[closes15m.length - 1] > ema9_15m ? 'bullish' : 'bearish';

    // Signal detection logic
    let signal = null;
    const confidence = calculateConfidence(rsi1m, rsi5m, trendDirection, priceChangePct);

    // LONG signal
    if (priceChangePct <= -PIP_THRESHOLD && rsi1m < 40) {
      signal = {
        type: 'LONG',
        symbol,
        entryPrice: currentPrice,
        pips: Math.abs(pips),
        confidence,
        reason: `Drop of ${formatPips(pips)} + RSI oversold (${rsi1m.toFixed(1)})`,
        stopLoss: currentPrice * (1 - (PIP_STOP_LOSS * PIP_SIZE / 100)),
        takeProfit: currentPrice * (1 + (PIP_PROFIT_TARGET * PIP_SIZE / 100)),
      };
    } 
    // SHORT signal
    else if (priceChangePct >= PIP_THRESHOLD && rsi1m > 60) {
      signal = {
        type: 'SHORT',
        symbol,
        entryPrice: currentPrice,
        pips,
        confidence,
        reason: `Rally of ${formatPips(pips)} + RSI overbought (${rsi1m.toFixed(1)})`,
        stopLoss: currentPrice * (1 + (PIP_STOP_LOSS * PIP_SIZE / 100)),
        takeProfit: currentPrice * (1 - (PIP_PROFIT_TARGET * PIP_SIZE / 100)),
      };
    }

    if (signal && confidence >= 60) {
      state.signalsSent.set(symbol, Date.now());
      await sendTelegramAlert(signal);
    }

  } catch (error) {
    console.error(`Error analyzing ${symbol}:`, error.message);
  }
}

function calculateConfidence(rsi1m, rsi5m, trend, change) {
  let score = 50;
  // RSI Alignment
  if (rsi1m < 30) score += 15;
  if (rsi1m > 70) score += 15;
  // Trend alignment (Counter-trend scalps are lower confidence)
  if (change > 0 && trend === 'bullish') score += 10;
  if (change < 0 && trend === 'bearish') score += 10;
  return Math.min(score, 100);
}

// =====================================================
// TELEGRAM & NOTIFICATIONS
// =====================================================

async function sendTelegramAlert(s) {
  const emoji = s.type === 'LONG' ? '🚀' : '📉';
  const message = `
${emoji} *MEXC SCALP SIGNAL: ${s.type}* ${emoji}
━━━━━━━━━━━━━━━━━━
*Symbol:* #${s.symbol}
*Entry:* ${formatPrice(s.entryPrice, s.symbol)}
*Confidence:* ${s.confidence}%

*Target TP:* ${formatPrice(s.takeProfit, s.symbol)}
*Stop Loss:* ${formatPrice(s.stopLoss, s.symbol)}
━━━━━━━━━━━━━━━━━━
*Reason:* ${s.reason}
[Trade on MEXC](${tradeUrl(s.symbol)})
  `;

  try {
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown' });
    state.stats.signalsGenerated++;
    s.type === 'LONG' ? state.stats.longSignals++ : state.stats.shortSignals++;
  } catch (e) {
    console.error('Telegram Error:', e.message);
  }
}

// =====================================================
// WEBSOCKET ENGINE
// =====================================================

function initWebSocket() {
  const ws = new WebSocket(MEXC_WS_URL);

  ws.on('open', () => {
    console.log('Connected to MEXC WebSocket');
    // Subscribe to deals/tickers for our target pairs
    const subMsg = {
      method: "SUBSCRIPTION",
      params: TARGET_PAIRS.map(p => `spot.@public.deals.v3.api@${p}`)
    };
    ws.send(JSON.stringify(subMsg));

    // Keepalive
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: "PING" }));
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    
    // Process deal data to trigger analysis
    if (msg.c && msg.c.includes('deals')) {
      const symbol = msg.s;
      const price = parseFloat(msg.d.deals[0].p);
      
      // We only analyze once every few seconds per symbol to save API weight
      const now = Date.now();
      if (!state.prices[symbol] || (now - (state.lastUpdate?.[symbol] || 0) > 2000)) {
        if (!state.lastUpdate) state.lastUpdate = {};
        state.lastUpdate[symbol] = now;
        analyzeScalpOpportunity(symbol);
      }
    }
  });

  ws.on('error', (e) => console.error('WS Error:', e.message));
  
  ws.on('close', () => {
    console.log('WS Closed. Reconnecting...');
    setTimeout(initWebSocket, WS_RECONNECT_DELAY_MS);
  });
}

// =====================================================
// STARTUP
// =====================================================

(async () => {
  console.log('--- MEXC Scalper Bot Starting ---');
  console.log(`Monitoring: ${TARGET_PAIRS.join(', ')}`);
  
  try {
    console.log("Using Token:", TELEGRAM_TOKEN.substring(0, 5) + "...");
    await bot.launch();
    initWebSocket();
  } catch (e) {
    console.error('Failed to start:', e.message);
  }
})();

// Graceful shutdown
process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(); });