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
  baseCurrency?:  string;          // e.g. "ADA" for ADAUSDT
  quoteCurrency?: string;          // e.g. "USDT" for ADAUSDT
  baseAssetPrecision?:  number;
  pricePrecision?:      number;
  status?:              string;     // "TRADING" / "BREAK" / …
  isSpotTradingAllowed?: boolean;
  filterSource?:        'live' | 'cached' | 'stub';
}

export interface RiskInput {
  exchange:     string;
  symbol:       string;
  side:         'buy' | 'sell';
  price:        number;        // current market price
  amountUSD:    number;        // requested trade value in USD
  // Side-aware free balances. Engine MUST populate both whenever known so
  // the manager can enforce SELL against the base asset (e.g. ADA holdings)
  // and BUY against the quote asset (USDT). availableUSD remains for
  // backwards compatibility — defaults to availableQuote when unset.
  availableQuote?: number;     // free quote (USDT/USDC/USD) available
  availableBase?:  number;     // free base asset available (used for SELL)
  availableUSD?:   number;     // legacy alias for availableQuote
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
  // Diagnostic fields written to the execution log so the operator can
  // see EXACTLY why an order passed or failed risk without having to
  // re-derive the math from the toast text.
  computedQty?:   number;     // raw qty before stepSize rounding
  finalQty?:      number;     // final qty after stepSize rounding
  notional?:      number;     // qty × price
  freeBalance?:   number;     // balance considered (base for SELL, quote for BUY)
  freeAsset?:     string;     // asset of `freeBalance`
  stepSize?:      number;
  minNotional?:   number;
  filterSource?:  string;
}

/**
 * Strip any common USD-stable suffix (USDT/USDC/USD/BUSD/USDE) from a
 * symbol and return just the base ticker. Used by the allowed-symbols
 * gate so `BTC` in the user's whitelist matches a `BTCUSDT` (or `BTC-USD`,
 * `BTCUSDC`, …) signal coming from the connected exchange, regardless of
 * which platform's quote convention is in play.
 */
export function baseTicker(symbol: string): string {
  return String(symbol ?? '')
    .toUpperCase()
    .replace(/[-_/]?(USDT|USDC|USDE|BUSD|USD)$/u, '');
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
  const { config, symbolRules, price, amountUSD, openPositions, dailyTradeCount, lastTradeTs, signalId, recentSignals, symbol, side } = input;
  // Side-aware balance resolution. Engine populates availableQuote (USDT)
  // and availableBase (the base asset for the pair).  Falls back to legacy
  // availableUSD when only one number is known.
  const availableQuote = input.availableQuote ?? input.availableUSD ?? 0;
  const availableBase  = input.availableBase  ?? 0;

  // Emergency stop
  if (config.emergencyStop) {
    return { ok: false, reason: REJECT.EMERGENCY_STOP, detail: 'Emergency stop is active — all trading halted.' };
  }

  // Allowed symbols check.
  //
  // Empty list = allow ALL supported crypto on the connected exchange. The
  // exchange itself is the source of truth: the bot/autopilot bridge already
  // rejects non-crypto (stocks/forex/metals) with `unsupported_asset_class`,
  // and the exchange adapter rejects unknown tickers via `getSymbolRules` /
  // `placeOrder` errors when we forward them. We therefore only run this
  // gate when the user has explicitly typed a comma-separated whitelist.
  //
  // Custom list = match by base ticker, tolerant of any common USD-stable
  // suffix on either side. This prevents false `symbol_blocked` rejections
  // when the user types `BTC` but the signal carries `BTCUSDT`, or vice
  // versa, and works the same in real, testnet and paper modes.
  if (config.allowedSymbols.length > 0) {
    const sigBase   = baseTicker(symbol);
    const allowed   = config.allowedSymbols.map(baseTicker);
    if (!allowed.includes(sigBase)) {
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
  const computedQty = amountUSD / price;

  // Check step size — round DOWN to nearest valid step
  const quantity = roundToStep(computedQty, symbolRules.stepSize);
  const notional = quantity * price;
  const baseAsset  = symbolRules.baseCurrency  ?? baseTicker(symbol);
  const quoteAsset = symbolRules.quoteCurrency ?? 'USDT';

  // Diagnostic snapshot included on every result so the UI can show the
  // exact math behind a pass/reject — independent of which guard tripped.
  const diag = {
    computedQty, finalQty: quantity, notional,
    stepSize: symbolRules.stepSize, minNotional: symbolRules.minNotional,
    filterSource: symbolRules.filterSource,
  };

  if (quantity <= 0) {
    return { ok: false, reason: REJECT.INVALID_ORDER_SIZE,
      detail: `Computed quantity ${computedQty.toPrecision(6)} rounded to ZERO at stepSize ${symbolRules.stepSize}. Increase trade amount.`,
      ...diag, freeBalance: availableQuote, freeAsset: quoteAsset };
  }

  // Min / max quantity
  if (quantity < symbolRules.minQty) {
    return { ok: false, reason: REJECT.INVALID_ORDER_SIZE,
      detail: `Quantity ${quantity} < minQty ${symbolRules.minQty} for ${symbol}. (Increase tradeAmountUSD or pick a higher-priced asset.)`,
      ...diag };
  }
  if (symbolRules.maxQty > 0 && quantity > symbolRules.maxQty) {
    return { ok: false, reason: REJECT.INVALID_ORDER_SIZE,
      detail: `Quantity ${quantity} > maxQty ${symbolRules.maxQty} for ${symbol}.`,
      ...diag };
  }

  // Min notional
  if (symbolRules.minNotional > 0 && notional < symbolRules.minNotional) {
    return { ok: false, reason: REJECT.BELOW_MIN_NOTIONAL,
      detail: `Order value $${notional.toFixed(2)} < minNotional $${symbolRules.minNotional} for ${symbol}. Increase tradeAmountUSD to at least $${(symbolRules.minNotional * 1.05).toFixed(2)}.`,
      ...diag };
  }

  // ── Balance check — side aware ────────────────────────────────────────────
  // BUY:  need free QUOTE (USDT) for notional × 1.01 (fee buffer).
  // SELL: need free BASE asset >= quantity (fees deducted from quote on sell).
  if (side === 'buy') {
    if (availableQuote < notional * 1.01) {
      return { ok: false, reason: REJECT.INSUFFICIENT_BALANCE,
        detail: `Insufficient ${quoteAsset}: need $${(notional * 1.01).toFixed(2)} (incl. fees), have $${availableQuote.toFixed(2)}.`,
        ...diag, freeBalance: availableQuote, freeAsset: quoteAsset };
    }
  } else {
    // SELL — must own the base asset on the exchange.
    if (availableBase <= 0) {
      return { ok: false, reason: REJECT.INSUFFICIENT_BALANCE,
        detail: `No ${baseAsset} balance to SELL on this exchange (free=${availableBase}). Buy ${baseAsset} first or transfer it to spot.`,
        ...diag, freeBalance: availableBase, freeAsset: baseAsset };
    }
    if (availableBase < quantity) {
      return { ok: false, reason: REJECT.INSUFFICIENT_BALANCE,
        detail: `Insufficient ${baseAsset}: need ${quantity}, have ${availableBase}. Reduce tradeAmountUSD or top up.`,
        ...diag, freeBalance: availableBase, freeAsset: baseAsset };
    }
  }

  return {
    ok: true, quantity, price: roundToTick(price, symbolRules.tickSize),
    ...diag,
    freeBalance: side === 'buy' ? availableQuote : availableBase,
    freeAsset:   side === 'buy' ? quoteAsset    : baseAsset,
  };
}
