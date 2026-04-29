import { scoreTradeQuality } from './trade-quality';
import { AUTOPILOT_CONFIDENCE_FLOOR } from './autopilot';

export interface MarketCandleLite {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SmartScalperSnapshot {
  symbol: string;
  price: number;
  timestamp: number;
  spreadPct: number;
  candles: {
    '1m': MarketCandleLite[];
    '3m': MarketCandleLite[];
    '5m': MarketCandleLite[];
  };
}

export interface SmartScalperInput {
  symbol: string;
  side: 'buy' | 'sell';
  signalPrice: number;
  notionalUSD: number;
  confidence: number;
  snapshot: SmartScalperSnapshot;
  cooldownActive: boolean;
  duplicateSignal: boolean;
  hasOpenPosition: boolean;
  hourlyTradesOnSymbol: number;
  maxTradesPerSymbolHour: number;
  weakSignalLoop: boolean;
  justOpenedAt?: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  positionEntryPrice?: number;
  symbolRulesMinNotional?: number;
  recentRejects?: number;
}

export interface ScalperCheckResult {
  pass: boolean;
  reason: string;
  confidence: number;
  diagnostics: {
    rsi: number;
    emaShortAbovePrice: boolean;
    emaTrendUp: boolean;
    volumeAboveAvg: boolean;
    spreadOk: boolean;
    volatilityOk: boolean;
    breakoutOk: boolean;
    momentumOk: boolean;
    duplicateSignal: boolean;
    cooldownActive: boolean;
  };
}

export const SCALPER_ALLOWED_SYMBOLS = ['BTC', 'SOL', 'XRP', 'LTC'] as const;
export const MIN_CASH_RESERVE_PCT = 30;

const EMA_SHORT = 9;
const EMA_LONG = 21;
const MAX_SPREAD_PCT = 0.2;
const MAX_VOLATILITY_PCT = 2.8;
const MAX_SPIKE_PCT = 1.8;
const RSI_BUY_MIN = 35;
const RSI_BUY_MAX = 68;
const RSI_SELL_OVERBOUGHT = 72;
const EARLY_EXIT_LOCK_MS = 90_000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) {
    out = values[i] * k + out * (1 - k);
  }
  return out;
}

function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function stdev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function pct(a: number, b: number): number {
  if (!(b > 0)) return 0;
  return (a / b) * 100;
}

