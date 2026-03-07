/**
 * Nexus Moonshot & Dump Detector + SHORT/LONG Entry Trackers
 * - Moonshot (strong upside) -> send moonshot alert -> start SHORT tracker
 * - Dump (strong downside) -> send dump alert -> start LONG tracker
 *
 * Replace TELEGRAM_TOKEN and CHAT_ID with your values.
 */

const { Telegraf } = require('telegraf');
const WebSocket = require('ws');
const https = require('https');

// ================= CONFIG =================
const TELEGRAM_TOKEN = '7356098566:AAG2mE31mK-6reE0xoHeOiTuefZOMFBJQaE';
const CHAT_ID = '6650147748';

const WS_URL = 'wss://stream.binance.com:9443/ws/!ticker@arr';
// =========================================

// --- Force IPv4 for Telegram ---
const ipv4Agent = new https.Agent({
  family: 4
});

const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: {
    agent: ipv4Agent
  }
});

// --- App State ---
const state = {
  tickers: {},
  sentSignals: new Set()
};

const activeTrackers = new Set();
const fibCache = new Map(); // simple in-memory cache for computeMultiTfFib
const klinesCache = new Map(); // cache klines per symbol+tf for short time

// --- Utilities ---
const formatPrice = (price) =>
  price < 1 ? price.toFixed(6) : price.toFixed(4);

const formatCompact = (num) =>
  Intl.NumberFormat('en-US', { notation: 'compact' }).format(num);

// --- Helpers: Promise wrapper for HTTPS GET (Binance REST) ---
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', (err) => reject(err));
  });
}

// --- Math / Indicators ---
function calculateSeedEMAForPeriod(closes, period) {
  if (!closes || closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }
  return ema;
}

function sma(values) {
  if (!values || values.length === 0) return 0;
  return values.reduce((a,b)=>a+b,0)/values.length;
}

function computeRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[closes.length - i] - closes[closes.length - i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// --- Find swing high and low over last N candles ---
function findSwingHighLow(klines, lookback) {
  const slice = klines.slice(-lookback);
  const highs = slice.map(k => parseFloat(k[2]));
  const lows = slice.map(k => parseFloat(k[3]));
  return {
    high: Math.max(...highs),
    low: Math.min(...lows)
  };
}

// --- Fibonacci levels from low to high (retracements and extensions) ---
function fibonacciLevels(low, high) {
  const diff = high - low;
  const retracements = {
    '0.236': high - diff * 0.236,
    '0.382': high - diff * 0.382,
    '0.5': high - diff * 0.5,
    '0.618': high - diff * 0.618,
    '0.786': high - diff * 0.786
  };
  const extensions = {
    '1.272': high + diff * 0.272 * -1,
    '1.414': high + diff * 0.414 * -1,
    '1.618': high + diff * 0.618 * -1
  };
  return { retracements, extensions };
}

// --- Aggregate multi timeframe fibs and pick conservative levels ---
async function computeMultiTfFib(symbol) {
  const cacheKey = `${symbol}`;
  const cached = fibCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.ts) < 60 * 1000) {
    return cached.value;
  }

  const tfs = [
    { interval: '1d', lookback: 30 },
    { interval: '4h', lookback: 40 },
    { interval: '1h', lookback: 60 },
    { interval: '15m', lookback: 60 },
    { interval: '5m', lookback: 40 }
  ];

  const results = {};

  for (const tf of tfs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf.interval}&limit=${tf.lookback}`;
    try {
      const klines = await fetchJson(url);
      const { high, low } = findSwingHighLow(klines, tf.lookback);
      const fib = fibonacciLevels(low, high);
      results[tf.interval] = { high, low, fib, klines };
      // cache klines for other checks
      klinesCache.set(`${symbol}_${tf.interval}`, { ts: now, klines });
    } catch (err) {
      console.error(`Error fetching ${symbol} ${tf.interval}:`, err.message);
    }
  }

  const preferred = results['1h'] || results['4h'] || results['15m'] || results['5m'] || results['1d'] || null;
  const value = { perTf: results, preferred };
  fibCache.set(cacheKey, { ts: now, value });
  return value;
}

// --- Double top / double bottom detector ---
function detectDoubleTop(klines, tolerancePct = 1.2, minSeparation = 3, maxSeparation = 30) {
  const highs = klines.map(k => parseFloat(k[2]));
  const peaks = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] >= highs[i-1] && highs[i] >= highs[i-2] && highs[i] >= highs[i+1] && highs[i] >= highs[i+2]) {
      peaks.push({ idx: i, price: highs[i] });
    }
  }
  if (peaks.length < 2) return { isDoubleTop: false };

  const p2 = peaks[peaks.length - 1];
  let p1 = null;
  for (let i = peaks.length - 2; i >= 0; i--) {
    const sep = p2.idx - peaks[i].idx;
    if (sep >= minSeparation && sep <= maxSeparation) {
      p1 = peaks[i];
      break;
    }
  }
  if (!p1) return { isDoubleTop: false };

  const diffPct = Math.abs((p1.price - p2.price) / ((p1.price + p2.price)/2)) * 100;
  if (diffPct > tolerancePct) return { isDoubleTop: false };

  const lowsBetween = klines.slice(p1.idx, p2.idx + 1).map(k => parseFloat(k[3]));
  const neckline = Math.min(...lowsBetween);

  const lastClose = parseFloat(klines[klines.length - 1][4]);
  const necklineBroken = lastClose < neckline;

  return {
    isDoubleTop: true,
    peak1: p1,
    peak2: p2,
    neckline,
    necklineBroken,
    diffPct
  };
}

function detectDoubleBottom(klines, tolerancePct = 1.2, minSeparation = 3, maxSeparation = 30) {
  const lows = klines.map(k => parseFloat(k[3]));
  const bottoms = [];
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] <= lows[i-1] && lows[i] <= lows[i-2] && lows[i] <= lows[i+1] && lows[i] <= lows[i+2]) {
      bottoms.push({ idx: i, price: lows[i] });
    }
  }
  if (bottoms.length < 2) return { isDoubleBottom: false };

  const b2 = bottoms[bottoms.length - 1];
  let b1 = null;
  for (let i = bottoms.length - 2; i >= 0; i--) {
    const sep = b2.idx - bottoms[i].idx;
    if (sep >= minSeparation && sep <= maxSeparation) {
      b1 = bottoms[i];
      break;
    }
  }
  if (!b1) return { isDoubleBottom: false };

  const diffPct = Math.abs((b1.price - b2.price) / ((b1.price + b2.price)/2)) * 100;
  if (diffPct > tolerancePct) return { isDoubleBottom: false };

  const highsBetween = klines.slice(b1.idx, b2.idx + 1).map(k => parseFloat(k[2]));
  const neckline = Math.max(...highsBetween);

  const lastClose = parseFloat(klines[klines.length - 1][4]);
  const necklineBroken = lastClose > neckline;

  return {
    isDoubleBottom: true,
    bottom1: b1,
    bottom2: b2,
    neckline,
    necklineBroken,
    diffPct
  };
}

// --- Volume confirmation ---
function volumeSpikeConfirmed(klines, multiplier = 1.5, lookback = 20) {
  const vols = klines.slice(-lookback).map(k => parseFloat(k[5]));
  const avg = sma(vols.slice(0, vols.length - 1));
  const lastVol = parseFloat(klines[klines.length - 1][5]);
  return { confirmed: lastVol >= avg * multiplier, lastVol, avg };
}

// --- Divergence checks ---
function checkBearishDivergence(klines, rsiPeriod = 14, lookback = 40) {
  const closes = klines.map(k => parseFloat(k[4]));
  if (closes.length < lookback + rsiPeriod) return false;
  const slice = closes.slice(-lookback - rsiPeriod);
  const rsiSeries = [];
  for (let i = rsiPeriod; i < slice.length; i++) {
    const window = slice.slice(i - rsiPeriod, i + 1);
    rsiSeries.push(computeRSI(window, rsiPeriod));
  }
  const highs = [];
  for (let i = 2; i < closes.length - 2; i++) {
    if (closes[i] >= closes[i-1] && closes[i] >= closes[i-2] && closes[i] >= closes[i+1] && closes[i] >= closes[i+2]) {
      highs.push({ idx: i, price: closes[i] });
    }
  }
  if (highs.length < 2) return false;
  const h2 = highs[highs.length - 1];
  let h1 = null;
  for (let i = highs.length - 2; i >= 0; i--) {
    if (h2.idx - highs[i].idx >= 3) { h1 = highs[i]; break; }
  }
  if (!h1) return false;
  const rsiIdxOffset = closes.length - slice.length;
  const rsiH1 = rsiSeries[h1.idx - rsiIdxOffset - rsiPeriod] || null;
  const rsiH2 = rsiSeries[h2.idx - rsiIdxOffset - rsiPeriod] || null;
  if (rsiH1 === null || rsiH2 === null) return false;
  return (h2.price >= h1.price) && (rsiH2 < rsiH1);
}

function checkBullishDivergence(klines, rsiPeriod = 14, lookback = 40) {
  const closes = klines.map(k => parseFloat(k[4]));
  if (closes.length < lookback + rsiPeriod) return false;
  const slice = closes.slice(-lookback - rsiPeriod);
  const rsiSeries = [];
  for (let i = rsiPeriod; i < slice.length; i++) {
    const window = slice.slice(i - rsiPeriod, i + 1);
    rsiSeries.push(computeRSI(window, rsiPeriod));
  }
  const lows = [];
  for (let i = 2; i < closes.length - 2; i++) {
    if (closes[i] <= closes[i-1] && closes[i] <= closes[i-2] && closes[i] <= closes[i+1] && closes[i] <= closes[i+2]) {
      lows.push({ idx: i, price: closes[i] });
    }
  }
  if (lows.length < 2) return false;
  const l2 = lows[lows.length - 1];
  let l1 = null;
  for (let i = lows.length - 2; i >= 0; i--) {
    if (l2.idx - lows[i].idx >= 3) { l1 = lows[i]; break; }
  }
  if (!l1) return false;
  const rsiIdxOffset = closes.length - slice.length;
  const rsiL1 = rsiSeries[l1.idx - rsiIdxOffset - rsiPeriod] || null;
  const rsiL2 = rsiSeries[l2.idx - rsiIdxOffset - rsiPeriod] || null;
  if (rsiL1 === null || rsiL2 === null) return false;
  return (l2.price <= l1.price) && (rsiL2 > rsiL1);
}

// --- Multi-TF confluence check ---
async function multiTfConfluence(symbol) {
  const fibData = await computeMultiTfFib(symbol);
  const perTf = fibData.perTf || {};
  const checkSlope = (klines) => {
    const closes = klines.map(k => parseFloat(k[4]));
    const emaShort = calculateSeedEMAForPeriod(closes.slice(-30), 9);
    const emaLong = calculateSeedEMAForPeriod(closes.slice(-60), 21);
    return emaShort - emaLong;
  };
  let bearish = false, bullish = false, reasons = [];
  if (perTf['1h'] && perTf['1h'].klines) {
    const slope1h = checkSlope(perTf['1h'].klines);
    if (slope1h < 0) { bearish = true; reasons.push('1h EMA slope down'); }
    else { bullish = true; reasons.push('1h EMA slope up'); }
  }
  if (perTf['4h'] && perTf['4h'].klines) {
    const slope4h = checkSlope(perTf['4h'].klines);
    if (slope4h < 0) { bearish = true; reasons.push('4h EMA slope down'); }
    else { bullish = true; reasons.push('4h EMA slope up'); }
  }
  return { bearish, bullish, reasons, fibData };
}

// --- Decide entry, SL, TP using fibs and EMA breakdown ---
async function decideEntryAndRisk(symbol, currentPrice, ema9, highestPeak) {
  const fibData = await computeMultiTfFib(symbol);
  const pref = fibData.preferred;
  if (!pref) {
    const riskAmount = highestPeak - currentPrice;
    return {
      entry: parseFloat(currentPrice.toFixed(6)),
      stopLoss: parseFloat(highestPeak.toFixed(6)),
      tp1: parseFloat((currentPrice - riskAmount).toFixed(6)),
      tp2: parseFloat((currentPrice - riskAmount * 2).toFixed(6)),
      fibData
    };
  }

  const retr = pref.fib.retracements;
  let suggestedEntry = currentPrice;
  const levels = ['0.382', '0.5', '0.618'];
  for (const lvl of levels) {
    const lvlPrice = retr[lvl];
    if (!isNaN(lvlPrice) && currentPrice > lvlPrice) {
      suggestedEntry = lvlPrice;
      break;
    }
  }

  if (currentPrice < ema9) suggestedEntry = currentPrice;

  const riskAmount = highestPeak - suggestedEntry;
  const tp1 = suggestedEntry - riskAmount;
  const tp2 = suggestedEntry - riskAmount * 2;

  const ext = pref.fib.extensions;
  const extTargets = Object.values(ext).filter(v => !isNaN(v)).sort((a,b)=>a-b);
  const fibTarget1 = extTargets[0] || tp1;
  const fibTarget2 = extTargets[1] || tp2;

  const chooseTP = (rrTarget, fibTarget) => {
    return fibTarget < rrTarget ? fibTarget : rrTarget;
  };

  return {
    entry: parseFloat(suggestedEntry.toFixed(6)),
    stopLoss: parseFloat(highestPeak.toFixed(6)),
    tp1: parseFloat(chooseTP(tp1, fibTarget1).toFixed(6)),
    tp2: parseFloat(chooseTP(tp2, fibTarget2).toFixed(6)),
    fibData
  };
}

// --- Telegram Alerts ---
async function sendTelegramAlert(coin) {
  const suggestedEntry = coin.suggestedEntry ? `$${formatPrice(coin.suggestedEntry)}` : 'N/A';
  const suggestedSL = coin.suggestedSL ? `$${formatPrice(coin.suggestedSL)}` : 'N/A';

  const message = `
