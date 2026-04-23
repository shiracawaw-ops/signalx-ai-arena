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
import { preflight, noteRejection, noteSuccess, clearShieldCooldownFor } from './rejection-shield.js';
import type { ExchangeId } from './asset-compliance.js';
import { recordBuy, recordSell, getOwned } from './internal-positions.js';
import { credentialStore } from './credential-store.js';
import {
  checkBotAllocation,
  commitBotAllocation,
  getCommittedUSD,
  releaseBotAllocation,
  resetBotAllocation,
} from './bot-allocation.js';
import { baseTicker } from './risk-manager.js';
import { realProfitStore }  from './real-profit-store.js';
import { botActivityStore } from './bot-activity-store.js';
import { botDoctorStore }   from './bot-doctor-store.js';
import { pipelineCache }    from './pipeline-cache.js';
import { resolveCompliance } from './asset-compliance.js';
import { STABLE_ASSETS, stripStableSuffix } from './stable-assets.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Signal {
  id:       string;
  symbol:   string;
  side:     'buy' | 'sell';
  price:    number;         // current price at signal time
  ts:       number;
  source?:  string;         // e.g. "autopilot", "manual"
  botId?:   string;         // origin bot — used for transparency + realized-PnL attribution
  botName?: string;
  /** Optional signal confidence 0..100; consumed by the trade-quality gate. */
  confidence?: number;
  /** Optional expected edge in bps; consumed by the trade-quality gate.
   *  When supplied and below the round-trip cost, the gate vetoes the trade. */
  expectedEdgeBps?: number;
  /** When true on a SELL of an asset we own, the engine sells the FULL
   *  owned base balance (rounded down to stepSize) instead of the
   *  configured tradeAmountUSD-derived quantity. Bots set this so a bot
   *  exit sells the entire position and never leaves a residual that
   *  would later become un-sellable dust below the venue's minNotional.
   *  Manual SELLs from the Exchange page leave this undefined so the
   *  user keeps explicit control over partial exits. */
  closeAll?: boolean;
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

// ── Per-symbol failure circuit breaker (frontend) ─────────────────────────────
// After N consecutive REAL failures for the same exchange:symbol pair we put
// it into a cooldown so retry storms don't burn rate-limit and don't keep
// hitting Binance with the same broken qty/notional.  Mirrors the backend
// adapter-level breaker but lives one layer up so a UI-driven retry also
// honours it.
const FE_FAILURE_THRESHOLD   = 3;
const FE_FAILURE_COOLDOWN_MS = 60_000;
interface FeGate { fails: number; cooldownUntil: number }
const feGates = new Map<string, FeGate>();
function feGateKey(exchange: string, symbol: string, mode: string) { return `${mode}:${exchange}:${symbol}`; }
function feGateBlocked(key: string): { blocked: boolean; remainingMs: number } {
  const g = feGates.get(key);
  if (!g || g.cooldownUntil === 0) return { blocked: false, remainingMs: 0 };
  const remaining = g.cooldownUntil - Date.now();
  if (remaining <= 0) { feGates.delete(key); return { blocked: false, remainingMs: 0 }; }
  return { blocked: true, remainingMs: remaining };
}
function feNoteFailure(key: string) {
  const g = feGates.get(key) ?? { fails: 0, cooldownUntil: 0 };
  g.fails++;
  if (g.fails >= FE_FAILURE_THRESHOLD) g.cooldownUntil = Date.now() + FE_FAILURE_COOLDOWN_MS;
  feGates.set(key, g);
}
function feNoteSuccess(key: string) { feGates.delete(key); }

// Reject-noise suppression: avoid flooding logs with identical hard blocks
// under bad conditions (cooldown storms, max-daily hard stop, dust retries).
const REJECT_NOISE_WINDOW_MS = 30_000;
const rejectNoiseByKey = new Map<string, number>();
const NOISE_REASONS = new Set<string>([
  REJECT.COOLDOWN_ACTIVE,
  REJECT.MAX_DAILY_TRADES,
  REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL,
  REJECT.BELOW_MIN_NOTIONAL,
  REJECT.ADAPTER_NOT_READY,
]);

function rejectNoiseKey(
  mode: 'demo' | 'paper' | 'testnet' | 'real',
  exchange: string,
  signal: Signal,
  reason: string,
): string {
  return `${mode}:${exchange}:${signal.botId ?? 'manual'}:${signal.symbol}:${reason}`;
}