export function evaluateScalperOpportunity(input: SmartScalperInput): ScalperCheckResult {
  const c1 = input.snapshot.candles['1m'] ?? [];
  const c3 = input.snapshot.candles['3m'] ?? [];
  const c5 = input.snapshot.candles['5m'] ?? [];
  const closes = c1.map(c => c.close);
  const volumes = c1.map(c => c.volume);
  const latest = c1[c1.length - 1];
  const prev = c1[c1.length - 2];
  const emaShort = ema(closes.slice(-Math.max(EMA_SHORT * 2, 30)), EMA_SHORT);
  const emaLong = ema(closes.slice(-Math.max(EMA_LONG * 2, 50)), EMA_LONG);
  const rsi14 = rsi(closes, 14);
  const avgVol = volumes.length > 0
    ? volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length)
    : 0;
  const currentVol = latest?.volume ?? 0;
  const spreadOk = input.snapshot.spreadPct <= MAX_SPREAD_PCT;
  const volSeries = c1.slice(-20).map(c => pct(Math.abs(c.close - c.open), c.open || 1));
  const volatility = stdev(volSeries);
  const volatilityOk = volatility <= MAX_VOLATILITY_PCT;
  const spikePct = latest && prev ? pct(Math.abs(latest.close - prev.close), prev.close || 1) : 0;
  const noSpike = spikePct <= MAX_SPIKE_PCT;
  const breakoutRef = c5.slice(-10).reduce((mx, c) => Math.max(mx, c.high), 0);
  const breakoutOk = (latest?.close ?? 0) >= breakoutRef * 0.9995;
  const momentumOk = c3.length >= 3
    ? c3[c3.length - 1]!.close >= c3[c3.length - 2]!.close && c3[c3.length - 2]!.close >= c3[c3.length - 3]!.close
    : true;
  const volumeAboveAvg = avgVol > 0 ? currentVol >= avgVol : false;
  const emaShortAbovePrice = (latest?.close ?? input.snapshot.price) >= emaShort;
  const emaTrendUp = emaShort > emaLong;

  const diag = {
    rsi: rsi14,
    emaShortAbovePrice,
    emaTrendUp,
    volumeAboveAvg,
    spreadOk,
    volatilityOk: volatilityOk && noSpike,
    breakoutOk,
    momentumOk,
    duplicateSignal: input.duplicateSignal,
    cooldownActive: input.cooldownActive,
  };

  if (input.duplicateSignal) return { pass: false, reason: 'duplicate_signal', confidence: input.confidence, diagnostics: diag };
  if (input.cooldownActive) return { pass: false, reason: 'cooldown_active', confidence: input.confidence, diagnostics: diag };
  if (input.weakSignalLoop) return { pass: false, reason: 'repeated_weak_signal', confidence: input.confidence, diagnostics: diag };
  if (input.hourlyTradesOnSymbol >= input.maxTradesPerSymbolHour) return { pass: false, reason: 'max_symbol_trades_per_hour', confidence: input.confidence, diagnostics: diag };
  if (!spreadOk) return { pass: false, reason: 'spread_too_high', confidence: input.confidence, diagnostics: diag };
  if (!volatilityOk || !noSpike) return { pass: false, reason: 'market_noisy_or_spike', confidence: input.confidence, diagnostics: diag };

  const quality = scoreTradeQuality({
    notional: input.notionalUSD,
    refPrice: input.signalPrice > 0 ? input.signalPrice : input.snapshot.price,
    signalAgeMs: Math.max(0, Date.now() - input.snapshot.timestamp),
    rules: input.symbolRulesMinNotional && input.symbolRulesMinNotional > 0
      ? { minNotional: input.symbolRulesMinNotional, minQty: 0, stepSize: 0.000001, tickSize: 0.000001 }
      : undefined,
    confidence: input.confidence,
    recentFails: input.recentRejects ?? 0,
    exchange: 'bybit',
  });
  if (!quality.pass) return { pass: false, reason: `low_trade_quality:${quality.reason}`, confidence: input.confidence, diagnostics: diag };

  if (input.side === 'buy') {
    if (input.hasOpenPosition) return { pass: false, reason: 'position_already_open', confidence: input.confidence, diagnostics: diag };
    if (input.confidence < Math.max(70, AUTOPILOT_CONFIDENCE_FLOOR)) return { pass: false, reason: 'confidence_weak', confidence: input.confidence, diagnostics: diag };
    if (!emaShortAbovePrice) return { pass: false, reason: 'ema_short_below_price', confidence: input.confidence, diagnostics: diag };
    if (!emaTrendUp) return { pass: false, reason: 'ema_trend_not_up', confidence: input.confidence, diagnostics: diag };
    if (!(rsi14 >= RSI_BUY_MIN && rsi14 <= RSI_BUY_MAX)) return { pass: false, reason: 'rsi_out_of_buy_band', confidence: input.confidence, diagnostics: diag };
    if (!volumeAboveAvg) return { pass: false, reason: 'volume_below_average', confidence: input.confidence, diagnostics: diag };
    if (!breakoutOk) return { pass: false, reason: 'no_breakout', confidence: input.confidence, diagnostics: diag };
    if (!momentumOk) return { pass: false, reason: 'momentum_not_confirmed', confidence: input.confidence, diagnostics: diag };
    return { pass: true, reason: 'buy_setup_confirmed', confidence: clamp(input.confidence, 0, 100), diagnostics: diag };
  }

  const entry = input.positionEntryPrice ?? input.signalPrice;
  const px = input.snapshot.price > 0 ? input.snapshot.price : input.signalPrice;
  const upPct = entry > 0 ? pct(px - entry, entry) : 0;
  const downPct = entry > 0 ? pct(entry - px, entry) : 0;
  const trailingTrigger = upPct >= input.takeProfitPct * 0.5 && downPct >= input.trailingStopPct;
  const emaReversal = emaShort < emaLong;
  const momentumWeak = !momentumOk;
  const rsiOverboughtWeak = rsi14 >= RSI_SELL_OVERBOUGHT && momentumWeak;
  const stopLossHit = downPct >= input.stopLossPct;
  const takeProfitHit = upPct >= input.takeProfitPct;
  const emergencyExit = !spreadOk || (!volatilityOk && downPct > 0);

  if ((Date.now() - (input.justOpenedAt ?? 0) < EARLY_EXIT_LOCK_MS) && !stopLossHit && !emergencyExit) {
    return { pass: false, reason: 'early_exit_locked', confidence: input.confidence, diagnostics: diag };
  }
  if (takeProfitHit || stopLossHit || trailingTrigger || rsiOverboughtWeak || emaReversal || emergencyExit) {
    return { pass: true, reason: 'sell_exit_confirmed', confidence: clamp(input.confidence, 0, 100), diagnostics: diag };
  }
  return { pass: false, reason: 'no_sell_exit_signal', confidence: input.confidence, diagnostics: diag };
}

export function evaluateSmartScalperEntry(input: SmartScalperInput): ScalperCheckResult {
  return evaluateScalperOpportunity({ ...input, side: 'buy' });
}

export function evaluateSmartScalperSell(input: SmartScalperInput): ScalperCheckResult {
  return evaluateScalperOpportunity({ ...input, side: 'sell' });
}