🚀 *MOONSHOT DETECTED* 🚀

*Asset:* ${coin.symbol.replace('USDT', '')} / USDT
*Price:* $${formatPrice(coin.price)}
*24h Change:* +${coin.change24h.toFixed(2)}%
*24h Volume:* $${formatCompact(coin.volume)}
*Confidence:* ${coin.confidence}%

*Suggested Short Entry:* ${suggestedEntry}
*Suggested Stop Loss (Peak):* ${suggestedSL}

_Tracking 5m chart for trend breakdown (SHORT entry)..._

[Trade on Binance](https://www.binance.com/en/trade/${coin.symbol.replace('USDT', '_USDT')})
`;

  try {
    await bot.telegram.sendMessage(CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    console.log(`✅ Moonshot alert sent: ${coin.symbol}`);
  } catch (err) {
    console.error('❌ Telegram Error:', err.message);
  }
}

async function sendDumpAlert(coin) {
  const suggestedEntry = coin.suggestedEntry ? `$${formatPrice(coin.suggestedEntry)}` : 'N/A';
  const suggestedSL = coin.suggestedSL ? `$${formatPrice(coin.suggestedSL)}` : 'N/A';

  const message = `
🔻 *DUMP DETECTED* 🔻

*Asset:* ${coin.symbol.replace('USDT', '')} / USDT
*Price:* $${formatPrice(coin.price)}
*24h Change:* ${coin.change24h.toFixed(2)}%
*24h Volume:* $${formatCompact(coin.volume)}
*Confidence:* ${coin.confidence}%

*Suggested Long Entry:* ${suggestedEntry}
*Suggested Stop Loss (Valley):* ${suggestedSL}

_Tracking 5m chart for trend breakout (LONG entry)..._

[Trade on Binance](https://www.binance.com/en/trade/${coin.symbol.replace('USDT', '_USDT')})
`;

  try {
    await bot.telegram.sendMessage(CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    console.log(`✅ Dump alert sent: ${coin.symbol}`);
  } catch (err) {
    console.error('❌ Telegram Error (dump):', err.message);
  }
}

async function sendShortEntryAlert(symbol, entryPrice, ema, stopLoss, tp1, tp2, confidence=90) {
  const riskPct = (((stopLoss - entryPrice) / entryPrice) * 100).toFixed(2);

  const message = `
🩸 *SHORT ENTRY TRIGGERED* 🩸
_Trend has broken below 5m 9-EMA!_

*Asset:* ${symbol.replace('USDT', '')} / USDT
*Entry Price:* $${formatPrice(entryPrice)}
*9 EMA Level:* $${formatPrice(ema)}

🛡️ *Stop Loss (Peak):* $${formatPrice(stopLoss)} (-${riskPct}%)
🎯 *Take Profit 1 (1:1):* $${formatPrice(tp1)}
🎯 *Take Profit 2 (1:2):* $${formatPrice(tp2)}
*Confidence:* ${confidence}%

[Trade on Binance](https://www.binance.com/en/trade/${symbol.replace('USDT', '_USDT')})
`;

  try {
    await bot.telegram.sendMessage(CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    console.log(`✅ Short Entry alert sent: ${symbol}`);
  } catch (err) {
    console.error('❌ Telegram Error:', err.message);
  }
}

async function sendLongEntryAlert(symbol, entryPrice, ema, stopLoss, tp1, tp2, confidence=90) {
  const riskPct = (((entryPrice - stopLoss) / entryPrice) * 100).toFixed(2);

  const message = `
🟢 *LONG ENTRY TRIGGERED* 🟢
_Trend has broken above 5m 9-EMA!_

*Asset:* ${symbol.replace('USDT', '')} / USDT
*Entry Price:* $${formatPrice(entryPrice)}
*9 EMA Level:* $${formatPrice(ema)}

🛡️ *Stop Loss (Valley):* $${formatPrice(stopLoss)} (-${riskPct}%)
🎯 *Take Profit 1 (1:1):* $${formatPrice(tp1)}
🎯 *Take Profit 2 (1:2):* $${formatPrice(tp2)}
*Confidence:* ${confidence}%

[Trade on Binance](https://www.binance.com/en/trade/${symbol.replace('USDT', '_USDT')})
`;

  try {
    await bot.telegram.sendMessage(CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    console.log(`✅ Long Entry alert sent: ${symbol}`);
  } catch (err) {
    console.error('❌ Telegram Error:', err.message);
  }
}

// --- EMA Breakdown Tracker (For Shorts) ---
async function startEmaTrackerShort(symbol) {
  if (activeTrackers.has(symbol)) return;
  activeTrackers.add(symbol);

  console.log(`👀 Starting SHORT Tracker for ${symbol}...`);

  try {
    const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=100`;
    const klines = await fetchJson(klinesUrl);
    const closes = klines.map(k => parseFloat(k[4]));
    let currentEma = calculateSeedEMAForPeriod(closes, 9);
    let highestPriceSeen = Math.max(...klines.map(k => parseFloat(k[2])));

    const wsKline = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_5m`);
    let entrySignaled = false;

    wsKline.on('message', async (msg) => {
      if (entrySignaled) return;
      const payload = JSON.parse(msg);
      const candle = payload.k;
      const currentPrice = parseFloat(candle.c);
      const highPrice = parseFloat(candle.h);
      const isClosed = candle.x;

      if (highPrice > highestPriceSeen) highestPriceSeen = highPrice;

      const breakdownThreshold = currentEma * 0.995;

      if (currentPrice < breakdownThreshold) {
        // confluence checks
        const tfConf = await multiTfConfluence(symbol);
        const kl15 = klinesCache.get(`${symbol}_15m`)?.klines || klines;
        const dt = detectDoubleTop(kl15, 1.5, 3, 30);
        const vol = volumeSpikeConfirmed(kl15, 1.3, 20);
        const bearishDiv = checkBearishDivergence(kl15, 14, 40);

        const higherBullish = tfConf.bullish && !tfConf.bearish;
        const strongBearConfluence = (dt.isDoubleTop && dt.necklineBroken && vol.confirmed) || bearishDiv || tfConf.bearish;

        if (!strongBearConfluence && higherBullish) {
          console.log(`⛔ Suppressed short for ${symbol} due to higher-TF bullish trend and lack of confluence`);
          entrySignaled = true;
          try { wsKline.close(); } catch (e) {}
          activeTrackers.delete(symbol);
          return;
        }

        entrySignaled = true;

        const decision = await decideEntryAndRisk(symbol, currentPrice, currentEma, highestPriceSeen);

        const confidence = strongBearConfluence ? 92 : 70;
        sendShortEntryAlert(symbol, decision.entry, currentEma, decision.stopLoss, decision.tp1, decision.tp2, confidence);

        try { wsKline.close(); } catch (e) {}
        activeTrackers.delete(symbol);
      }

      if (isClosed) {
        const multiplier = 2 / (9 + 1);
        currentEma = (currentPrice - currentEma) * multiplier + currentEma;
      }
    });

    setTimeout(() => {
      if (!entrySignaled) {
        try { wsKline.close(); } catch (e) {}
        activeTrackers.delete(symbol);
        console.log(`⏱️ SHORT Tracker for ${symbol} timed out. Pump didn't break.`);
      }
    }, 2 * 60 * 60 * 1000);

  } catch (err) {
    console.error(`❌ Tracker error for ${symbol}:`, err.message);
    activeTrackers.delete(symbol);
  }
}

