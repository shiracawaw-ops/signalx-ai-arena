// ─── Unified Trading Execution Engine ─────────────────────────────────────────
// Signal → Validation → Risk → API → Log
// DEMO: logs only, zero real orders.
// LIVE: validates every condition, then calls backend proxy → exchange.

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

// ── Main execute function ──────────────────────────────────────────────────────

export async function executeSignal(signal: Signal): Promise<EngineResult> {
  resetDailyCounterIfNeeded();

  const modeState = exchangeMode.get();
  const exchange  = modeState.exchange;
  const config    = tradeConfig.get(exchange);
  const isDemo    = modeState.mode === 'demo';

  // ── DEMO MODE ────────────────────────────────────────────────────────────────
  if (isDemo) {
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
    console.log(`[engine][demo] Signal executed (no real order): ${signal.side} ${signal.symbol} @ $${signal.price}`);
    return { ok: true, orderId: logEntry.orderId, logId: logEntry.id, demo: true };
  }

  // ── LIVE MODE — Pre-execution safety checks ───────────────────────────────

  // 1. Live mode flag
  if (modeState.mode !== 'live') {
    return reject(signal, exchange, REJECT.LIVE_DISABLED, 'Mode is not set to Live.');
  }

  // 2. Trading Armed
  if (!modeState.armed) {
    return reject(signal, exchange, REJECT.BOT_NOT_ARMED, 'Trading is not armed. Enable "Trading Armed" in Live Status tab.');
  }

  // 3. API validated
  if (!modeState.apiValidated) {
    return reject(signal, exchange, REJECT.ADAPTER_NOT_READY, 'API not validated. Connect and validate credentials first.');
  }

  // 4. Trade permission
  if (!modeState.permissions.trade) {
    return reject(signal, exchange, REJECT.NO_TRADE_PERMISSION, 'API key does not have trade permission on this exchange.');
  }

  // 5. Credentials injected
  if (!credentials) {
    return reject(signal, exchange, REJECT.MISSING_CREDENTIALS, 'Credentials not provided to engine. Reconnect.');
  }

  // 5b. Backend reachability — fall back to demo if API server is down
  const backendUp = await isBackendReachable().catch(() => false);
  if (!backendUp) {
    console.warn('[engine][live] Backend unreachable — falling back to demo mode for this signal');
    const demoEntry = executionLog.add({
      mode:      'demo',
      exchange,
      symbol:    signal.symbol,
      side:      signal.side,
      orderType: config.orderType,
      quantity:  config.tradeAmountUSD / signal.price,
      price:     signal.price,
      amountUSD: config.tradeAmountUSD,
      status:    'rejected',
      rejectReason: REJECT.EXCHANGE_UNAVAILABLE,
      signalId:  signal.id,
    });
    return { ok: false, logId: demoEntry.id, rejectReason: REJECT.EXCHANGE_UNAVAILABLE, detail: 'API server unreachable. Check connection — signal queued as demo.' };
  }

  // 6. Emergency stop
  if (config.emergencyStop) {
    return reject(signal, exchange, REJECT.EMERGENCY_STOP, 'Emergency stop is active.');
  }

  // 7. Fetch symbol rules from backend
  let symbolRules: RiskSymbolRules;
  try {
    const rulesRes = await apiClient.getSymbolRules(exchange, credentials, signal.symbol);
    if (rulesRes.ok) {
      symbolRules = (rulesRes.data as { rules: RiskSymbolRules }).rules;
    } else {
      // Fallback stub rules — still lets us compute, exchange will validate
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
    return reject(signal, exchange, risk.reason!, risk.detail ?? risk.reason!);
  }

  // ── All checks passed — place the order ───────────────────────────────────

  // Create pending log entry
  const pending = executionLog.add({
    mode:      'live',
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

  try {
    const orderRes = await apiClient.placeOrder(exchange, credentials, {
      symbol:   signal.symbol,
      side:     signal.side,
      type:     config.orderType,
      quantity: risk.quantity!,
      ...(config.orderType === 'limit' ? { price: risk.price! } : {}),
      clientId: pending.id,
    });

    const latency = Date.now() - t0;

    if (!orderRes.ok) {
      executionLog.update(pending.id, {
        status:           'failed',
        errorMsg:         (orderRes as { error: string }).error,
        latencyMs:        latency,
        exchangeResponse: orderRes,
      });
      console.error(`[engine][live] Order failed: ${(orderRes as { error: string }).error}`);
      return { ok: false, logId: pending.id, rejectReason: REJECT.EXCHANGE_REJECTED, detail: (orderRes as { error: string }).error };
    }

    const data       = (orderRes as { data: { order: { orderId: string } } }).data;
    const orderId    = data?.order?.orderId ?? '';

    // Mark as executed
    executionLog.update(pending.id, {
      status:           'executed',
      orderId,
      latencyMs:        latency,
      exchangeResponse: data,
    });

    // Update counters
    dailyTradeCount++;
    lastTradeTs = Date.now();
    recentSignals = [signal.id, ...recentSignals].slice(0, 100);

    console.log(`[engine][live] Order placed: ${exchange} ${signal.side} ${risk.quantity} ${signal.symbol} @ ${risk.price} → orderId=${orderId} (${latency}ms)`);
    return { ok: true, orderId, logId: pending.id };

  } catch (e) {
    const latency = Date.now() - t0;
    const msg     = (e as Error)?.message ?? 'Unknown error';
    executionLog.update(pending.id, { status: 'failed', errorMsg: msg, latencyMs: latency });
    return { ok: false, logId: pending.id, rejectReason: REJECT.EXCHANGE_UNAVAILABLE, detail: msg };
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function reject(signal: Signal, exchange: string, reason: string, detail: string): EngineResult {
  const entry = executionLog.add({
    mode:          'live',
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
  console.warn(`[engine][live] REJECTED — ${reason}: ${detail}`);
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
