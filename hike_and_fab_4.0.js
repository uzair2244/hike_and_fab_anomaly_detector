/**
 * Nexus Moonshot & Dump Detector + SHORT/LONG Entry Trackers
 * Railway-compatible version: REST polling instead of WebSockets
 *
 * Replace TELEGRAM_TOKEN and CHAT_ID with your values.
 */

const { Telegraf } = require('telegraf');
const https = require('https');

// ================= CONFIG =================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'your-telegram-bot-token-here';
const CHAT_ID = process.env.CHAT_ID || 'xxxxxx';

const TICKER_POLL_INTERVAL_MS = 7000;   // poll all tickers every 7s
const TRACKER_POLL_INTERVAL_MS = 10000; // poll klines every 10s for active trackers
const TRACKER_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h tracker timeout
// =========================================

// --- Force IPv4 for Telegram ---
const ipv4Agent = new https.Agent({ family: 4 });

const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { agent: ipv4Agent }
});

// --- App State ---
const state = {
  tickers: {},
  sentSignals: new Set()
};

const activeTrackers = new Set();
const fibCache = new Map();
const klinesCache = new Map();

// --- Utilities ---
const formatPrice = (price) =>
  price < 1 ? price.toFixed(6) : price.toFixed(4);

const formatCompact = (num) =>
  Intl.NumberFormat('en-US', { notation: 'compact' }).format(num);

// --- Binance host rotation (fallback for IP-blocked environments like Railway) ---
const BINANCE_HOSTS = [
  'api.binance.com',
  'api1.binance.com',
  'api2.binance.com',
  'api3.binance.com'
];
let currentHostIdx = 0;

function rotatePath(originalUrl) {
  // Swap out just the host portion, keep the path intact
  return originalUrl.replace('api.binance.com', BINANCE_HOSTS[currentHostIdx]);
}