function shouldSuppressRejectNoise(
  mode: 'demo' | 'paper' | 'testnet' | 'real',
  exchange: string,
  signal: Signal,
  reason: string,
): boolean {
  if (!NOISE_REASONS.has(reason)) return false;
  const key = rejectNoiseKey(mode, exchange, signal, reason);
  const now = Date.now();
  const prev = rejectNoiseByKey.get(key) ?? 0;
  rejectNoiseByKey.set(key, now);
  return now - prev < REJECT_NOISE_WINDOW_MS;
}

function classifyExchangeReject(detail: string): string {
  const d = detail.toLowerCase();
  if (/retcode\s*=?\s*170140|lower limit|min.?notional|below.*notional/.test(d)) return REJECT.BELOW_MIN_NOTIONAL;
  if (/retcode\s*=?\s*170131|insufficient.*balance|insufficient funds|not enough balance/.test(d)) return REJECT.INSUFFICIENT_BALANCE;
  if (/precision|step.?size|lot size|invalid qty|invalid quantity/.test(d)) return REJECT.INVALID_ORDER_SIZE;
  if (/symbol.*not.*found|unknown symbol/.test(d)) return REJECT.SYMBOL_NOT_FOUND;
  if (/account mode|unified|spot/.test(d) && /mismatch|not allowed|not support/.test(d)) return REJECT.ACCOUNT_MODE_MISMATCH;
  return REJECT.EXCHANGE_REJECTED;
}

function extractFeeUsd(orderData: unknown, fallbackTradeAmountUsd: number): number {
  const o = (orderData ?? {}) as Record<string, unknown>;
  const direct = Number(
    o['feeUSD'] ??
    o['fee'] ??
    o['cumExecFee'] ??
    o['cumFee'] ??
    0,
  );
  if (Number.isFinite(direct) && direct > 0) return direct;
  // Conservative fallback: assume taker-like 0.1% if venue response omits fee.
  return Math.max(0, fallbackTradeAmountUsd * 0.001);
}