// --- EMA Breakout Tracker (For Longs) ---
async function startEmaTrackerLong(symbol) {
  if (activeTrackers.has(symbol)) return;
  activeTrackers.add(symbol);

  console.log(`👀 Starting LONG Tracker for ${symbol}...`);

  try {
    const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=100`;
    const klines = await fetchJson(klinesUrl);
    const closes = klines.map(k => parseFloat(k[4]));
    let currentEma = calculateSeedEMAForPeriod(closes, 9);
    let lowestPriceSeen = Math.min(...klines.map(k => parseFloat(k[3])));

    const wsKline = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_5m`);
    let entrySignaled = false;

    wsKline.on('message', async (msg) => {
      if (entrySignaled) return;
      const payload = JSON.parse(msg);
      const candle = payload.k;
      const currentPrice = parseFloat(candle.c);
      const lowPrice = parseFloat(candle.l);
      const isClosed = candle.x;

      if (lowPrice < lowestPriceSeen) lowestPriceSeen = lowPrice;

      const breakoutThreshold = currentEma * 1.005;

      if (currentPrice > breakoutThreshold) {
        // confluence checks for long
        const tfConf = await multiTfConfluence(symbol);
        const kl15 = klinesCache.get(`${symbol}_15m`)?.klines || klines;
        const db = detectDoubleBottom(kl15, 1.5, 3, 30);
        const vol = volumeSpikeConfirmed(kl15, 1.3, 20);
        const bullishDiv = checkBullishDivergence(kl15, 14, 40);

        const higherBearish = tfConf.bearish && !tfConf.bullish;
        const strongBullConfluence = (db.isDoubleBottom && db.necklineBroken && vol.confirmed) || bullishDiv || tfConf.bullish;

        if (!strongBullConfluence && higherBearish) {
          console.log(`⛔ Suppressed long for ${symbol} due to higher-TF bearish trend and lack of confluence`);
          entrySignaled = true;
          try { wsKline.close(); } catch (e) {}
          activeTrackers.delete(symbol);
          return;
        }

        entrySignaled = true;

        const fibData = await computeMultiTfFib(symbol);
        const pref = fibData.preferred;
        let suggestedEntry = currentPrice;
        if (pref && pref.fib && pref.fib.retracements) {
          const levels = ['0.618','0.5','0.382'];
          for (const lvl of levels) {
            const lvlPrice = pref.fib.retracements[lvl];
            if (!isNaN(lvlPrice) && currentPrice < lvlPrice) {
              suggestedEntry = lvlPrice;
              break;
            }
          }
        }
        if (currentPrice > currentEma) suggestedEntry = currentPrice;

        const stopLoss = lowestPriceSeen;
        const riskAmount = suggestedEntry - stopLoss;
        const tp1 = suggestedEntry + riskAmount;
        const tp2 = suggestedEntry + riskAmount * 2;

        const confidence = strongBullConfluence ? 92 : 70;
        sendLongEntryAlert(symbol, suggestedEntry, currentEma, stopLoss, tp1, tp2, confidence);

        try { wsKline.close(); } catch (e) {}
        activeTrackers.delete(symbol);
      }

      if (isClosed) {
        const multiplier = 2 / (9 + 1);
        currentEma = (currentPrice - currentEma) * multiplier + currentEma;
      }
    });

    setTimeout(() => {
      if (!entrySignaled) {
        try { wsKline.close(); } catch (e) {}
        activeTrackers.delete(symbol);
        console.log(`⏱️ LONG Tracker for ${symbol} timed out. No breakout.`);
      }
    }, 2 * 60 * 60 * 1000);

  } catch (err) {
    console.error(`❌ Tracker error for ${symbol}:`, err.message);
    activeTrackers.delete(symbol);
  }
}

