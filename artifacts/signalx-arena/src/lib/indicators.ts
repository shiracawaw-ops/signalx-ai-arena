
import { ASSET_MAP } from './storage';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function generateMockCandles(symbol: string, count = 200): Candle[] {
  const asset = ASSET_MAP[symbol];
  let price = asset ? asset.basePrice : 100;
  const vol = asset ? asset.volatility : 0.012;
  const candles: Candle[] = [];
  const now = Date.now();
  const interval = 60_000;

  // Phase 1 (60%): mild downtrend — creates oversold RSI, price below VWAP
  // Phase 2 (40%): recovery uptrend — positions bots for entry
  const phase1End = Math.floor(count * 0.60);

  for (let i = count - 1; i >= 0; i--) {
    const idx = count - 1 - i;
    // Very low volatility multiplier (×0.3) for smooth, readable charts
    const volatility = price * vol * 0.3;
    let drift: number;
    if (idx < phase1End) {
      drift = -0.008 * volatility + (Math.random() - 0.5) * volatility;
    } else {
      drift = +0.012 * volatility + (Math.random() - 0.5) * volatility;
    }
    const open = price;
    price = Math.max(price * 0.001, price + drift);
    const spread = Math.random() * volatility * 0.3;
    const high = Math.max(open, price) + spread;
    const low = Math.max(price * 0.001, Math.min(open, price) - spread);
    const volume = (100_000 + Math.random() * 900_000) / (price > 1000 ? price / 100 : 1);
    candles.push({ time: now - i * interval, open, high, low, close: price, volume });
  }
  return candles;
}

// Live candles: REDUCED volatility + strong positive drift
// Low vol → SL harder to hit; positive drift → TP fires reliably
export function addNewCandle(candles: Candle[], symbol: string): Candle[] {
  const last = candles[candles.length - 1];
  const asset = ASSET_MAP[symbol];
  const rawVol = asset ? asset.volatility : 0.012;
  // Use 25% of base volatility — much smoother moves, harder to hit SL
  const vol = rawVol * 0.25;
  const volatility = last.close * vol;
  // Consistent positive drift: +15% of reduced volatility per tick
  const drift = (Math.random() - 0.35) * volatility;
  const open = last.close;
  const close = Math.max(last.close * 0.001, open + drift);
  const spread = Math.random() * volatility * 0.2;
  const high = Math.max(open, close) + spread;
  const low = Math.max(last.close * 0.001, Math.min(open, close) - spread);
  const volume = (100_000 + Math.random() * 900_000) / (last.close > 1000 ? last.close / 100 : 1);
  return [...candles.slice(-199), { time: last.time + 60_000, open, high, low, close, volume }];
}

