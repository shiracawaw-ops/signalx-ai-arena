// ─── Risk Manager ─────────────────────────────────────────────────────────────
// Validates a proposed order against all risk rules before execution.
// Returns { ok: true } or { ok: false, reason: RejectReason, detail: string }

import type { TradeConfig } from './trade-config.js';
import { REJECT, type RejectReason } from './execution-log.js';

export interface SymbolRules {
  symbol:        string;
  minQty:        number;
  maxQty:        number;
  stepSize:      number;
  minNotional:   number;
  tickSize:      number;
}

export interface RiskInput {
  exchange:     string;
  symbol:       string;
  side:         'buy' | 'sell';
  price:        number;        // current market price
  amountUSD:    number;        // requested trade value in USD
  availableUSD: number;        // available balance in quote currency
  openPositions: number;       // current number of open positions
  dailyTradeCount: number;     // trades placed today
  lastTradeTs:  number;        // timestamp of last trade (ms)
  signalId:     string;
  recentSignals: string[];     // last N signal IDs to detect duplicates
  symbolRules:  SymbolRules;
  config:       TradeConfig;
}

export interface RiskResult {
  ok:        boolean;
  reason?:   RejectReason;
  detail?:   string;
  quantity?: number;  // computed quantity if ok
  price?:    number;  // rounded price if ok
}

/** Round a number to a given step size */
export function roundToStep(value: number, step: number): number {
  if (!step || step <= 0) return value;
  const precision = Math.round(-Math.log10(step));
  return parseFloat((Math.floor(value / step) * step).toFixed(Math.max(0, precision)));
}

/** Round a price to tick size */
export function roundToTick(price: number, tick: number): number {
  return roundToStep(price, tick);
}

export function validateRisk(input: RiskInput): RiskResult {
  const { config, symbolRules, price, amountUSD, availableUSD, openPositions, dailyTradeCount, lastTradeTs, signalId, recentSignals, symbol, side } = input;

  // Emergency stop
  if (config.emergencyStop) {
    return { ok: false, reason: REJECT.EMERGENCY_STOP, detail: 'Emergency stop is active — all trading halted.' };
  }

  // Allowed symbols check
  if (config.allowedSymbols.length > 0) {
    const base = symbol.replace(/USDT$|USD$|-USDT$|-USD$/i, '').toUpperCase();
    const allowed = config.allowedSymbols.map(s => s.toUpperCase());
    if (!allowed.includes(base) && !allowed.includes(symbol.toUpperCase())) {
      return { ok: false, reason: REJECT.SYMBOL_BLOCKED, detail: `Symbol ${symbol} is not in the allowed list: ${config.allowedSymbols.join(', ')}` };
    }
  }

  // Only-long mode
  if (config.onlyLong && side === 'sell') {
    return { ok: false, reason: REJECT.SYMBOL_BLOCKED, detail: 'Only-long mode is active — sell orders are blocked.' };
  }

  // Max open positions
  if (config.maxOpenPositions > 0 && openPositions >= config.maxOpenPositions) {
    return { ok: false, reason: REJECT.MAX_POSITIONS, detail: `Max open positions (${config.maxOpenPositions}) reached. Current: ${openPositions}` };
  }

  // Max daily trades
  if (config.maxDailyTrades > 0 && dailyTradeCount >= config.maxDailyTrades) {
    return { ok: false, reason: REJECT.MAX_DAILY_TRADES, detail: `Max daily trades (${config.maxDailyTrades}) reached. Today: ${dailyTradeCount}` };
  }

  // Cooldown check
  const elapsed = Date.now() - lastTradeTs;
  if (lastTradeTs > 0 && elapsed < config.cooldownSeconds * 1000) {
    const remaining = Math.ceil((config.cooldownSeconds * 1000 - elapsed) / 1000);
    return { ok: false, reason: REJECT.COOLDOWN_ACTIVE, detail: `Cooldown active — ${remaining}s remaining.` };
  }

  // Duplicate signal
  if (recentSignals.includes(signalId)) {
    return { ok: false, reason: REJECT.DUPLICATE_SIGNAL, detail: `Signal ${signalId} was already processed.` };
  }

  // Price sanity
  if (!price || price <= 0) {
    return { ok: false, reason: REJECT.PRICE_UNAVAILABLE, detail: 'Cannot determine current price.' };
  }

  // Compute raw quantity from USD amount
  const rawQty = amountUSD / price;

  // Check step size
  const quantity = roundToStep(rawQty, symbolRules.stepSize);

  if (quantity <= 0) {
    return { ok: false, reason: REJECT.INVALID_ORDER_SIZE, detail: `Computed quantity ${quantity} is invalid.` };
  }

  // Min / max quantity
  if (quantity < symbolRules.minQty) {
    return { ok: false, reason: REJECT.INVALID_ORDER_SIZE, detail: `Quantity ${quantity} < min ${symbolRules.minQty} for ${symbol}.` };
  }
  if (symbolRules.maxQty > 0 && quantity > symbolRules.maxQty) {
    return { ok: false, reason: REJECT.INVALID_ORDER_SIZE, detail: `Quantity ${quantity} > max ${symbolRules.maxQty} for ${symbol}.` };
  }

  // Min notional
  const notional = quantity * price;
  if (symbolRules.minNotional > 0 && notional < symbolRules.minNotional) {
    return { ok: false, reason: REJECT.BELOW_MIN_NOTIONAL, detail: `Order value $${notional.toFixed(2)} < min notional $${symbolRules.minNotional} for ${symbol}.` };
  }

  // Balance check — require 1.01× to account for fees
  if (side === 'buy' && availableUSD < notional * 1.01) {
    return { ok: false, reason: REJECT.INSUFFICIENT_BALANCE, detail: `Insufficient balance: need $${(notional * 1.01).toFixed(2)}, have $${availableUSD.toFixed(2)}.` };
  }

  return { ok: true, quantity, price: roundToTick(price, symbolRules.tickSize) };
}