// --- Signal Logic (strict routing: moonshot -> short tracker, dump -> long tracker) ---
async function processSignals() {
  const tickers = Object.values(state.tickers);
  for (const t of tickers) {
    if (!t || t.high === t.low) continue;

    const rangePos = (t.price - t.low) / (t.high - t.low);
    const isMoonshot = t.change24h > 12 && rangePos > 0.85;
    const isDump = t.change24h < -12 && rangePos < 0.15; // mirror thresholds for dumps

    // MOONSHOT branch: only start SHORT tracker
    if (isMoonshot && !state.sentSignals.has(t.symbol)) {
      state.sentSignals.add(t.symbol);
      t.confidence = 85 + Math.floor(Math.random() * 10);

      try {
        const fibSummary = await computeMultiTfFib(t.symbol);
        if (fibSummary && fibSummary.preferred) {
          const suggestedEntry = fibSummary.preferred.fib.retracements['0.382'] || fibSummary.preferred.fib.retracements['0.5'] || null;
          const suggestedSL = fibSummary.preferred.high || null;
          if (suggestedEntry) t.suggestedEntry = suggestedEntry;
          if (suggestedSL) t.suggestedSL = suggestedSL;
        }
      } catch (err) {
        console.error('Error computing fib summary:', err.message);
      }

      const tfConf = await multiTfConfluence(t.symbol);
      const kl15 = klinesCache.get(`${t.symbol}_15m`)?.klines;
      let dt = { isDoubleTop: false };
      if (kl15) dt = detectDoubleTop(kl15, 1.5, 3, 30);
      if (!kl15) t.confidence = Math.max(60, t.confidence - 15);

      // Always send moonshot alert and start SHORT tracker only
      await sendTelegramAlert(t);
      startEmaTrackerShort(t.symbol);

      // allow re-alert after 1 hour
      setTimeout(() => {
        state.sentSignals.delete(t.symbol);
      }, 60 * 60 * 1000);

      continue;
    }

    // DUMP branch: only start LONG tracker
    if (isDump && !state.sentSignals.has(t.symbol)) {
      state.sentSignals.add(t.symbol);
      t.confidence = 85 + Math.floor(Math.random() * 10);

      try {
        const fibSummary = await computeMultiTfFib(t.symbol);
        if (fibSummary && fibSummary.preferred) {
          const suggestedEntry = fibSummary.preferred.fib.retracements['0.618'] || fibSummary.preferred.fib.retracements['0.5'] || null;
          const suggestedSL = fibSummary.preferred.low || null;
          if (suggestedEntry) t.suggestedEntry = suggestedEntry;
          if (suggestedSL) t.suggestedSL = suggestedSL;
        }
      } catch (err) {
        console.error('Error computing fib summary for dump:', err.message);
      }

      const tfConf = await multiTfConfluence(t.symbol);
      const kl15 = klinesCache.get(`${t.symbol}_15m`)?.klines;
      let db = { isDoubleBottom: false };
      if (kl15) db = detectDoubleBottom(kl15, 1.5, 3, 30);
      if (!kl15) t.confidence = Math.max(60, t.confidence - 15);

      // Always send dump alert and start LONG tracker only
      await sendDumpAlert(t);
      startEmaTrackerLong(t.symbol);

      // allow re-alert after 1 hour
      setTimeout(() => {
        state.sentSignals.delete(t.symbol);
      }, 60 * 60 * 1000);

      continue;
    }

    // otherwise: no action for this ticker
  }
}

