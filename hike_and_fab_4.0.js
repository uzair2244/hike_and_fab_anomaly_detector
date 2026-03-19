/**
 * Nexus Moonshot & Dump Detector + SHORT/LONG Entry Trackers
 * MEXC WebSocket version — real-time, Railway-compatible (no Binance geo-block)
 *
 * WS streams used:
 *   Tickers  → wss://wbs.mexc.com/ws  →  spot@public.miniTickers.v3.api
 *   Klines   → wss://wbs.mexc.com/ws  →  spot@public.kline.v3.api@{SYMBOL}@Min5
 *
 * Replace TELEGRAM_TOKEN and CHAT_ID with your values.
 */

const { Telegraf } = require('telegraf');
const WebSocket    = require('ws');
const https        = require('https');

// ================= CONFIG =================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'your-telegram-bot-token-here';
const CHAT_ID = process.env.CHAT_ID || 'xxxxxx';

const MEXC_WS_URL  = 'wss://wbs.mexc.com/ws';
const MEXC_REST    = 'https://api.mexc.com';
const PING_INTERVAL_MS   = 15_000;  // MEXC requires ping every <30s
const TRACKER_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h per tracker
// =========================================

// --- Force IPv4 for Telegram ---
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { agent: new https.Agent({ family: 4 }) }
});

// --- App State ---
const state = {
  tickers:     {},
  sentSignals: new Set()
};

const activeTrackers = new Set();
const fibCache       = new Map();
const klinesCache    = new Map();

// -------------------------------------------------------
// MEXC WS INTERVAL MAP
// -------------------------------------------------------
const WS_INTERVAL = {
  '1m': 'Min1', '5m': 'Min5', '15m': 'Min15',
  '30m': 'Min30', '1h': 'Min60', '4h': 'Hour4', '1d': 'Day1'
};