function computeQuoteReserves(availableQuote: number, committedUSD: number): { feeReserveUSD: number; safetyReserveUSD: number } {
  const feeReserveUSD = Math.max(0, Math.min(availableQuote, committedUSD * 0.01));
  const safetyReserveUSD = Math.max(0, Math.min(availableQuote - feeReserveUSD, availableQuote * 0.02));
  return { feeReserveUSD, safetyReserveUSD };
}

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

  // Stale price guard — only applies to live exchange submission (testnet/real)
  // Demo and paper modes do not reject stale signals to keep simulator permissive
  if ((mode === 'testnet' || mode === 'real') && isPriceStale(signal)) {
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

  // 1b. REAL-mode strict gate: all 6 readiness conditions must be met atomically.
  // Before surfacing the generic "missing conditions: [...]" message, check the
  // root cause first so the user sees exactly what to do (almost always: connect
  // and validate keys on the Exchange page) instead of a cryptic 5-flag dump.
  if (mode === 'real' && !exchangeMode.isExecutionReady()) {
    const savedCreds = credentialStore.get(exchange);
    if (!savedCreds) {
      return reject(signal, exchange, mode, REJECT.MISSING_CREDENTIALS,
        `No saved API credentials for ${exchange}. Open the Exchange page, paste your API key + secret, then click Connect to validate.`);
    }
    const report  = exchangeMode.readinessReport();
    const missing = Object.entries(report)
      .filter(([k, v]) => k !== 'ready' && v === false)
      .map(([k]) => k)
      .join(', ');
    return reject(signal, exchange, mode, REJECT.ADAPTER_NOT_READY,
      `Real trading not fully ready for ${exchange}. Saved credentials found but readiness gates not green: [${missing}]. Click Connect on the Exchange page to re-run validation.`);
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

  // 5. Credentials injected.
  // Lazy-hydrate from the singleton credentialStore so a tab navigation or
  // a reload that landed somewhere other than /exchange does not strand
  // a perfectly good saved key. setCredentials(...) is still the primary
  // path; this is a safety net.
  if (!credentials) {
    const fromStore = credentialStore.get(exchange);
    if (fromStore) {
      credentials = fromStore;
    } else {
      return reject(signal, exchange, mode, REJECT.MISSING_CREDENTIALS,
        `No saved API credentials for ${exchange}. Open the Exchange page, paste your API key + secret, then click Connect to validate.`);
    }
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
  // 6b. Per-symbol cooldown (frontend circuit breaker)
  // SELL of a position we just opened bypasses cooldowns — closing trades
  // must never be blocked by guards meant to throttle entry retries.
  const gateKey  = feGateKey(exchange, signal.symbol, mode);
  const baseTk   = baseTicker(signal.symbol);
  const ownedHere = getOwned(exchange, baseTk);
  const isClosingSell = signal.side === 'sell' && ownedHere > 0;

  // 6a-bis. Bot Doctor dust gate — once a symbol has been classified as
  // dust (position size persistently below exchange minimum), block
  // further BUY/SELL attempts so the user does not burn fees + rate-limit
  // on retries that cannot succeed. Only enforced in real mode; cleared
  // automatically when the user clears the dust mark from the Doctor UI.
  if (mode === 'real' && botDoctorStore.canAutoAct() && botDoctorStore.isDust(exchange, baseTk)) {
    return reject(signal, exchange, mode, REJECT.BELOW_MIN_NOTIONAL,
      `Doctor: ${exchange}:${baseTk} is marked as dust. Clear the dust mark to retry.`);
  }

  // 6a-ter. Hard stop without churn: once max-daily is reached, do not
  // continue into downstream gates that would generate repeated noisy rejects.
  if (config.maxDailyTrades > 0 && dailyTradeCount >= config.maxDailyTrades) {
    return reject(
      signal,
      exchange,
      mode,
      REJECT.MAX_DAILY_TRADES,
      `Max daily trades reached (${dailyTradeCount}/${config.maxDailyTrades}). Trading is paused until daily reset.`,
    );
  }

  // 6a-quater. Upfront SELL min-notional gate (uses cached symbol rules).
  // For closing SELLs we already know the qty we own — if it's below the
  // exchange minimums we should NOT call the network or the heavyweight
  // shield/risk pipeline. Marking dust here also stops follow-up retries
  // from the same bot. We deliberately do NOT call feNoteFailure for this
  // path so a single dust asset can never push the per-symbol cooldown
  // counter into "cooldown_active" storms across the fleet.
  if (mode === 'real' && signal.side === 'sell' && ownedHere > 0) {
    try {
      const compl = resolveCompliance(signal.symbol, exchange as ExchangeId);
      if (compl.ok) {
        const cachedRules = pipelineCache.get<RiskSymbolRules>(`rules:${exchange}:${compl.exchangeSymbol}`);
        if (cachedRules) {
          const px       = signal.price > 0 ? signal.price : 0;
          const notional = px * ownedHere;
          const minQty   = cachedRules.minQty       ?? 0;
          const minNot   = cachedRules.minNotional  ?? 0;
          if (minQty > 0 && ownedHere < minQty) {
            const detail = `Owned ${ownedHere} ${baseTk} below ${exchange} minQty ${minQty}.`;
            botDoctorStore.markDustWithReason(exchange, baseTk, REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL, detail);
            return reject(signal, exchange, mode, REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL, detail);
          }
          if (minNot > 0 && px > 0 && notional < minNot) {
            const detail = `Owned ${baseTk} value $${notional.toFixed(2)} below ${exchange} minNotional $${minNot}.`;
            botDoctorStore.markDustWithReason(exchange, baseTk, REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL, detail);
            return reject(signal, exchange, mode, REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL, detail);
          }
        }
      }
    } catch (e) {
      console.warn('[engine] upfront SELL gate skipped:', (e as Error).message);
    }
  }

  // 7. Fetch symbol rules from backend
  let symbolRules: RiskSymbolRules;
  try {
    const rulesRes = await apiClient.getSymbolRules(exchange, credentials, signal.symbol);
    if (rulesRes.ok) {
      symbolRules = (rulesRes.data as { rules: RiskSymbolRules }).rules;
    } else {
      symbolRules = { symbol: signal.symbol, minQty: 0.00001, maxQty: 9_000_000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01, filterSource: 'stub' };
    }
  } catch {
    symbolRules = { symbol: signal.symbol, minQty: 0.00001, maxQty: 9_000_000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01, filterSource: 'stub' };
  }

  // 8. Fetch available balance — side-aware (BUY needs quote, SELL needs base)
  let availableQuote = 0;
  let availableBase  = 0;
  let feeReserveUSD = 0;
  let safetyReserveUSD = 0;
  try {
    const balRes = await apiClient.getBalances(exchange, credentials);
    if (balRes.ok) {
      const balances = (balRes.data as { balances: Array<{ asset: string; available: number }> }).balances;
      const quoteAsset = symbolRules.quoteCurrency ?? 'USDT';
      const baseAsset  = symbolRules.baseCurrency  ?? stripStableSuffix(signal.symbol);
      // Prefer the exact quote asset, otherwise fall back to a stable
      // settlement asset using the shared registry's declaration order
      // (USDT first, then USDC, USD, …) — keeps fallback selection
      // deterministic regardless of how an adapter orders balance rows.
      let q = balances.find(b => b.asset === quoteAsset);
      if (!q) {
        for (const sym of STABLE_ASSETS) {
          const hit = balances.find(b => b.asset === sym);
          if (hit) { q = hit; break; }
        }
      }
      const bs = balances.find(b => b.asset.toUpperCase() === baseAsset.toUpperCase());
      availableQuote = q?.available  ?? 0;
      availableBase  = bs?.available ?? 0;
      // Reserve buffers so the engine never spends the entire free quote
      // amount on a single order path.
      const committed = signal.botId ? getCommittedUSD(signal.botId) : 0;
      const reserves = computeQuoteReserves(availableQuote, Math.max(config.tradeAmountUSD, committed));
      feeReserveUSD = reserves.feeReserveUSD;
      safetyReserveUSD = reserves.safetyReserveUSD;
    }
  } catch { /* proceed with 0 — risk manager will catch */ }

  // For SELL: trust the larger of (exchange-reported free base) and (local
  // ledger of what we just bought this session). Bybit takes 1-3s to surface
  // a fresh fill in /balances; without this the SELL after a successful BUY
  // is rejected with INSUFFICIENT_BALANCE.
  if (signal.side === 'sell') {
    const ledgerOwned = getOwned(exchange, baseTk);
    if (ledgerOwned > availableBase) {
      console.log(`[engine] using ledger-owned ${ledgerOwned} for ${baseTk} (exchange reported ${availableBase})`);
      availableBase = ledgerOwned;
    }
  }

  const gate = feGateBlocked(gateKey);
  if (gate.blocked && !isClosingSell) {
    return reject(signal, exchange, mode, REJECT.COOLDOWN_ACTIVE,
      `Cooldown active for ${exchange}:${signal.symbol} after ${FE_FAILURE_THRESHOLD} consecutive failures (${Math.ceil(gate.remainingMs / 1000)}s remaining).`);
  }
  if (isClosingSell) {
    // Forgive any pending shield cooldown for this exact symbol so the
    // close path is not blocked by an entry-side fail-count.
    clearShieldCooldownFor(exchange, signal.symbol);
  }

  // 8a. Rejection-Prevention Shield — pre-flight gate (compliance + cache + cooldown)
  try {
    const shield = await preflight({
      exchange:    exchange as ExchangeId,
      arenaSymbol: signal.symbol,
      side:        signal.side,
      amountUSD:   config.tradeAmountUSD,
      refPrice:    signal.price,
      credentials,
      freeQuoteBalance: availableQuote,
      freeBaseBalance:  availableBase,
      feeReserveUSD,
      safetyReserveUSD,
      maxDailyTrades: config.maxDailyTrades,
      usedDailyTrades: dailyTradeCount,
      signalAgeMs: Math.max(0, Date.now() - signal.ts),
      ...(signal.confidence !== undefined ? { confidence: signal.confidence } : {}),
      ...(signal.expectedEdgeBps !== undefined ? { expectedEdgeBps: signal.expectedEdgeBps } : {}),
    });
    if (shield.outcome === 'block') {
      // Translate the shield's categorized blockCode into a specific REJECT
      // code so the operator never sees a generic "symbol_blocked" again.
      const code =
        shield.blockCode === 'symbol_temporarily_locked' ? REJECT.SYMBOL_TEMPORARILY_LOCKED :
        shield.blockCode === 'exchange_restriction'      ? REJECT.EXCHANGE_RESTRICTION      :
        shield.blockCode === 'symbol_mapping_failed'     ? REJECT.SYMBOL_MAPPING_FAILED     :
        shield.blockCode === 'symbol_not_found'          ? REJECT.SYMBOL_NOT_FOUND          :
        shield.blockCode === 'symbol_inactive'           ? REJECT.SYMBOL_INACTIVE           :
        shield.blockCode === 'below_min_notional'        ? REJECT.BELOW_MIN_NOTIONAL        :
        shield.blockCode === 'invalid_order_size'        ? REJECT.INVALID_ORDER_SIZE        :
        shield.blockCode === 'insufficient_balance'      ? REJECT.INSUFFICIENT_BALANCE      :
        shield.blockCode === 'cooldown_active'           ? REJECT.COOLDOWN_ACTIVE           :
        shield.blockCode === 'stale_cache_conflict'      ? REJECT.STALE_CACHE_CONFLICT      :
        shield.blockCode === 'low_trade_quality'         ? REJECT.LOW_TRADE_QUALITY         :
        shield.blockCode === 'edge_below_fees'           ? REJECT.EDGE_BELOW_FEES           :
                                                           REJECT.PREFLIGHT_NOT_READY;
      return reject(signal, exchange, mode, code, `Pre-flight: ${shield.reason}`);
    }
  } catch (e) {
    console.warn('[engine] Pipeline shield preflight failed (non-fatal):', (e as Error).message);
  }

  const availableForNewOrders = Math.max(0, availableQuote - feeReserveUSD - safetyReserveUSD);

  // 8b. Per-bot capital allocation check (Phase 4 — Option 3 fixed cap).
  // Cap = tradeAmountUSD × maxOpenPositions; closing-SELLs are not gated
  // because they REDUCE commitment, not add to it.
  const isClosingSellForAlloc = signal.side === 'sell' && availableBase > 0;
  if (!isClosingSellForAlloc && availableForNewOrders <= 0) {
    return reject(
      signal,
      exchange,
      mode,
      REJECT.INSUFFICIENT_BALANCE,
      `Free ${symbolRules.quoteCurrency ?? 'USDT'} after reserves is $0.00 (raw $${availableQuote.toFixed(2)} - fee reserve $${feeReserveUSD.toFixed(2)} - safety reserve $${safetyReserveUSD.toFixed(2)}).`,
    );
  }
  if (!isClosingSellForAlloc) {
    const alloc = checkBotAllocation({
      botId:     signal.botId,
      symbol:    signal.symbol,
      amountUSD: config.tradeAmountUSD,
      config:    {
        tradeAmountUSD:   config.tradeAmountUSD,
        maxOpenPositions: config.maxOpenPositions,
      },
    });
    if (!alloc.ok) {
      return reject(signal, exchange, mode, REJECT.BOT_ALLOCATION_EXCEEDED, alloc.reason);
    }
  }

  // 9. Risk check
  const risk = validateRisk({
    exchange,
    symbol:           signal.symbol,
    side:             signal.side,
    price:            signal.price,
    amountUSD:        config.tradeAmountUSD,
    availableQuote,
    availableBase,
    feeReserveUSD,
    safetyReserveUSD,
    openPositions:    openPositionCount,
    dailyTradeCount,
    lastTradeTs,
    signalId:         signal.id,
    recentSignals,
    symbolRules,
    config,
    closeAll:         signal.closeAll === true,
  });

  if (!risk.ok) {
    // Persist diagnostic snapshot so the operator can see exactly which
    // numbers tripped risk — without re-running the math from scratch.
    const entry = executionLog.add({
      mode, exchange,
      symbol:    signal.symbol,
      side:      signal.side,
      orderType: config.orderType,
      quantity:  risk.finalQty ?? 0,
      price:     signal.price,
      amountUSD: config.tradeAmountUSD,
      status:    'rejected',
      rejectReason:    risk.reason,
      rejectionDetail: risk.detail,
      signalId:        signal.id,
      freeBalance:     risk.freeBalance,
      freeAsset:       risk.freeAsset,
      computedQty:     risk.computedQty,
      finalQty:        risk.finalQty,
      minNotional:     risk.minNotional,
      stepSize:        risk.stepSize,
      rulesSource:     risk.filterSource,
    });
    console.warn(`[engine][${mode}] REJECTED — ${risk.reason}: ${risk.detail}`);
    return { ok: false, logId: entry.id, rejectReason: risk.reason, detail: risk.detail };
  }

  // ── All checks passed — place the order ───────────────────────────────────

  const isTestnet = mode === 'testnet';

  const ownedBeforeSell = signal.side === 'sell' ? availableBase : 0;
  const submittedSellQty = signal.side === 'sell' ? (risk.quantity ?? 0) : 0;
  const remainingQtyEstimate = signal.side === 'sell'
    ? Math.max(0, ownedBeforeSell - submittedSellQty)
    : 0;
  const remainingNotionalEstimate = signal.side === 'sell'
    ? remainingQtyEstimate * (risk.price ?? signal.price)
    : 0;

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
    freeBalance: risk.freeBalance,
    freeAsset:   risk.freeAsset,
    computedQty: risk.computedQty,
    finalQty:    risk.finalQty,
    minNotional: risk.minNotional,
    stepSize:    risk.stepSize,
    rulesSource: risk.filterSource,
    ...(signal.side === 'sell' ? {
      ownedQtyDetected: ownedBeforeSell,
      sellQtySubmitted: submittedSellQty,
      remainingQtyEstimate,
      remainingNotionalEstimate,
      closeIntent: signal.closeAll ? 'full' as const : 'partial' as const,
    } : {}),
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
      const errMsg = (orderRes as { error: string }).error ?? 'Unknown error';
      const rejectCode = classifyExchangeReject(errMsg);
      if (shouldSuppressRejectNoise(mode, exchange, signal, rejectCode)) {
        return { ok: false, logId: pending.id, rejectReason: rejectCode, detail: errMsg };
      }
    }

    if (!orderRes.ok) {
      const errMsg = (orderRes as { error: string }).error ?? 'Unknown error';
      const rejectCode = classifyExchangeReject(errMsg);
      executionLog.update(pending.id, {
        status:           'failed',
        errorMsg:         errMsg,
        rejectionDetail:  errMsg,
        latencyMs:        latency,
        exchangeResponse: orderRes,
        rejectReason:     rejectCode,
        ...(signal.side === 'sell' ? { sellBlockReason: errMsg } : {}),
      });
      feNoteFailure(gateKey);
      noteRejection(exchange, signal.symbol);
      console.error(`[engine][${mode}] Order failed: ${errMsg}`);
      if (signal.botId && (mode === 'real' || mode === 'testnet')) {
        try {
          botActivityStore.recordAttempt({
            botId: signal.botId,
            kind: 'reject',
            symbol: signal.symbol,
            reason: rejectCode,
            detail: errMsg,
          });
        } catch { /* no-op */ }
      }
      return { ok: false, logId: pending.id, rejectReason: rejectCode, detail: errMsg };
    }

    const data    = (orderRes as { data: { order: { orderId: string } } }).data;
    const orderId = data?.order?.orderId ?? '';

    executionLog.update(pending.id, {
      status:           'executed',
      orderId,
      latencyMs:        latency,
      exchangeResponse: data,
      ...(signal.side === 'sell' ? {
        remainingQtyEstimate,
        remainingNotionalEstimate,
      } : {}),
    });

    dailyTradeCount++;
    lastTradeTs = Date.now();
    recentSignals = [signal.id, ...recentSignals].slice(0, 100);
    feNoteSuccess(gateKey);
    noteSuccess(exchange, signal.symbol);

    // Update local position ledger so a follow-up SELL can find the freshly
    // bought qty before /balances catches up. Mirror the inverse for SELLs.
    try {
      if (signal.side === 'buy')  recordBuy (exchange, baseTk, risk.quantity!, risk.price!);
      if (signal.side === 'sell') recordSell(exchange, baseTk, risk.quantity!);
    } catch (e) { console.warn('[engine] ledger update failed:', (e as Error).message); }

    // Per-bot allocation accounting: BUY commits, closing-SELL releases.
    // Only tracked for real/testnet — paper/demo trades do not consume real cap.
    try {
      if (signal.botId && (mode === 'real' || mode === 'testnet')) {
        if (signal.side === 'buy') {
          commitBotAllocation(signal.botId, signal.symbol, config.tradeAmountUSD);
        } else if (signal.side === 'sell') {
          // Partial-exit detection: ratio = sold qty / committed qty proxy.
          // If we committed N positions for this symbol and this sell drains
          // the local ledger, treat as full close (ratio=1). Otherwise pro-rate
          // by sold-qty fraction of pre-sell owned base.
          const ownedBefore = availableBase;
          const ratio = ownedBefore > 0
            ? Math.max(0, Math.min(1, risk.quantity! / ownedBefore))
            : 1;
          releaseBotAllocation(signal.botId, signal.symbol, ratio);
        }
      }
    } catch (e) { console.warn('[engine] allocation update failed:', (e as Error).message); }

    // Real-mode telemetry — feeds the Real Profit panel + Bot Activity panel.
    // Only emit for `real` to keep simulator stats out of the realized-PnL
    // store. Testnet fills are NOT real money.
    try {
      if (mode === 'real') {
        const fillFeeUSD = extractFeeUsd(data, config.tradeAmountUSD);
        if (signal.side === 'buy') {
          realProfitStore.recordRealBuy({
            exchange, baseAsset: baseTk,
            qty: risk.quantity!, price: risk.price!,
            botId: signal.botId,
            symbol: signal.symbol,
            feeUSD: fillFeeUSD,
          });
        } else {
          realProfitStore.recordRealSell({
            exchange, baseAsset: baseTk,
            qty: risk.quantity!, price: risk.price!,
            botId: signal.botId, botName: signal.botName,
            symbol: signal.symbol,
            feeUSD: fillFeeUSD,
          });
        }
      }
      if (signal.botId && (mode === 'real' || mode === 'testnet')) {
        botActivityStore.recordAttempt({
          botId:  signal.botId,
          kind:   'success',
          symbol: signal.symbol,
        });
      }
    } catch (e) { console.warn('[engine] telemetry update failed:', (e as Error).message); }

    console.log(`[engine][${mode}] Order placed: ${exchange} ${signal.side} ${risk.quantity} ${signal.symbol} @ ${risk.price} → orderId=${orderId} (${latency}ms)`);
    return { ok: true, orderId, logId: pending.id };

  } catch (e) {
    const latency = Date.now() - t0;
    const msg     = (e as Error)?.message ?? 'Unknown error';
    executionLog.update(pending.id, { status: 'failed', errorMsg: msg, rejectionDetail: msg, latencyMs: latency });
    feNoteFailure(gateKey);
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
  if (shouldSuppressRejectNoise(mode, exchange, signal, reason)) {
    return { ok: false, rejectReason: reason, detail };
  }
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
  if (signal.botId && (mode === 'real' || mode === 'testnet')) {
    try {
      botActivityStore.recordAttempt({
        botId:  signal.botId,
        kind:   'reject',
        symbol: signal.symbol,
        reason, detail,
      });
    } catch { /* never throw from logger */ }
  }
  // Bot Doctor: classify + (in AUTO_FIX/FULL_ACTIVE) auto-bench. Real mode
  // only — testnet rejects must not bench the user's real-trading bots.
  if (mode === 'real') {
    try {
      const rate = signal.botId ? botActivityStore.rejectionRate(signal.botId) : 0;
      const recent = signal.botId
        ? (botActivityStore.snapshot().bots[signal.botId]?.recent ?? []).filter(
            r => r.kind === 'attempt' || r.kind === 'success' || r.kind === 'reject',
          ).length
        : 0;
      botDoctorStore.observe({
        botId:           signal.botId,
        rejectReason:    reason,
        rejectDetail:    detail,
        rejectionRate:   rate,
        submittedRecent: recent,
        exchange,
        baseAsset:       baseTicker(signal.symbol),
      });
    } catch { /* doctor must never throw */ }
  }
  return { ok: false, logId: entry.id, rejectReason: reason, detail };
}

// ── Internal test helpers (browser-side) ──────────────────────────────────────

export const _tests = {
  resetCounters() {
    dailyTradeCount = 0;
    lastTradeTs     = 0;
    recentSignals   = [];
    openPositionCount = 0;
    feGates.clear();
    rejectNoiseByKey.clear();
    resetBotAllocation();
  },
  getState() {
    return { dailyTradeCount, lastTradeTs, recentSignals: [...recentSignals], openPositionCount, credentials: !!credentials };
  },
  /** Read-only peek at the per-(exchange,symbol) cooldown counter. Used by tests
   *  that assert the upfront SELL gate does NOT bump cooldown for dust rejects. */
  getFeFails(exchange: string, symbol: string, mode: 'real' | 'demo' = 'real'): number {
    return feGates.get(feGateKey(exchange, symbol, mode))?.fails ?? 0;
  },
  feNoteFailure(exchange: string, symbol: string, mode: 'real' | 'demo' = 'real') {
    feNoteFailure(feGateKey(exchange, symbol, mode));
  },
};