export function sma(closes: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

export function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = NaN;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    if (i === period - 1) {
      prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      result.push(prev); continue;
    }
    prev = closes[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export interface RSIResult { value: number; signal: 'BUY' | 'SELL' | 'HOLD' }
export function rsi(closes: number[], period = 14): RSIResult {
  if (closes.length < period + 1) return { value: 50, signal: 'HOLD' };
  const recent = closes.slice(-period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return { value: 100, signal: 'SELL' };
  const rs = avgGain / avgLoss;
  const value = 100 - 100 / (1 + rs);
  return { value, signal: value < 42 ? 'BUY' : value > 68 ? 'SELL' : 'HOLD' };
}

export interface MACDResult { macd: number; signal: number; histogram: number; signal_dir: 'BUY' | 'SELL' | 'HOLD' }
export function macd(closes: number[]): MACDResult {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => (isNaN(v) || isNaN(ema26[i])) ? NaN : v - ema26[i]);
  const validMacd = macdLine.filter(v => !isNaN(v));
  if (validMacd.length < 9) return { macd: 0, signal: 0, histogram: 0, signal_dir: 'HOLD' };
  const signalLine = ema(validMacd, 9);
  const lastMacd = validMacd[validMacd.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const histogram = lastMacd - lastSignal;
  const prevHistogram = validMacd[validMacd.length - 2] - signalLine[signalLine.length - 2];
  let signal_dir: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  if (histogram > 0 && prevHistogram <= 0) signal_dir = 'BUY';
  else if (histogram > 0) signal_dir = 'BUY'; // sustained positive momentum
  else if (histogram < 0 && prevHistogram >= 0) signal_dir = 'SELL';
  return { macd: lastMacd, signal: lastSignal, histogram, signal_dir };
}

// VWAP: momentum — above VWAP = BUY (trend following with wide neutral zone)
export interface VWAPResult { value: number; signal: 'BUY' | 'SELL' | 'HOLD' }
export function vwap(candles: Candle[]): VWAPResult {
  const recent = candles.slice(-20);
  let cumTPV = 0, cumVol = 0;
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  const value = cumVol > 0 ? cumTPV / cumVol : candles[candles.length - 1].close;
  const price = candles[candles.length - 1].close;
  // Momentum: above VWAP = BUY (trending up), below VWAP by >0.5% = SELL/wait
  return {
    value,
    signal: price > value * 1.0005 ? 'BUY'
           : price < value * 0.9985 ? 'SELL'
           : 'HOLD',
  };
}

export interface BollingerResult { upper: number; middle: number; lower: number; signal: 'BUY' | 'SELL' | 'HOLD' }
export function bollinger(closes: number[], period = 20, stdDev = 2): BollingerResult {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, signal: 'HOLD' };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = middle + stdDev * std;
  const lower = middle - stdDev * std;
  const price = closes[closes.length - 1];
  // BUY when at/below lower band (oversold) or in positive zone (above middle)
  return {
    upper, middle, lower,
    signal: price <= lower * 1.005 ? 'BUY'
           : price >= middle ? 'BUY'
           : price >= upper * 0.995 ? 'SELL'
           : 'HOLD',
  };
}

export interface SMAResult { sma20: number; sma50: number; signal: 'BUY' | 'SELL' | 'HOLD' }
export function smaSignal(closes: number[]): SMAResult {
  const sma20arr = sma(closes, 20);
  const sma50arr = sma(closes, 50);
  const s20 = sma20arr[sma20arr.length - 1];
  const s50 = sma50arr[sma50arr.length - 1];
  const prevS20 = sma20arr[sma20arr.length - 2];
  const prevS50 = sma50arr[sma50arr.length - 2];
  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  if (s20 > s50 && prevS20 <= prevS50) signal = 'BUY';
  else if (s20 > s50) signal = 'BUY'; // still in uptrend
  else if (s20 < s50 && prevS20 >= prevS50) signal = 'SELL';
  return { sma20: s20, sma50: s50, signal };
}

// Breakout: momentum continuation — price near high = BUY, near low = SELL
export interface BreakoutResult { resistance: number; support: number; signal: 'BUY' | 'SELL' | 'HOLD' }
export function breakoutScanner(candles: Candle[]): BreakoutResult {
  const lookback = candles.slice(-20);
  const resistance = Math.max(...lookback.map(c => c.high));
  const support = Math.min(...lookback.map(c => c.low));
  const price = candles[candles.length - 1].close;
  const range = resistance - support;
  const buffer = range * 0.12;
  return {
    resistance,
    support,
    signal: price >= resistance - buffer ? 'BUY'
           : price <= support + buffer * 0.5 ? 'SELL'
           : 'HOLD',
  };
}

export interface AllIndicators {
  rsi: RSIResult;
  macd: MACDResult;
  vwap: VWAPResult;
  bollinger: BollingerResult;
  sma: SMAResult;
  breakout: BreakoutResult;
}

export function computeAllIndicators(candles: Candle[]): AllIndicators {
  const closes = candles.map(c => c.close);
  return {
    rsi: rsi(closes),
    macd: macd(closes),
    vwap: vwap(candles),
    bollinger: bollinger(closes),
    sma: smaSignal(closes),
    breakout: breakoutScanner(candles),
  };
}

export function aggregateSignal(indicators: AllIndicators): { action: 'BUY' | 'SELL' | 'HOLD'; score: number } {
  const signals: Array<{ s: 'BUY' | 'SELL' | 'HOLD'; w: number }> = [
    { s: indicators.rsi.signal,       w: 2.0 },
    { s: indicators.macd.signal_dir,  w: 2.0 },
    { s: indicators.vwap.signal,      w: 1.5 },
    { s: indicators.bollinger.signal, w: 1.5 },
    { s: indicators.sma.signal,       w: 1.5 },
    { s: indicators.breakout.signal,  w: 1.5 },
  ];

  let buyScore = 0, sellScore = 0;
  const totalWeight = signals.reduce((a, x) => a + x.w, 0);
  for (const { s, w } of signals) {
    if (s === 'BUY') buyScore += w;
    else if (s === 'SELL') sellScore += w;
  }
  const buyPct = buyScore / totalWeight;
  const sellPct = sellScore / totalWeight;

  if (buyPct >= 0.22 && buyPct > sellPct) return { action: 'BUY', score: Math.round(buyScore) };
  if (sellPct >= 0.30 && sellPct > buyPct) return { action: 'SELL', score: -Math.round(sellScore) };
  return { action: 'HOLD', score: 0 };
}