// --- Binance WebSocket (Direct) ---
function initWebSocket() {
  const ws = new WebSocket(WS_URL);

  ws.on('message', async (data) => {
    try {
      const tickers = JSON.parse(data);

      tickers.forEach((t) => {
        if (!t.s || !t.s.endsWith('USDT')) return;

        state.tickers[t.s] = {
          symbol: t.s,
          price: parseFloat(t.c),
          high: parseFloat(t.h),
          low: parseFloat(t.l),
          volume: parseFloat(t.q),
          change24h: parseFloat(t.P) || 0
        };
      });

      await processSignals();
    } catch (err) {
      console.error('❌ Error processing WS message:', err.message);
    }
  });

  ws.on('open', () => console.log('✅ Binance WebSocket connected'));
  ws.on('close', () => {
    console.log('⚠️ Binance WebSocket closed, reconnecting in 5s...');
    setTimeout(initWebSocket, 5000);
  });
  ws.on('error', (err) => console.error('❌ WS Error:', err.message));
}

// --- Startup ---
(async () => {
  try {
    await bot.telegram.getMe();
    console.log('✅ Telegram connected (IPv4 forced)');
  } catch (err) {
    console.error('❌ Telegram still blocked:', err.message);
    console.error('➡️ Network-level block confirmed');
  }

  initWebSocket();
  console.log('🚀 Nexus Background Service Started');
})();