function fetchJsonOnce(url) {
  return new Promise((resolve, reject) => {
    const finalUrl = rotatePath(url);
    https.get(finalUrl, { agent: new https.Agent({ family: 4 }) }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Binance returns { code: <negative>, msg: "..." } on errors
          if (parsed && !Array.isArray(parsed) && typeof parsed.code === 'number' && parsed.code < 0) {
            reject(new Error(`Binance API error ${parsed.code}: ${parsed.msg}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          // Likely got an HTML block/Cloudflare page instead of JSON
          reject(new Error(`JSON parse failed on ${finalUrl} — possible IP block (got HTML?)`));
        }
      });
    }).on('error', reject);
  });
}

// Tries all 4 hosts in round-robin before giving up
async function fetchJson(url) {
  let lastError;
  for (let attempt = 0; attempt < BINANCE_HOSTS.length; attempt++) {
    try {
      return await fetchJsonOnce(url);
    } catch (err) {
      lastError = err;
      console.warn(`⚠️  [${BINANCE_HOSTS[currentHostIdx]}] failed (attempt ${attempt + 1}): ${err.message}`);
      currentHostIdx = (currentHostIdx + 1) % BINANCE_HOSTS.length;
      await new Promise(r => setTimeout(r, 600)); // brief pause before retry
    }
  }
  throw lastError;
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
  return values.reduce((a, b) => a + b, 0) / values.length;
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
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function findSwingHighLow(klines, lookback) {
  const slice = klines.slice(-lookback);
  return {
    high: Math.max(...slice.map(k => parseFloat(k[2]))),
    low: Math.min(...slice.map(k => parseFloat(k[3])))
  };
}

function fibonacciLevels(low, high) {
  const diff = high - low;
  return {
    retracements: {
      '0.236': high - diff * 0.236,
      '0.382': high - diff * 0.382,
      '0.5':   high - diff * 0.5,
      '0.618': high - diff * 0.618,
      '0.786': high - diff * 0.786
    },
    extensions: {
      '1.272': high - diff * 0.272,
      '1.414': high - diff * 0.414,
      '1.618': high - diff * 0.618
    }
  };
}

async function computeMultiTfFib(symbol) {
  const cached = fibCache.get(symbol);
  const now = Date.now();
  if (cached && (now - cached.ts) < 60 * 1000) return cached.value;

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
      klinesCache.set(`${symbol}_${tf.interval}`, { ts: now, klines });
    } catch (err) {
      console.error(`Error fetching ${symbol} ${tf.interval}:`, err.message);
    }
  }

  const preferred = results['1h'] || results['4h'] || results['15m'] || results['5m'] || results['1d'] || null;
  const value = { perTf: results, preferred };
  fibCache.set(symbol, { ts: now, value });
  return value;
}

function detectDoubleTop(klines, tolerancePct = 1.2, minSep = 3, maxSep = 30) {
  const highs = klines.map(k => parseFloat(k[2]));
  const peaks = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] >= highs[i-1] && highs[i] >= highs[i-2] &&
        highs[i] >= highs[i+1] && highs[i] >= highs[i+2]) {
      peaks.push({ idx: i, price: highs[i] });
    }
  }
  if (peaks.length < 2) return { isDoubleTop: false };

  const p2 = peaks[peaks.length - 1];
  let p1 = null;
  for (let i = peaks.length - 2; i >= 0; i--) {
    const sep = p2.idx - peaks[i].idx;
    if (sep >= minSep && sep <= maxSep) { p1 = peaks[i]; break; }
  }
  if (!p1) return { isDoubleTop: false };

  const diffPct = Math.abs((p1.price - p2.price) / ((p1.price + p2.price) / 2)) * 100;
  if (diffPct > tolerancePct) return { isDoubleTop: false };

  const neckline = Math.min(...klines.slice(p1.idx, p2.idx + 1).map(k => parseFloat(k[3])));
  const lastClose = parseFloat(klines[klines.length - 1][4]);
  return { isDoubleTop: true, peak1: p1, peak2: p2, neckline, necklineBroken: lastClose < neckline, diffPct };
}

function detectDoubleBottom(klines, tolerancePct = 1.2, minSep = 3, maxSep = 30) {
  const lows = klines.map(k => parseFloat(k[3]));
  const bottoms = [];
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] <= lows[i-1] && lows[i] <= lows[i-2] &&
        lows[i] <= lows[i+1] && lows[i] <= lows[i+2]) {
      bottoms.push({ idx: i, price: lows[i] });
    }
  }
  if (bottoms.length < 2) return { isDoubleBottom: false };

  const b2 = bottoms[bottoms.length - 1];
  let b1 = null;
  for (let i = bottoms.length - 2; i >= 0; i--) {
    const sep = b2.idx - bottoms[i].idx;
    if (sep >= minSep && sep <= maxSep) { b1 = bottoms[i]; break; }
  }
  if (!b1) return { isDoubleBottom: false };

  const diffPct = Math.abs((b1.price - b2.price) / ((b1.price + b2.price) / 2)) * 100;
  if (diffPct > tolerancePct) return { isDoubleBottom: false };

  const neckline = Math.max(...klines.slice(b1.idx, b2.idx + 1).map(k => parseFloat(k[2])));
  const lastClose = parseFloat(klines[klines.length - 1][4]);
  return { isDoubleBottom: true, bottom1: b1, bottom2: b2, neckline, necklineBroken: lastClose > neckline, diffPct };
}

function volumeSpikeConfirmed(klines, multiplier = 1.5, lookback = 20) {
  const vols = klines.slice(-lookback).map(k => parseFloat(k[5]));
  const avg = sma(vols.slice(0, vols.length - 1));
  const lastVol = parseFloat(klines[klines.length - 1][5]);
  return { confirmed: lastVol >= avg * multiplier, lastVol, avg };
}

function checkBearishDivergence(klines, rsiPeriod = 14, lookback = 40) {
  const closes = klines.map(k => parseFloat(k[4]));
  if (closes.length < lookback + rsiPeriod) return false;
  const slice = closes.slice(-lookback - rsiPeriod);
  const rsiSeries = [];
  for (let i = rsiPeriod; i < slice.length; i++) {
    rsiSeries.push(computeRSI(slice.slice(i - rsiPeriod, i + 1), rsiPeriod));
  }
  const highs = [];
  for (let i = 2; i < closes.length - 2; i++) {
    if (closes[i] >= closes[i-1] && closes[i] >= closes[i-2] &&
        closes[i] >= closes[i+1] && closes[i] >= closes[i+2]) {
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
  const offset = closes.length - slice.length;
  const rsiH1 = rsiSeries[h1.idx - offset - rsiPeriod] ?? null;
  const rsiH2 = rsiSeries[h2.idx - offset - rsiPeriod] ?? null;
  if (rsiH1 === null || rsiH2 === null) return false;
  return h2.price >= h1.price && rsiH2 < rsiH1;
}

function checkBullishDivergence(klines, rsiPeriod = 14, lookback = 40) {
  const closes = klines.map(k => parseFloat(k[4]));
  if (closes.length < lookback + rsiPeriod) return false;
  const slice = closes.slice(-lookback - rsiPeriod);
  const rsiSeries = [];
  for (let i = rsiPeriod; i < slice.length; i++) {
    rsiSeries.push(computeRSI(slice.slice(i - rsiPeriod, i + 1), rsiPeriod));
  }
  const lows = [];
  for (let i = 2; i < closes.length - 2; i++) {
    if (closes[i] <= closes[i-1] && closes[i] <= closes[i-2] &&
        closes[i] <= closes[i+1] && closes[i] <= closes[i+2]) {
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
  const offset = closes.length - slice.length;
  const rsiL1 = rsiSeries[l1.idx - offset - rsiPeriod] ?? null;
  const rsiL2 = rsiSeries[l2.idx - offset - rsiPeriod] ?? null;
  if (rsiL1 === null || rsiL2 === null) return false;
  return l2.price <= l1.price && rsiL2 > rsiL1;
}

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
  if (perTf['1h']?.klines) {
    const slope = checkSlope(perTf['1h'].klines);
    if (slope < 0) { bearish = true; reasons.push('1h EMA slope down'); }
    else { bullish = true; reasons.push('1h EMA slope up'); }
  }
  if (perTf['4h']?.klines) {
    const slope = checkSlope(perTf['4h'].klines);
    if (slope < 0) { bearish = true; reasons.push('4h EMA slope down'); }
    else { bullish = true; reasons.push('4h EMA slope up'); }
  }
  return { bearish, bullish, reasons, fibData };
}

async function decideEntryAndRisk(symbol, currentPrice, ema9, highestPeak) {
  const fibData = await computeMultiTfFib(symbol);
  const pref = fibData.preferred;
  if (!pref) {
    const risk = highestPeak - currentPrice;
    return {
      entry: +currentPrice.toFixed(6),
      stopLoss: +highestPeak.toFixed(6),
      tp1: +(currentPrice - risk).toFixed(6),
      tp2: +(currentPrice - risk * 2).toFixed(6),
      fibData
    };
  }
  const retr = pref.fib.retracements;
  let suggestedEntry = currentPrice;
  for (const lvl of ['0.382', '0.5', '0.618']) {
    const lvlPrice = retr[lvl];
    if (!isNaN(lvlPrice) && currentPrice > lvlPrice) { suggestedEntry = lvlPrice; break; }
  }
  if (currentPrice < ema9) suggestedEntry = currentPrice;

  const risk = highestPeak - suggestedEntry;
  const extTargets = Object.values(pref.fib.extensions)
    .filter(v => !isNaN(v)).sort((a, b) => a - b);

  const chooseTP = (rr, fib) => fib < rr ? fib : rr;

  return {
    entry: +suggestedEntry.toFixed(6),
    stopLoss: +highestPeak.toFixed(6),
    tp1: +chooseTP(suggestedEntry - risk, extTargets[0] || suggestedEntry - risk).toFixed(6),
    tp2: +chooseTP(suggestedEntry - risk * 2, extTargets[1] || suggestedEntry - risk * 2).toFixed(6),
    fibData
  };
}

// --- Telegram Alerts (unchanged logic) ---
async function sendTelegramAlert(coin) {
  const entry = coin.suggestedEntry ? `$${formatPrice(coin.suggestedEntry)}` : 'N/A';
  const sl = coin.suggestedSL ? `$${formatPrice(coin.suggestedSL)}` : 'N/A';
  const message = `
🚀 *MOONSHOT DETECTED* 🚀

*Asset:* ${coin.symbol.replace('USDT', '')} / USDT
*Price:* $${formatPrice(coin.price)}
*24h Change:* +${coin.change24h.toFixed(2)}%
*24h Volume:* $${formatCompact(coin.volume)}
*Confidence:* ${coin.confidence}%

*Suggested Short Entry:* ${entry}
*Suggested Stop Loss (Peak):* ${sl}

_Tracking 5m chart for trend breakdown (SHORT entry)..._

[Trade on Binance](https://www.binance.com/en/trade/${coin.symbol.replace('USDT', '_USDT')})
`;
  try {
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    console.log(`✅ Moonshot alert sent: ${coin.symbol}`);
  } catch (err) { console.error('❌ Telegram Error:', err.message); }
}

async function sendDumpAlert(coin) {
  const entry = coin.suggestedEntry ? `$${formatPrice(coin.suggestedEntry)}` : 'N/A';
  const sl = coin.suggestedSL ? `$${formatPrice(coin.suggestedSL)}` : 'N/A';
  const message = `
🔻 *DUMP DETECTED* 🔻

*Asset:* ${coin.symbol.replace('USDT', '')} / USDT
*Price:* $${formatPrice(coin.price)}
*24h Change:* ${coin.change24h.toFixed(2)}%
*24h Volume:* $${formatCompact(coin.volume)}
*Confidence:* ${coin.confidence}%

*Suggested Long Entry:* ${entry}
*Suggested Stop Loss (Valley):* ${sl}

_Tracking 5m chart for trend breakout (LONG entry)..._

[Trade on Binance](https://www.binance.com/en/trade/${coin.symbol.replace('USDT', '_USDT')})
`;
  try {
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    console.log(`✅ Dump alert sent: ${coin.symbol}`);
  } catch (err) { console.error('❌ Telegram Error (dump):', err.message); }
}

async function sendShortEntryAlert(symbol, entryPrice, ema, stopLoss, tp1, tp2, confidence = 90) {
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
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    console.log(`✅ Short Entry alert sent: ${symbol}`);
  } catch (err) { console.error('❌ Telegram Error:', err.message); }
}

async function sendLongEntryAlert(symbol, entryPrice, ema, stopLoss, tp1, tp2, confidence = 90) {
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
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    console.log(`✅ Long Entry alert sent: ${symbol}`);
  } catch (err) { console.error('❌ Telegram Error:', err.message); }
}

// -------------------------------------------------------
// REST-BASED TRACKER: SHORT (replaces WebSocket kline tracker)
// -------------------------------------------------------
async function startEmaTrackerShort(symbol) {
  if (activeTrackers.has(symbol)) return;
  activeTrackers.add(symbol);
  console.log(`👀 Starting SHORT REST Tracker for ${symbol}...`);

  let entrySignaled = false;
  const startTime = Date.now();

  try {
    const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=200`;
    const initialKlines = await fetchJson(klinesUrl);
    const closes = initialKlines.map(k => parseFloat(k[4]));
    let currentEma = calculateSeedEMAForPeriod(closes, 9);
    let highestPriceSeen = Math.max(...initialKlines.map(k => parseFloat(k[2])));
    let lastCandleTime = parseInt(initialKlines[initialKlines.length - 1][0]);

    const interval = setInterval(async () => {
      if (entrySignaled) { clearInterval(interval); return; }

      // Timeout check
      if (Date.now() - startTime > TRACKER_TIMEOUT_MS) {
        console.log(`⏱️ SHORT Tracker for ${symbol} timed out.`);
        clearInterval(interval);
        activeTrackers.delete(symbol);
        return;
      }

      try {
        // Fetch the latest few candles
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=5`;
        const recent = await fetchJson(url);
        if (!recent || recent.length === 0) return;

        // Update highest price seen
        for (const k of recent) {
          const h = parseFloat(k[2]);
          if (h > highestPriceSeen) highestPriceSeen = h;
        }

        // Update EMA for any newly closed candles
        for (const k of recent) {
          const candleOpen = parseInt(k[0]);
          const isClosed = k[6] < Date.now(); // close time in past = closed candle
          if (isClosed && candleOpen > lastCandleTime) {
            const closePrice = parseFloat(k[4]);
            const multiplier = 2 / (9 + 1);
            currentEma = (closePrice - currentEma) * multiplier + currentEma;
            lastCandleTime = candleOpen;
          }
        }

        // Check current (last) candle's close vs EMA
        const lastCandle = recent[recent.length - 1];
        const currentPrice = parseFloat(lastCandle[4]);
        const breakdownThreshold = currentEma * 0.995;

        if (currentPrice < breakdownThreshold) {
          const tfConf = await multiTfConfluence(symbol);
          const kl15 = klinesCache.get(`${symbol}_15m`)?.klines;
          const dt = kl15 ? detectDoubleTop(kl15, 1.5, 3, 30) : { isDoubleTop: false };
          const vol = kl15 ? volumeSpikeConfirmed(kl15, 1.3, 20) : { confirmed: false };
          const bearishDiv = kl15 ? checkBearishDivergence(kl15, 14, 40) : false;

          const higherBullish = tfConf.bullish && !tfConf.bearish;
          const strongBearConfluence = (dt.isDoubleTop && dt.necklineBroken && vol.confirmed) || bearishDiv || tfConf.bearish;

          if (!strongBearConfluence && higherBullish) {
            console.log(`⛔ Suppressed short for ${symbol}: higher-TF bullish`);
            entrySignaled = true;
            clearInterval(interval);
            activeTrackers.delete(symbol);
            return;
          }

          entrySignaled = true;
          clearInterval(interval);
          activeTrackers.delete(symbol);

          const decision = await decideEntryAndRisk(symbol, currentPrice, currentEma, highestPriceSeen);
          const confidence = strongBearConfluence ? 92 : 70;
          await sendShortEntryAlert(symbol, decision.entry, currentEma, decision.stopLoss, decision.tp1, decision.tp2, confidence);
        }
      } catch (err) {
        console.error(`❌ SHORT tracker poll error ${symbol}:`, err.message);
      }
    }, TRACKER_POLL_INTERVAL_MS);

  } catch (err) {
    console.error(`❌ SHORT tracker init error ${symbol}:`, err.message);
    activeTrackers.delete(symbol);
  }
}

// -------------------------------------------------------
// REST-BASED TRACKER: LONG (replaces WebSocket kline tracker)
// -------------------------------------------------------
async function startEmaTrackerLong(symbol) {
  if (activeTrackers.has(symbol)) return;
  activeTrackers.add(symbol);
  console.log(`👀 Starting LONG REST Tracker for ${symbol}...`);

  let entrySignaled = false;
  const startTime = Date.now();

  try {
    const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=200`;
    const initialKlines = await fetchJson(klinesUrl);
    const closes = initialKlines.map(k => parseFloat(k[4]));
    let currentEma = calculateSeedEMAForPeriod(closes, 9);
    let lowestPriceSeen = Math.min(...initialKlines.map(k => parseFloat(k[3])));
    let lastCandleTime = parseInt(initialKlines[initialKlines.length - 1][0]);

    const interval = setInterval(async () => {
      if (entrySignaled) { clearInterval(interval); return; }

      if (Date.now() - startTime > TRACKER_TIMEOUT_MS) {
        console.log(`⏱️ LONG Tracker for ${symbol} timed out.`);
        clearInterval(interval);
        activeTrackers.delete(symbol);
        return;
      }

      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=5`;
        const recent = await fetchJson(url);
        if (!recent || recent.length === 0) return;

        for (const k of recent) {
          const l = parseFloat(k[3]);
          if (l < lowestPriceSeen) lowestPriceSeen = l;
        }

        for (const k of recent) {
          const candleOpen = parseInt(k[0]);
          const isClosed = k[6] < Date.now();
          if (isClosed && candleOpen > lastCandleTime) {
            const closePrice = parseFloat(k[4]);
            const multiplier = 2 / (9 + 1);
            currentEma = (closePrice - currentEma) * multiplier + currentEma;
            lastCandleTime = candleOpen;
          }
        }

        const lastCandle = recent[recent.length - 1];
        const currentPrice = parseFloat(lastCandle[4]);
        const breakoutThreshold = currentEma * 1.005;

        if (currentPrice > breakoutThreshold) {
          const tfConf = await multiTfConfluence(symbol);
          const kl15 = klinesCache.get(`${symbol}_15m`)?.klines;
          const db = kl15 ? detectDoubleBottom(kl15, 1.5, 3, 30) : { isDoubleBottom: false };
          const vol = kl15 ? volumeSpikeConfirmed(kl15, 1.3, 20) : { confirmed: false };
          const bullishDiv = kl15 ? checkBullishDivergence(kl15, 14, 40) : false;

          const higherBearish = tfConf.bearish && !tfConf.bullish;
          const strongBullConfluence = (db.isDoubleBottom && db.necklineBroken && vol.confirmed) || bullishDiv || tfConf.bullish;

          if (!strongBullConfluence && higherBearish) {
            console.log(`⛔ Suppressed long for ${symbol}: higher-TF bearish`);
            entrySignaled = true;
            clearInterval(interval);
            activeTrackers.delete(symbol);
            return;
          }

          entrySignaled = true;
          clearInterval(interval);
          activeTrackers.delete(symbol);

          const fibData = await computeMultiTfFib(symbol);
          const pref = fibData.preferred;
          let suggestedEntry = currentPrice;
          if (pref?.fib?.retracements) {
            for (const lvl of ['0.618', '0.5', '0.382']) {
              const lvlPrice = pref.fib.retracements[lvl];
              if (!isNaN(lvlPrice) && currentPrice < lvlPrice) { suggestedEntry = lvlPrice; break; }
            }
          }
          if (currentPrice > currentEma) suggestedEntry = currentPrice;

          const risk = suggestedEntry - lowestPriceSeen;
          const confidence = strongBullConfluence ? 92 : 70;
          await sendLongEntryAlert(symbol, suggestedEntry, currentEma,
            lowestPriceSeen,
            +(suggestedEntry + risk).toFixed(6),
            +(suggestedEntry + risk * 2).toFixed(6),
            confidence
          );
        }
      } catch (err) {
        console.error(`❌ LONG tracker poll error ${symbol}:`, err.message);
      }
    }, TRACKER_POLL_INTERVAL_MS);

  } catch (err) {
    console.error(`❌ LONG tracker init error ${symbol}:`, err.message);
    activeTrackers.delete(symbol);
  }
}

// --- Signal Logic ---
async function processSignals() {
  const tickers = Object.values(state.tickers);
  for (const t of tickers) {
    if (!t || t.high === t.low) continue;
    const rangePos = (t.price - t.low) / (t.high - t.low);
    const isMoonshot = t.change24h > 12 && rangePos > 0.85;
    const isDump = t.change24h < -12 && rangePos < 0.15;

    if (isMoonshot && !state.sentSignals.has(t.symbol)) {
      state.sentSignals.add(t.symbol);
      t.confidence = 85 + Math.floor(Math.random() * 10);
      try {
        const fibSummary = await computeMultiTfFib(t.symbol);
        if (fibSummary?.preferred) {
          t.suggestedEntry = fibSummary.preferred.fib.retracements['0.382'] || fibSummary.preferred.fib.retracements['0.5'] || null;
          t.suggestedSL = fibSummary.preferred.high || null;
        }
      } catch (err) { console.error('Fib error:', err.message); }
      await sendTelegramAlert(t);
      startEmaTrackerShort(t.symbol);
      setTimeout(() => state.sentSignals.delete(t.symbol), 60 * 60 * 1000);
      continue;
    }

    if (isDump && !state.sentSignals.has(t.symbol)) {
      state.sentSignals.add(t.symbol);
      t.confidence = 85 + Math.floor(Math.random() * 10);
      try {
        const fibSummary = await computeMultiTfFib(t.symbol);
        if (fibSummary?.preferred) {
          t.suggestedEntry = fibSummary.preferred.fib.retracements['0.618'] || fibSummary.preferred.fib.retracements['0.5'] || null;
          t.suggestedSL = fibSummary.preferred.low || null;
        }
      } catch (err) { console.error('Fib error:', err.message); }
      await sendDumpAlert(t);
      startEmaTrackerLong(t.symbol);
      setTimeout(() => state.sentSignals.delete(t.symbol), 60 * 60 * 1000);
      continue;
    }
  }
}

// -------------------------------------------------------
// REST POLLING: replaces Binance WebSocket ticker stream
// -------------------------------------------------------
async function pollTickers() {
  try {
    const url = 'https://api.binance.com/api/v3/ticker/24hr';
    const response = await fetchJson(url);

    // Log the raw response type so we can diagnose issues
    if (!Array.isArray(response)) {
      console.error('❌ Binance returned non-array response:', JSON.stringify(response).slice(0, 300));
      return;
    }

    response.forEach((t) => {
      if (!t.symbol || !t.symbol.endsWith('USDT')) return;
      state.tickers[t.symbol] = {
        symbol: t.symbol,
        price:    parseFloat(t.lastPrice),
        high:     parseFloat(t.highPrice),
        low:      parseFloat(t.lowPrice),
        volume:   parseFloat(t.quoteVolume),
        change24h: parseFloat(t.priceChangePercent) || 0
      };
    });

    console.log(`📊 Polled ${Object.keys(state.tickers).length} USDT tickers`);
    await processSignals();
  } catch (err) {
    console.error('❌ Ticker poll error:', err.message);
  }
}

// --- Startup ---
(async () => {
  try {
    await bot.telegram.getMe();
    console.log('✅ Telegram connected (IPv4 forced)');
  } catch (err) {
    console.error('❌ Telegram connection failed:', err.message);
  }

  // Initial poll immediately, then repeat
  await pollTickers();
  setInterval(pollTickers, TICKER_POLL_INTERVAL_MS);

  console.log('🚀 Nexus REST Polling Service Started (Railway-compatible, no WebSockets)');
})();