// -------------------------------------------------------
// HELPERS
// -------------------------------------------------------
const formatPrice   = p  => p < 1 ? p.toFixed(6) : p.toFixed(4);
const formatCompact = n  => Intl.NumberFormat('en-US', { notation: 'compact' }).format(n);
const tradeUrl      = sym => `https://www.mexc.com/exchange/${sym.replace('USDT', '')}_USDT`;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent: new https.Agent({ family: 4 }) }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message} — url: ${url}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchMexcKlines(symbol, interval, limit) {
  const url = `${MEXC_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const klines = await fetchJson(url);
  if (!Array.isArray(klines)) throw new Error(`MEXC klines error: ${JSON.stringify(klines).slice(0, 200)}`);
  return klines; // oldest-first, same index layout as Binance
}

// -------------------------------------------------------
// MEXC WS FACTORY
// Creates a managed WS connection with:
//   - auto-reconnect on close/error
//   - ping keepalive every 20s
//   - subscription on (re)connect
// -------------------------------------------------------
function createMexcWs(subscriptions, onMessage, label) {
  let ws, pingTimer, dead = false;

  function connect() {
    if (dead) return;
    ws = new WebSocket(MEXC_WS_URL);

    ws.on('open', () => {
      console.log(`✅ WS connected [${label}]`);

      // Subscribe to streams
      ws.send(JSON.stringify({ method: 'SUBSCRIPTION', params: subscriptions }));

      // MEXC keepalive — must ping every <30s or server drops connection
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'PING' }));
        }
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (raw) => {
      try {
        const text = raw.toString();

        // MEXC sometimes sends plain string "ping" — respond immediately
        if (text === 'ping') {
          if (ws.readyState === WebSocket.OPEN) ws.send('pong');
          return;
        }

        const msg = JSON.parse(text);

        // Respond to server-initiated JSON ping
        if (msg.method === 'PING' || msg.ping) {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ method: 'PONG' }));
          return;
        }

        // Ignore our own pong replies and subscription ACKs
        if (msg.method === 'PONG' || msg.msg === 'PONG' || msg.id !== undefined) return;

        onMessage(msg);
      } catch (e) {
        // ignore malformed frames
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(pingTimer);
      const why = reason?.toString() || 'no reason';
      console.warn(`⚠️  WS closed [${label}] code=${code} reason="${why}", reconnecting in 5s...`);
      if (!dead) setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
      console.error(`❌ WS error [${label}]:`, err.message);
      // 'close' fires after 'error' — let it handle reconnect
    });

    // TCP-level ping frame — respond with pong to keep socket alive
    ws.on('ping', () => { try { ws.pong(); } catch (_) {} });
  }

  connect();

  return {
    close() {
      dead = true;
      clearInterval(pingTimer);
      try { ws.terminate(); } catch (_) {}
    }
  };
}

// -------------------------------------------------------
// MATH / INDICATORS  (unchanged from original)
// -------------------------------------------------------
function calculateSeedEMAForPeriod(closes, period) {
  if (!closes || closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) ema = (closes[i] - ema) * k + ema;
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
    const d = closes[closes.length - i] - closes[closes.length - i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function findSwingHighLow(klines, lookback) {
  const s = klines.slice(-lookback);
  return {
    high: Math.max(...s.map(k => parseFloat(k[2]))),
    low:  Math.min(...s.map(k => parseFloat(k[3])))
  };
}

function fibonacciLevels(low, high) {
  const d = high - low;
  return {
    retracements: {
      '0.236': high - d * 0.236, '0.382': high - d * 0.382,
      '0.5':   high - d * 0.5,   '0.618': high - d * 0.618,
      '0.786': high - d * 0.786
    },
    extensions: {
      '1.272': high - d * 0.272, '1.414': high - d * 0.414,
      '1.618': high - d * 0.618
    }
  };
}

async function computeMultiTfFib(symbol) {
  const cached = fibCache.get(symbol);
  const now = Date.now();
  if (cached && now - cached.ts < 60_000) return cached.value;

  const tfs = [
    { interval: '1d', lookback: 30 }, { interval: '4h', lookback: 40 },
    { interval: '1h', lookback: 60 }, { interval: '15m', lookback: 60 },
    { interval: '5m', lookback: 40 }
  ];
  const results = {};
  for (const tf of tfs) {
    try {
      const klines = await fetchMexcKlines(symbol, tf.interval, tf.lookback);
      const { high, low } = findSwingHighLow(klines, tf.lookback);
      results[tf.interval] = { high, low, fib: fibonacciLevels(low, high), klines };
      klinesCache.set(`${symbol}_${tf.interval}`, { ts: now, klines });
    } catch (err) {
      console.error(`Fib fetch error ${symbol} ${tf.interval}:`, err.message);
    }
  }
  const preferred = results['1h'] || results['4h'] || results['15m'] || results['5m'] || results['1d'] || null;
  const value = { perTf: results, preferred };
  fibCache.set(symbol, { ts: now, value });
  return value;
}

function detectDoubleTop(klines, tol = 1.2, minSep = 3, maxSep = 30) {
  const highs = klines.map(k => parseFloat(k[2]));
  const peaks = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] >= highs[i-1] && highs[i] >= highs[i-2] && highs[i] >= highs[i+1] && highs[i] >= highs[i+2])
      peaks.push({ idx: i, price: highs[i] });
  }
  if (peaks.length < 2) return { isDoubleTop: false };
  const p2 = peaks[peaks.length - 1]; let p1 = null;
  for (let i = peaks.length - 2; i >= 0; i--) {
    const sep = p2.idx - peaks[i].idx;
    if (sep >= minSep && sep <= maxSep) { p1 = peaks[i]; break; }
  }
  if (!p1) return { isDoubleTop: false };
  const diffPct = Math.abs((p1.price - p2.price) / ((p1.price + p2.price) / 2)) * 100;
  if (diffPct > tol) return { isDoubleTop: false };
  const neckline  = Math.min(...klines.slice(p1.idx, p2.idx + 1).map(k => parseFloat(k[3])));
  const lastClose = parseFloat(klines[klines.length - 1][4]);
  return { isDoubleTop: true, peak1: p1, peak2: p2, neckline, necklineBroken: lastClose < neckline, diffPct };
}

function detectDoubleBottom(klines, tol = 1.2, minSep = 3, maxSep = 30) {
  const lows = klines.map(k => parseFloat(k[3]));
  const bottoms = [];
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] <= lows[i-1] && lows[i] <= lows[i-2] && lows[i] <= lows[i+1] && lows[i] <= lows[i+2])
      bottoms.push({ idx: i, price: lows[i] });
  }
  if (bottoms.length < 2) return { isDoubleBottom: false };
  const b2 = bottoms[bottoms.length - 1]; let b1 = null;
  for (let i = bottoms.length - 2; i >= 0; i--) {
    const sep = b2.idx - bottoms[i].idx;
    if (sep >= minSep && sep <= maxSep) { b1 = bottoms[i]; break; }
  }
  if (!b1) return { isDoubleBottom: false };
  const diffPct = Math.abs((b1.price - b2.price) / ((b1.price + b2.price) / 2)) * 100;
  if (diffPct > tol) return { isDoubleBottom: false };
  const neckline  = Math.max(...klines.slice(b1.idx, b2.idx + 1).map(k => parseFloat(k[2])));
  const lastClose = parseFloat(klines[klines.length - 1][4]);
  return { isDoubleBottom: true, bottom1: b1, bottom2: b2, neckline, necklineBroken: lastClose > neckline, diffPct };
}

function volumeSpikeConfirmed(klines, mult = 1.5, lookback = 20) {
  const vols   = klines.slice(-lookback).map(k => parseFloat(k[5]));
  const avg    = sma(vols.slice(0, vols.length - 1));
  const lastVol = parseFloat(klines[klines.length - 1][5]);
  return { confirmed: lastVol >= avg * mult, lastVol, avg };
}

function checkBearishDivergence(klines, rsiPeriod = 14, lookback = 40) {
  const closes = klines.map(k => parseFloat(k[4]));
  if (closes.length < lookback + rsiPeriod) return false;
  const slice = closes.slice(-lookback - rsiPeriod);
  const rsiSeries = [];
  for (let i = rsiPeriod; i < slice.length; i++)
    rsiSeries.push(computeRSI(slice.slice(i - rsiPeriod, i + 1), rsiPeriod));
  const highs = [];
  for (let i = 2; i < closes.length - 2; i++) {
    if (closes[i] >= closes[i-1] && closes[i] >= closes[i-2] && closes[i] >= closes[i+1] && closes[i] >= closes[i+2])
      highs.push({ idx: i, price: closes[i] });
  }
  if (highs.length < 2) return false;
  const h2 = highs[highs.length - 1]; let h1 = null;
  for (let i = highs.length - 2; i >= 0; i--) { if (h2.idx - highs[i].idx >= 3) { h1 = highs[i]; break; } }
  if (!h1) return false;
  const off = closes.length - slice.length;
  const rsiH1 = rsiSeries[h1.idx - off - rsiPeriod] ?? null;
  const rsiH2 = rsiSeries[h2.idx - off - rsiPeriod] ?? null;
  if (rsiH1 === null || rsiH2 === null) return false;
  return h2.price >= h1.price && rsiH2 < rsiH1;
}

function checkBullishDivergence(klines, rsiPeriod = 14, lookback = 40) {
  const closes = klines.map(k => parseFloat(k[4]));
  if (closes.length < lookback + rsiPeriod) return false;
  const slice = closes.slice(-lookback - rsiPeriod);
  const rsiSeries = [];
  for (let i = rsiPeriod; i < slice.length; i++)
    rsiSeries.push(computeRSI(slice.slice(i - rsiPeriod, i + 1), rsiPeriod));
  const lows = [];
  for (let i = 2; i < closes.length - 2; i++) {
    if (closes[i] <= closes[i-1] && closes[i] <= closes[i-2] && closes[i] <= closes[i+1] && closes[i] <= closes[i+2])
      lows.push({ idx: i, price: closes[i] });
  }
  if (lows.length < 2) return false;
  const l2 = lows[lows.length - 1]; let l1 = null;
  for (let i = lows.length - 2; i >= 0; i--) { if (l2.idx - lows[i].idx >= 3) { l1 = lows[i]; break; } }
  if (!l1) return false;
  const off = closes.length - slice.length;
  const rsiL1 = rsiSeries[l1.idx - off - rsiPeriod] ?? null;
  const rsiL2 = rsiSeries[l2.idx - off - rsiPeriod] ?? null;
  if (rsiL1 === null || rsiL2 === null) return false;
  return l2.price <= l1.price && rsiL2 > rsiL1;
}

async function multiTfConfluence(symbol) {
  const fibData = await computeMultiTfFib(symbol);
  const perTf   = fibData.perTf || {};
  const slope   = (klines) => {
    const c = klines.map(k => parseFloat(k[4]));
    return calculateSeedEMAForPeriod(c.slice(-30), 9) - calculateSeedEMAForPeriod(c.slice(-60), 21);
  };
  let bearish = false, bullish = false, reasons = [];
  if (perTf['1h']?.klines) { slope(perTf['1h'].klines) < 0 ? (bearish = true, reasons.push('1h EMA ↓')) : (bullish = true, reasons.push('1h EMA ↑')); }
  if (perTf['4h']?.klines) { slope(perTf['4h'].klines) < 0 ? (bearish = true, reasons.push('4h EMA ↓')) : (bullish = true, reasons.push('4h EMA ↑')); }
  return { bearish, bullish, reasons, fibData };
}

async function decideEntryAndRisk(symbol, currentPrice, ema9, highestPeak) {
  const fibData = await computeMultiTfFib(symbol);
  const pref    = fibData.preferred;
  if (!pref) {
    const r = highestPeak - currentPrice;
    return { entry: +currentPrice.toFixed(6), stopLoss: +highestPeak.toFixed(6), tp1: +(currentPrice - r).toFixed(6), tp2: +(currentPrice - r * 2).toFixed(6), fibData };
  }
  let entry = currentPrice;
  for (const lvl of ['0.382', '0.5', '0.618']) {
    const lp = pref.fib.retracements[lvl];
    if (!isNaN(lp) && currentPrice > lp) { entry = lp; break; }
  }
  if (currentPrice < ema9) entry = currentPrice;
  const r   = highestPeak - entry;
  const ext = Object.values(pref.fib.extensions).filter(v => !isNaN(v)).sort((a, b) => a - b);
  const ctp = (rr, fib) => fib < rr ? fib : rr;
  return {
    entry:    +entry.toFixed(6),
    stopLoss: +highestPeak.toFixed(6),
    tp1:      +ctp(entry - r, ext[0] || entry - r).toFixed(6),
    tp2:      +ctp(entry - r * 2, ext[1] || entry - r * 2).toFixed(6),
    fibData
  };
}

// -------------------------------------------------------
// TELEGRAM ALERTS  (unchanged)
// -------------------------------------------------------
async function sendTelegramAlert(coin) {
  const entry = coin.suggestedEntry ? `$${formatPrice(coin.suggestedEntry)}` : 'N/A';
  const sl    = coin.suggestedSL    ? `$${formatPrice(coin.suggestedSL)}`    : 'N/A';
  const msg = `
🚀 *MOONSHOT DETECTED* 🚀

*Asset:* ${coin.symbol.replace('USDT', '')} / USDT
*Price:* $${formatPrice(coin.price)}
*24h Change:* +${coin.change24h.toFixed(2)}%
*24h Volume:* $${formatCompact(coin.volume)}
*Confidence:* ${coin.confidence}%

*Suggested Short Entry:* ${entry}
*Suggested Stop Loss (Peak):* ${sl}

_Tracking 5m chart for trend breakdown (SHORT entry)..._

[Trade on MEXC](${tradeUrl(coin.symbol)})
`;
  try { await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
  catch (err) { console.error('❌ Telegram Error:', err.message); }
}

async function sendDumpAlert(coin) {
  const entry = coin.suggestedEntry ? `$${formatPrice(coin.suggestedEntry)}` : 'N/A';
  const sl    = coin.suggestedSL    ? `$${formatPrice(coin.suggestedSL)}`    : 'N/A';
  const msg = `
🔻 *DUMP DETECTED* 🔻

*Asset:* ${coin.symbol.replace('USDT', '')} / USDT
*Price:* $${formatPrice(coin.price)}
*24h Change:* ${coin.change24h.toFixed(2)}%
*24h Volume:* $${formatCompact(coin.volume)}
*Confidence:* ${coin.confidence}%

*Suggested Long Entry:* ${entry}
*Suggested Stop Loss (Valley):* ${sl}

_Tracking 5m chart for trend breakout (LONG entry)..._

[Trade on MEXC](${tradeUrl(coin.symbol)})
`;
  try { await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
  catch (err) { console.error('❌ Telegram Error:', err.message); }
}

async function sendShortEntryAlert(symbol, entryPrice, ema, stopLoss, tp1, tp2, confidence = 90) {
  const riskPct = (((stopLoss - entryPrice) / entryPrice) * 100).toFixed(2);
  const msg = `
🩸 *SHORT ENTRY TRIGGERED* 🩸
_Trend has broken below 5m 9-EMA!_

*Asset:* ${symbol.replace('USDT', '')} / USDT
*Entry Price:* $${formatPrice(entryPrice)}
*9 EMA Level:* $${formatPrice(ema)}

🛡️ *Stop Loss (Peak):* $${formatPrice(stopLoss)} (-${riskPct}%)
🎯 *Take Profit 1 (1:1):* $${formatPrice(tp1)}
🎯 *Take Profit 2 (1:2):* $${formatPrice(tp2)}
*Confidence:* ${confidence}%

[Trade on MEXC](${tradeUrl(symbol)})
`;
  try { await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
  catch (err) { console.error('❌ Telegram Error:', err.message); }
}

async function sendLongEntryAlert(symbol, entryPrice, ema, stopLoss, tp1, tp2, confidence = 90) {
  const riskPct = (((entryPrice - stopLoss) / entryPrice) * 100).toFixed(2);
  const msg = `
🟢 *LONG ENTRY TRIGGERED* 🟢
_Trend has broken above 5m 9-EMA!_

*Asset:* ${symbol.replace('USDT', '')} / USDT
*Entry Price:* $${formatPrice(entryPrice)}
*9 EMA Level:* $${formatPrice(ema)}

🛡️ *Stop Loss (Valley):* $${formatPrice(stopLoss)} (-${riskPct}%)
🎯 *Take Profit 1 (1:1):* $${formatPrice(tp1)}
🎯 *Take Profit 2 (1:2):* $${formatPrice(tp2)}
*Confidence:* ${confidence}%

[Trade on MEXC](${tradeUrl(symbol)})
`;
  try { await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
  catch (err) { console.error('❌ Telegram Error:', err.message); }
}

// -------------------------------------------------------
// SIGNAL LOGIC  (unchanged)
// -------------------------------------------------------
async function processSignals() {
  for (const t of Object.values(state.tickers)) {
    if (!t || t.high === t.low) continue;
    const rangePos   = (t.price - t.low) / (t.high - t.low);
    const isMoonshot = t.change24h > 12  && rangePos > 0.85;
    const isDump     = t.change24h < -12 && rangePos < 0.15;

    if (isMoonshot && !state.sentSignals.has(t.symbol)) {
      state.sentSignals.add(t.symbol);
      t.confidence = 85 + Math.floor(Math.random() * 10);
      try {
        const fib = await computeMultiTfFib(t.symbol);
        if (fib?.preferred) {
          t.suggestedEntry = fib.preferred.fib.retracements['0.382'] || fib.preferred.fib.retracements['0.5'] || null;
          t.suggestedSL    = fib.preferred.high || null;
        }
      } catch (e) { console.error('Fib error:', e.message); }
      await sendTelegramAlert(t);
      startEmaTrackerShort(t.symbol);
      setTimeout(() => state.sentSignals.delete(t.symbol), 60 * 60 * 1000);
      continue;
    }

    if (isDump && !state.sentSignals.has(t.symbol)) {
      state.sentSignals.add(t.symbol);
      t.confidence = 85 + Math.floor(Math.random() * 10);
      try {
        const fib = await computeMultiTfFib(t.symbol);
        if (fib?.preferred) {
          t.suggestedEntry = fib.preferred.fib.retracements['0.618'] || fib.preferred.fib.retracements['0.5'] || null;
          t.suggestedSL    = fib.preferred.low || null;
        }
      } catch (e) { console.error('Fib error:', e.message); }
      await sendDumpAlert(t);
      startEmaTrackerLong(t.symbol);
      setTimeout(() => state.sentSignals.delete(t.symbol), 60 * 60 * 1000);
      continue;
    }
  }
}

// -------------------------------------------------------
// WS TRACKER: SHORT
// Seeds EMA from REST, then uses a dedicated kline WS stream
// to get real-time candle updates — same logic as original Binance tracker.
// -------------------------------------------------------
async function startEmaTrackerShort(symbol) {
  if (activeTrackers.has(symbol)) return;
  activeTrackers.add(symbol);
  console.log(`👀 Starting SHORT WS Tracker for ${symbol}...`);

  let entrySignaled = false;
  const startTime = Date.now();

  try {
    // Seed EMA from REST (same as original)
    const initialKlines = await fetchMexcKlines(symbol, '5m', 200);
    const closes = initialKlines.map(k => parseFloat(k[4]));
    let currentEma       = calculateSeedEMAForPeriod(closes, 9);
    let highestPriceSeen = Math.max(...initialKlines.map(k => parseFloat(k[2])));

    const sub   = `spot@public.kline.v3.api@${symbol}@Min5`;
    let tracker = null;

    // Timeout cleanup
    const timeoutId = setTimeout(() => {
      if (!entrySignaled) {
        console.log(`⏱️ SHORT Tracker for ${symbol} timed out.`);
        entrySignaled = true;
        tracker?.close();
        activeTrackers.delete(symbol);
      }
    }, TRACKER_TIMEOUT_MS);

    tracker = createMexcWs([sub], async (msg) => {
      if (entrySignaled) return;

      // MEXC kline WS message structure:
      //  msg.d.k  →  { t, o, h, l, c, v, x (isClosed) }
      const k = msg?.d?.k;
      if (!k) return;

      const currentPrice = parseFloat(k.c);
      const highPrice    = parseFloat(k.h);
      const isClosed     = k.x === true;

      if (highPrice > highestPriceSeen) highestPriceSeen = highPrice;

      // Check breakdown threshold
      if (currentPrice < currentEma * 0.995) {
        entrySignaled = true;
        clearTimeout(timeoutId);
        tracker?.close();
        activeTrackers.delete(symbol);

        const tfConf     = await multiTfConfluence(symbol);
        const kl15       = klinesCache.get(`${symbol}_15m`)?.klines;
        const dt         = kl15 ? detectDoubleTop(kl15, 1.5, 3, 30)     : { isDoubleTop: false };
        const vol        = kl15 ? volumeSpikeConfirmed(kl15, 1.3, 20)   : { confirmed: false };
        const bearishDiv = kl15 ? checkBearishDivergence(kl15, 14, 40) : false;

        const higherBullish      = tfConf.bullish && !tfConf.bearish;
        const strongBearConf     = (dt.isDoubleTop && dt.necklineBroken && vol.confirmed) || bearishDiv || tfConf.bearish;

        if (!strongBearConf && higherBullish) {
          console.log(`⛔ Suppressed short for ${symbol}: higher-TF bullish`);
          return;
        }

        const decision = await decideEntryAndRisk(symbol, currentPrice, currentEma, highestPriceSeen);
        await sendShortEntryAlert(symbol, decision.entry, currentEma, decision.stopLoss, decision.tp1, decision.tp2, strongBearConf ? 92 : 70);
        return;
      }

      // Update EMA when candle closes
      if (isClosed) {
        currentEma = (currentPrice - currentEma) * (2 / (9 + 1)) + currentEma;
      }
    }, `SHORT:${symbol}`);

  } catch (err) {
    console.error(`❌ SHORT tracker init error ${symbol}:`, err.message);
    activeTrackers.delete(symbol);
  }
}

// -------------------------------------------------------
// WS TRACKER: LONG
// -------------------------------------------------------
async function startEmaTrackerLong(symbol) {
  if (activeTrackers.has(symbol)) return;
  activeTrackers.add(symbol);
  console.log(`👀 Starting LONG WS Tracker for ${symbol}...`);

  let entrySignaled = false;
  const startTime = Date.now();

  try {
    const initialKlines = await fetchMexcKlines(symbol, '5m', 200);
    const closes = initialKlines.map(k => parseFloat(k[4]));
    let currentEma      = calculateSeedEMAForPeriod(closes, 9);
    let lowestPriceSeen = Math.min(...initialKlines.map(k => parseFloat(k[3])));

    const sub   = `spot@public.kline.v3.api@${symbol}@Min5`;
    let tracker = null;

    const timeoutId = setTimeout(() => {
      if (!entrySignaled) {
        console.log(`⏱️ LONG Tracker for ${symbol} timed out.`);
        entrySignaled = true;
        tracker?.close();
        activeTrackers.delete(symbol);
      }
    }, TRACKER_TIMEOUT_MS);

    tracker = createMexcWs([sub], async (msg) => {
      if (entrySignaled) return;

      const k = msg?.d?.k;
      if (!k) return;

      const currentPrice = parseFloat(k.c);
      const lowPrice     = parseFloat(k.l);
      const isClosed     = k.x === true;

      if (lowPrice < lowestPriceSeen) lowestPriceSeen = lowPrice;

      if (currentPrice > currentEma * 1.005) {
        entrySignaled = true;
        clearTimeout(timeoutId);
        tracker?.close();
        activeTrackers.delete(symbol);

        const tfConf     = await multiTfConfluence(symbol);
        const kl15       = klinesCache.get(`${symbol}_15m`)?.klines;
        const db         = kl15 ? detectDoubleBottom(kl15, 1.5, 3, 30)   : { isDoubleBottom: false };
        const vol        = kl15 ? volumeSpikeConfirmed(kl15, 1.3, 20)    : { confirmed: false };
        const bullishDiv = kl15 ? checkBullishDivergence(kl15, 14, 40)  : false;

        const higherBearish  = tfConf.bearish && !tfConf.bullish;
        const strongBullConf = (db.isDoubleBottom && db.necklineBroken && vol.confirmed) || bullishDiv || tfConf.bullish;

        if (!strongBullConf && higherBearish) {
          console.log(`⛔ Suppressed long for ${symbol}: higher-TF bearish`);
          return;
        }

        const fibData = await computeMultiTfFib(symbol);
        const pref    = fibData.preferred;
        let suggestedEntry = currentPrice;
        if (pref?.fib?.retracements) {
          for (const lvl of ['0.618', '0.5', '0.382']) {
            const lp = pref.fib.retracements[lvl];
            if (!isNaN(lp) && currentPrice < lp) { suggestedEntry = lp; break; }
          }
        }
        if (currentPrice > currentEma) suggestedEntry = currentPrice;
        const risk = suggestedEntry - lowestPriceSeen;
        await sendLongEntryAlert(
          symbol, suggestedEntry, currentEma, lowestPriceSeen,
          +(suggestedEntry + risk).toFixed(6),
          +(suggestedEntry + risk * 2).toFixed(6),
          strongBullConf ? 92 : 70
        );
        return;
      }

      if (isClosed) {
        currentEma = (currentPrice - currentEma) * (2 / (9 + 1)) + currentEma;
      }
    }, `LONG:${symbol}`);

  } catch (err) {
    console.error(`❌ LONG tracker init error ${symbol}:`, err.message);
    activeTrackers.delete(symbol);
  }
}

// -------------------------------------------------------
// MAIN TICKER WS
// Subscribes to spot@public.miniTickers.v3.api
//
// MEXC miniTicker message structure:
//   msg.d.data → array of tickers with fields:
//     s  = symbol (e.g. "BTCUSDT")
//     p  = last price
//     h  = 24h high
//     l  = 24h low
//     q  = 24h quote volume (USDT)
//     r  = price change ratio as decimal (0.05 = +5%)
// -------------------------------------------------------
function initTickerWs() {
  createMexcWs(['spot@public.miniTickers.v3.api'], async (msg) => {
    const tickers = msg?.d?.data;
    if (!Array.isArray(tickers)) return;

    let updated = 0;
    for (const t of tickers) {
      if (!t.s || !t.s.endsWith('USDT')) continue;
      state.tickers[t.s] = {
        symbol:    t.s,
        price:     parseFloat(t.p),
        high:      parseFloat(t.h),
        low:       parseFloat(t.l),
        volume:    parseFloat(t.q),
        change24h: parseFloat(t.r) * 100   // decimal → percent
      };
      updated++;
    }

    if (updated > 0) await processSignals();
  }, 'TICKERS');
}

// -------------------------------------------------------
// STARTUP
// -------------------------------------------------------
(async () => {
  try {
    await bot.telegram.getMe();
    console.log('✅ Telegram connected');
  } catch (err) {
    console.error('❌ Telegram connection failed:', err.message);
  }

  initTickerWs();
  console.log('🚀 Nexus started — MEXC WebSocket (real-time, Railway-compatible)');
})();