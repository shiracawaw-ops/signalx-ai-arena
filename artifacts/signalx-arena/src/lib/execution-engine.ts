// ─── Unified Trading Execution Engine ─────────────────────────────────────────
// Signal → Validation → Risk → API → Log
//
// DEMO:    logs only, zero real orders, no API keys.
// PAPER:   logs as paper trade, no real orders, real price feed used.
// TESTNET: validates & places orders on exchange sandbox endpoint (x-testnet: 1).
// REAL:    full validation + risk checks, places live orders on production exchange.

import { exchangeMode }    from './exchange-mode.js';
import type { ExchangeCredentials } from './exchange-mode.js';
import { tradeConfig }     from './trade-config.js';
import { executionLog, REJECT } from './execution-log.js';
import { apiClient, isBackendReachable } from './api-client.js';
import { validateRisk }    from './risk-manager.js';
import type { SymbolRules as RiskSymbolRules } from './risk-manager.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Signal {
  id:       string;
  symbol:   string;
  side:     'buy' | 'sell';
  price:    number;         // current price at signal time
  ts:       number;
  source?:  string;         // e.g. "autopilot", "manual"
}

export interface EngineResult {
  ok:          boolean;
  orderId?:    string;
  logId?:      string;
  rejectReason?: string;
  detail?:     string;
  demo?:       boolean;
}

// ── State ──────────────────────────────────────────────────────────────────────

let credentials: ExchangeCredentials | null = null;
let recentSignals: string[]  = [];
let dailyTradeCount          = 0;
let dailyResetDate           = new Date().toDateString();
let lastTradeTs              = 0;
let openPositionCount        = 0;

// Per-session credential injection (called from exchange.tsx after connect)
export function setCredentials(creds: ExchangeCredentials | null) {
  credentials = creds;
}

export function setOpenPositionCount(n: number) { openPositionCount = n; }

function resetDailyCounterIfNeeded() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyTradeCount = 0;
    dailyResetDate  = today;
  }
}

// ── Pre-order safety guards ────────────────────────────────────────────────────

const STALE_PRICE_MS = 30_000; // 30 seconds

function isPriceStale(signal: Signal): boolean {
  return Date.now() - signal.ts > STALE_PRICE_MS;
}

function isValidSide(side: string): side is 'buy' | 'sell' {
  return side === 'buy' || side === 'sell';
}

// ── Main execute function ──────────────────────────────────────────────────────

export async function executeSignal(signal: Signal): Promise<EngineResult> {
  resetDailyCounterIfNeeded();

  const modeState = exchangeMode.get();
  const exchange  = modeState.exchange;
  const config    = tradeConfig.get(exchange);
  const mode      = modeState.mode;

  // ── Universal pre-flight guards (all modes) ───────────────────────────────

  // Duplicate signal guard — prevent same signal ID being processed twice in-session
  if (recentSignals.includes(signal.id)) {
    return reject(signal, exchange, mode, REJECT.DUPLICATE_SIGNAL, `Signal "${signal.id}" already processed this session.`);
  }

  // Invalid side guard
  if (!isValidSide(signal.side)) {
    return reject(signal, exchange, mode, REJECT.INVALID_SIDE, `Invalid order side: "${signal.side}". Must be "buy" or "sell".`);
  }

  // Stale price guard
  if (isPriceStale(signal)) {
    const ageS = ((Date.now() - signal.ts) / 1000).toFixed(1);
    return reject(signal, exchange, mode, REJECT.STALE_PRICE, `Signal price is ${ageS}s old (limit: ${STALE_PRICE_MS / 1000}s). Refusing to execute.`);
  }

  // ── DEMO MODE ─────────────────────────────────────────────────────────────
  if (mode === 'demo') {
    const logEntry = executionLog.add({
      mode:      'demo',
      exchange,
      symbol:    signal.symbol,
      side:      signal.side,
      orderType: config.orderType,
      quantity:  config.tradeAmountUSD / signal.price,
      price:     signal.price,
      amountUSD: config.tradeAmountUSD,
      status:    'executed',
      orderId:   `demo_${Date.now()}`,
      signalId:  signal.id,
    });
    recentSignals = [signal.id, ...recentSignals].slice(0, 100);
    console.log(`[engine][demo] Signal executed (no real order): ${signal.side} ${signal.symbol} @ $${signal.price}`);
    return { ok: true, orderId: logEntry.orderId, logId: logEntry.id, demo: true };
  }

  // ── PAPER MODE ────────────────────────────────────────────────────────────
  // Simulated fill at live market price — no order sent to exchange.
  if (mode === 'paper') {
    let fillPrice = signal.price;
    try {
      const priceRes = await apiClient.getPrice(exchange, signal.symbol);
      if (priceRes.ok && (priceRes.data as { price: number }).price > 0) {
        fillPrice = (priceRes.data as { price: number }).price;
        console.log(`[engine][paper] Live price fetched for ${signal.symbol}: $${fillPrice}`);
      }
    } catch {
      console.warn(`[engine][paper] Could not fetch live price, using signal price $${signal.price}`);
    }
    const qty = config.tradeAmountUSD / fillPrice;
    const logEntry = executionLog.add({
      mode:      'paper',
      exchange,
      symbol:    signal.symbol,
      side:      signal.side,
      orderType: config.orderType,
      quantity:  qty,
      price:     fillPrice,
      amountUSD: config.tradeAmountUSD,
      status:    'executed',
      orderId:   `paper_${Date.now()}`,
      signalId:  signal.id,
    });
    recentSignals = [signal.id, ...recentSignals].slice(0, 100);
    console.log(`[engine][paper] Paper trade logged (no real order): ${signal.side} ${signal.symbol} @ $${fillPrice}`);
    return { ok: true, orderId: logEntry.orderId, logId: logEntry.id, demo: true };
  }

  // ── TESTNET + REAL MODE — Pre-execution safety checks ─────────────────────

  // 1. Must be testnet or real
  if (mode !== 'testnet' && mode !== 'real') {
    return reject(signal, exchange, mode, REJECT.LIVE_DISABLED, `Mode "${mode}" does not support live execution.`);
  }

  // 2. Trading Armed (required for real; testnet is also gated by arm for safety)
  if (!modeState.armed) {
    return reject(signal, exchange, mode, REJECT.BOT_NOT_ARMED, 'Trading is not armed. Enable "Trading Armed" in Live Status tab.');
  }

  // 3. API validated
  if (!modeState.apiValidated) {
    return reject(signal, exchange, mode, REJECT.ADAPTER_NOT_READY, 'API not validated. Connect and validate credentials first.');
  }

  // 4. Trade permission
  if (!modeState.permissions.trade) {
    return reject(signal, exchange, mode, REJECT.NO_TRADE_PERMISSION, 'API key does not have trade permission on this exchange.');
  }

  // 5. Credentials injected
  if (!credentials) {
    return reject(signal, exchange, mode, REJECT.MISSING_CREDENTIALS, 'Credentials not provided to engine. Reconnect.');
  }

  // 5b. Backend reachability — fall back gracefully if API server is down
  const backendUp = await isBackendReachable().catch(() => false);
  if (!backendUp) {
    console.warn('[engine] Backend unreachable — cannot execute signal');
    const fallbackEntry = executionLog.add({
      mode,
      exchange,
      symbol:       signal.symbol,
      side:         signal.side,
      orderType:    config.orderType,
      quantity:     config.tradeAmountUSD / signal.price,
      price:        signal.price,
      amountUSD:    config.tradeAmountUSD,
      status:       'rejected',
      rejectReason: REJECT.EXCHANGE_UNAVAILABLE,
      signalId:     signal.id,
    });
    return { ok: false, logId: fallbackEntry.id, rejectReason: REJECT.EXCHANGE_UNAVAILABLE, detail: 'API server unreachable. Signal dropped.' };
  }

  // 6. Emergency stop
  if (config.emergencyStop) {
    return reject(signal, exchange, mode, REJECT.EMERGENCY_STOP, 'Emergency stop is active.');
  }

  // 7. Fetch symbol rules from backend
  let symbolRules: RiskSymbolRules;
  try {
    const rulesRes = await apiClient.getSymbolRules(exchange, credentials, signal.symbol);
    if (rulesRes.ok) {
      symbolRules = (rulesRes.data as { rules: RiskSymbolRules }).rules;
    } else {
      symbolRules = { symbol: signal.symbol, minQty: 0.00001, maxQty: 9_000_000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 };
    }
  } catch {
    symbolRules = { symbol: signal.symbol, minQty: 0.00001, maxQty: 9_000_000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 };
  }

  // 8. Fetch available balance
  let availableUSD = 0;
  try {
    const balRes = await apiClient.getBalances(exchange, credentials);
    if (balRes.ok) {
      const balances = (balRes.data as { balances: Array<{ asset: string; available: number }> }).balances;
      const usd = balances.find(b => b.asset === 'USDT' || b.asset === 'USD' || b.asset === 'USDC');
      availableUSD = usd?.available ?? 0;
    }
  } catch { /* proceed with 0 — risk manager will catch */ }

  // 9. Risk check
  const risk = validateRisk({
    exchange,
    symbol:           signal.symbol,
    side:             signal.side,
    price:            signal.price,
    amountUSD:        config.tradeAmountUSD,
    availableUSD,
    openPositions:    openPositionCount,
    dailyTradeCount,
    lastTradeTs,
    signalId:         signal.id,
    recentSignals,
    symbolRules,
    config,
  });

  if (!risk.ok) {
    return reject(signal, exchange, mode, risk.reason!, risk.detail ?? risk.reason!);
  }

  // ── All checks passed — place the order ───────────────────────────────────

  const isTestnet = mode === 'testnet';

  const pending = executionLog.add({
    mode,
    exchange,
    symbol:    signal.symbol,
    side:      signal.side,
    orderType: config.orderType,
    quantity:  risk.quantity!,
    price:     risk.price!,
    amountUSD: config.tradeAmountUSD,
    status:    'executing',
    signalId:  signal.id,
  });

  const t0 = Date.now();

  // Attempt order — retry once on network failure after 2 seconds
  const attemptOrder = async () => apiClient.placeOrder(exchange, credentials!, {
    symbol:   signal.symbol,
    side:     signal.side,
    type:     config.orderType,
    quantity: risk.quantity!,
    ...(config.orderType === 'limit' ? { price: risk.price! } : {}),
    clientId: pending.id,
    testnet:  isTestnet,
  });

  try {
    let orderRes = await attemptOrder();

    // Retry once on transient network/connection errors (2s delay).
    // Do NOT retry 4xx exchange rejections (bad request, auth failure, etc.).
    const isNetworkError = (err: string) =>
      err.includes('network') || err.includes('timed out') || err.includes('reach') ||
      err.includes('ECONNREFUSED') || err.includes('ECONNRESET') || err.includes('ETIMEDOUT');
    if (!orderRes.ok && isNetworkError((orderRes as { error: string }).error ?? '')) {
      console.warn('[engine] Network error on first attempt — retrying in 2s…');
      await new Promise(r => setTimeout(r, 2000));
      orderRes = await attemptOrder();
    }

    const latency = Date.now() - t0;

    if (!orderRes.ok) {
      executionLog.update(pending.id, {
        status:           'failed',
        errorMsg:         (orderRes as { error: string }).error,
        latencyMs:        latency,
        exchangeResponse: orderRes,
      });
      console.error(`[engine][${mode}] Order failed: ${(orderRes as { error: string }).error}`);
      return { ok: false, logId: pending.id, rejectReason: REJECT.EXCHANGE_REJECTED, detail: (orderRes as { error: string }).error };
    }

    const data    = (orderRes as { data: { order: { orderId: string } } }).data;
    const orderId = data?.order?.orderId ?? '';

    executionLog.update(pending.id, {
      status:           'executed',
      orderId,
      latencyMs:        latency,
      exchangeResponse: data,
    });

    dailyTradeCount++;
    lastTradeTs = Date.now();
    recentSignals = [signal.id, ...recentSignals].slice(0, 100);

    console.log(`[engine][${mode}] Order placed: ${exchange} ${signal.side} ${risk.quantity} ${signal.symbol} @ ${risk.price} → orderId=${orderId} (${latency}ms)`);
    return { ok: true, orderId, logId: pending.id };

  } catch (e) {
    const latency = Date.now() - t0;
    const msg     = (e as Error)?.message ?? 'Unknown error';
    executionLog.update(pending.id, { status: 'failed', errorMsg: msg, latencyMs: latency });
    return { ok: false, logId: pending.id, rejectReason: REJECT.EXCHANGE_UNAVAILABLE, detail: msg };
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function reject(
  signal: Signal,
  exchange: string,
  mode: 'demo' | 'paper' | 'testnet' | 'real',
  reason: string,
  detail: string,
): EngineResult {
  const entry = executionLog.add({
    mode,
    exchange,
    symbol:        signal.symbol,
    side:          signal.side,
    orderType:     'market',
    quantity:      0,
    price:         signal.price,
    amountUSD:     0,
    status:        'rejected',
    rejectReason:  reason,
    signalId:      signal.id,
  });
  console.warn(`[engine][${mode}] REJECTED — ${reason}: ${detail}`);
  return { ok: false, logId: entry.id, rejectReason: reason, detail };
}

// ── Internal test helpers (browser-side) ──────────────────────────────────────

export const _tests = {
  resetCounters() {
    dailyTradeCount = 0;
    lastTradeTs     = 0;
    recentSignals   = [];
    openPositionCount = 0;
  },
  getState() {
    return { dailyTradeCount, lastTradeTs, recentSignals: [...recentSignals], openPositionCount, credentials: !!credentials };
  },
};
