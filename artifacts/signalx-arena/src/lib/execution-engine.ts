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
import { executionLog, REJECT, type ExecutionEntry } from './execution-log.js';
import { apiClient, isBackendReachable } from './api-client.js';
import { validateRisk }    from './risk-manager.js';
import type { SymbolRules as RiskSymbolRules } from './risk-manager.js';
import { preflight, noteRejection, noteSuccess, clearShieldCooldownFor } from './rejection-shield.js';
import type { ExchangeId } from './asset-compliance.js';
import { recordBuy, recordSell, getOwned, getEntryPrice, getLastFilledAt } from './internal-positions';
import { credentialStore } from './credential-store.js';
import {
  checkBotAllocation,
  commitBotAllocation,
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
import { botFleet } from './bot-fleet.js';
import { AUTOPILOT_CONFIDENCE_FLOOR } from './autopilot.js';
import {
  MIN_CASH_RESERVE_PCT,
  SCALPER_ALLOWED_SYMBOLS,
  evaluateScalperOpportunity,
  type SmartScalperSnapshot,
} from './smart-scalper.js';
import {
  evaluateBotStop,
  selectReplacementBot,
} from './smart-bot-replacement.js';

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
const MAX_PRICE_DRIFT_RATIO = 0.05;
const MAX_TRADES_PER_SYMBOL_HOUR = 12;
const MAX_CAPITAL_USAGE_PCT = 25;
const MAX_ACTIVE_REAL_BOTS = 1;

interface SymbolTradeStat {
  ts: number;
  side: 'buy' | 'sell';
  qualityWeak?: boolean;
}
const symbolTradeMemory = new Map<string, SymbolTradeStat[]>();
const symbolLastWeakReject = new Map<string, number>();

function symbolMemKey(exchange: string, symbol: string): string {
  return `${exchange}:${symbol.toUpperCase()}`;
}

function trimSymbolStats(list: SymbolTradeStat[], now = Date.now()): SymbolTradeStat[] {
  return list.filter(e => now - e.ts <= 60 * 60 * 1000);
}

function noteSymbolAttempt(exchange: string, symbol: string, side: 'buy' | 'sell', qualityWeak = false): void {
  const key = symbolMemKey(exchange, symbol);
  const now = Date.now();
  const next = trimSymbolStats([...(symbolTradeMemory.get(key) ?? []), { ts: now, side, qualityWeak }], now);
  symbolTradeMemory.set(key, next);
  if (qualityWeak) symbolLastWeakReject.set(key, now);
}

function symbolTradesLastHour(exchange: string, symbol: string): number {
  const key = symbolMemKey(exchange, symbol);
  const list = trimSymbolStats(symbolTradeMemory.get(key) ?? []);
  symbolTradeMemory.set(key, list);
  return list.length;
}

function weakSignalLoop(exchange: string, symbol: string): boolean {
  const key = symbolMemKey(exchange, symbol);
  const ts = symbolLastWeakReject.get(key) ?? 0;
  return ts > 0 && Date.now() - ts < 60_000;
}

function hasBuySellLoop(exchange: string, symbol: string, side: 'buy' | 'sell'): boolean {
  const key = symbolMemKey(exchange, symbol);
  const list = trimSymbolStats(symbolTradeMemory.get(key) ?? []);
  symbolTradeMemory.set(key, list);
  if (list.length < 2) return false;
  const a = list[list.length - 1];
  const b = list[list.length - 2];
  return !!a && !!b && a.side !== b.side && a.side !== side;
}

function recentRejectBreakdown(botId: string): {
  spamRejectsRecent: number;
  riskBreakRejectsRecent: number;
  badEntryRejectsRecent: number;
} {
  const recent = botActivityStore.snapshot().bots[botId]?.recent ?? [];
  const rejects = recent.filter(r => r.kind === 'reject');
  const byReason = (re: RegExp) => rejects.filter(r => re.test(r.reason ?? '')).length;
  return {
    spamRejectsRecent: byReason(/cooldown|duplicate|stale|max_symbol_trades|repeated_weak_signal/i),
    riskBreakRejectsRecent: byReason(/cash_reserve|capital_usage|max_active_real_bots|emergency_stop|price_drift|min_notional|invalid_order_size|insufficient_balance/i),
    badEntryRejectsRecent: byReason(/confidence_weak|no_breakout|momentum_not_confirmed|rsi|low_trade_quality|spread_too_high|market_noisy_or_spike|position_already_open/i),
  };
}

function maybeReplaceStoppedBot(stoppedBotId: string | undefined, stopReason: string): void {
  if (!stoppedBotId) return;
  const rp = realProfitStore.snapshot();
  const candidates = Object.entries(rp.perBot).map(([botId, s]) => {
    const settledTrades = s.wins + s.losses;
    const net = s.realizedPnlUSD - s.feesPaidUSD;
    const winRate = settledTrades > 0 ? s.wins / settledTrades : 0;
    const recent = botActivityStore.snapshot().bots[botId]?.recent ?? [];
    const rejects = recent.filter(r => r.kind === 'reject').length;
    const submitted = recent.filter(r => r.kind === 'attempt' || r.kind === 'success' || r.kind === 'reject').length;
    const rejectionRate = submitted > 0 ? rejects / submitted : 0;
    const breakdown = recentRejectBreakdown(botId);
    return {
      botId,
      trades: settledTrades,
      realizedNetPnlUSD: net,
      recentWinRate: winRate,
      rejectionRate,
      last10Net: s.last10Net ?? [],
      ...breakdown,
    };
  });
  const best = selectReplacementBot(candidates, stoppedBotId);
  if (!best) {
    executionLog.add({
      mode: exchangeMode.get().mode,
      exchange: exchangeMode.get().exchange,
      symbol: 'USDT',
      side: 'buy',
      orderType: 'market',
      quantity: 0,
      price: 0,
      amountUSD: 0,
      status: 'rejected',
      rejectReason: REJECT.NO_QUALIFIED_REPLACEMENT,
      rejectionDetail: 'No qualified bot available — real trading paused safely.',
      signalId: `replace_none_${Date.now()}`,
    });
    return;
  }

  botDoctorStore.unbench(best.botId);
  executionLog.add({
    mode: exchangeMode.get().mode,
    exchange: exchangeMode.get().exchange,
    symbol: 'USDT',
    side: 'buy',
    orderType: 'market',
    quantity: 0,
    price: 0,
    amountUSD: 0,
    status: 'executed',
    rejectReason: REJECT.REAL_BOT_STOPPED,
    rejectionDetail:
      `stoppedBotId=${stoppedBotId} stopReason=${stopReason} replacementBotId=${best.botId} replacementScore=${best.score.toFixed(4)} ` +
      `oldPerformance=stopped newPerformance=net:${best.realizedNetPnlUSD.toFixed(2)} winRate:${(best.recentWinRate * 100).toFixed(1)} ` +
      `rejection:${(best.rejectionRate * 100).toFixed(1)}% confidence:${best.confidence.toFixed(1)}`,
    signalId: `replace_${stoppedBotId}_${best.botId}_${Date.now()}`,
  });
}

function ensureSafeDefaults(exchange: string): void {
  const cfg = tradeConfig.get(exchange);
  const safeAllowed = [...SCALPER_ALLOWED_SYMBOLS].map(s => s.toUpperCase());
  const normalizedAllowed = cfg.allowedSymbols.map(s => s.toUpperCase());
  const mergedAllowed = Array.from(new Set([...safeAllowed, ...normalizedAllowed]));
  const patch: Partial<typeof cfg> = {};
  if (cfg.cooldownSeconds < 30) patch.cooldownSeconds = 30;
  if (cfg.takeProfitPct <= 0 || cfg.takeProfitPct > 1.2) patch.takeProfitPct = 1.2;
  if (cfg.stopLossPct <= 0 || cfg.stopLossPct > 0.6) patch.stopLossPct = 0.6;
  if (cfg.maxOpenPositions === 0 || cfg.maxOpenPositions > 2) patch.maxOpenPositions = 2;
  if (cfg.allowedSymbols.length === 0 || cfg.allowedSymbols.some(s => !safeAllowed.includes(s.toUpperCase()))) {
    patch.allowedSymbols = mergedAllowed;
  }
  if (Object.keys(patch).length > 0) {
    tradeConfig.set(exchange, patch);
  }
}

function executionPriceFields(
  signal: Signal,
  pricingPrice: number,
  source: string,
  normalizedSymbol = signal.symbol.toUpperCase(),
  quoteTimestamp = Date.now(),
): Pick<ExecutionEntry,
  'price' | 'requestedSymbol' | 'normalizedSymbol' | 'priceSource' | 'fetchedMarketPrice' | 'quoteTimestamp' | 'finalNotional'
> {
  return {
    price: pricingPrice,
    requestedSymbol: signal.symbol,
    normalizedSymbol,
    priceSource: source,
    fetchedMarketPrice: pricingPrice,
    quoteTimestamp,
    finalNotional: 0,
  };
}

function toRejectCodeFromScalperReason(reason: string): string {
  if (reason.startsWith('low_trade_quality')) return REJECT.LOW_TRADE_QUALITY;
  switch (reason) {
    case 'duplicate_signal': return REJECT.DUPLICATE_SIGNAL;
    case 'cooldown_active': return REJECT.COOLDOWN_ACTIVE;
    case 'repeated_weak_signal': return REJECT.REPEATED_WEAK_SIGNAL;
    case 'max_symbol_trades_per_hour': return REJECT.MAX_SYMBOL_TRADES_PER_HOUR;
    case 'spread_too_high': return REJECT.SPREAD_TOO_HIGH;
    case 'market_noisy_or_spike': return REJECT.MARKET_NOISY_OR_SPIKE;
    case 'position_already_open': return REJECT.POSITION_ALREADY_OPEN;
    case 'confidence_weak': return REJECT.CONFIDENCE_WEAK;
    case 'no_breakout': return REJECT.NO_BREAKOUT;
    case 'momentum_not_confirmed': return REJECT.MOMENTUM_NOT_CONFIRMED;
    case 'early_exit_locked': return REJECT.EARLY_EXIT_LOCKED;
    case 'no_sell_exit_signal': return REJECT.NO_SELL_EXIT_SIGNAL;
    default: return REJECT.LOW_TRADE_QUALITY;
  }
}

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
  const mode      = modeState.mode;
  if (mode === 'real' || mode === 'testnet') {
    ensureSafeDefaults(exchange);
  }
  const config    = tradeConfig.get(exchange);

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

  // 6a-ter. Upfront SELL min-notional gate (uses cached symbol rules).
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

  const gate     = feGateBlocked(gateKey);
  if (gate.blocked && !isClosingSell) {
    return reject(signal, exchange, mode, REJECT.EXCHANGE_REJECTED,
      `Cooldown active for ${exchange}:${signal.symbol} after ${FE_FAILURE_THRESHOLD} consecutive failures (${Math.ceil(gate.remainingMs/1000)}s remaining).`);
  }
  if (isClosingSell) {
    // Forgive any pending shield cooldown for this exact symbol so the
    // close path is not blocked by an entry-side fail-count.
    clearShieldCooldownFor(exchange, signal.symbol);
  }

  // 6d. Live quote source of truth for every real/testnet attempt.
  let normalizedSymbol = signal.symbol.toUpperCase();
  let pricingPrice = signal.price;
  let priceSource = 'signal_fallback';
  let quoteTimestamp = Date.now();
  try {
    const quote = await apiClient.getPrice(exchange, signal.symbol);
    if (quote.ok) {
      const q = (quote.data as { price?: number }).price ?? 0;
      if (Number.isFinite(q) && q > 0) {
        pricingPrice = q;
        priceSource = 'exchange_live_ticker';
        quoteTimestamp = Date.now();
      }
    }
  } catch {
    /* fallback to signal price */
  }
  try {
    const compl = resolveCompliance(signal.symbol, exchange as ExchangeId);
    if (compl.ok) normalizedSymbol = compl.exchangeSymbol;
  } catch { /* keep default */ }
  if (!(pricingPrice > 0)) {
    return reject(signal, exchange, mode, REJECT.PRICE_UNAVAILABLE, `No live price available for ${signal.symbol}.`);
  }
  if (signal.price > 0) {
    const drift = Math.abs(pricingPrice - signal.price) / signal.price;
    if (drift > MAX_PRICE_DRIFT_RATIO) {
      return reject(
        signal,
        exchange,
        mode,
        REJECT.PRICE_DRIFT_TOO_LARGE,
        `Internal price ${signal.price} drifted ${(drift * 100).toFixed(2)}% from live ${pricingPrice} (max ${(MAX_PRICE_DRIFT_RATIO * 100).toFixed(2)}%).`,
        {
          ...executionPriceFields(signal, pricingPrice, priceSource),
          quoteTimestamp,
        },
      );
    }
  }

  // 6c. Rejection-Prevention Shield — pre-flight gate (compliance + cache + cooldown)
  try {
    const shield = await preflight({
      exchange:    exchange as ExchangeId,
      arenaSymbol: signal.symbol,
      side:        signal.side,
      amountUSD:   config.tradeAmountUSD,
      refPrice:    pricingPrice,
      credentials,
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

  // 8a. Capital protection (real mode only): keep at least 30% cash reserve,
  // never deploy >25% of quote cash in one order, and run at most one active
  // real bot until the fleet proves stable performance.
  if (mode === 'real' && signal.side === 'buy') {
    const reserve = availableQuote * (MIN_CASH_RESERVE_PCT / 100);
    const spendable = Math.max(0, availableQuote - reserve);
    if (spendable < config.tradeAmountUSD) {
      return reject(
        signal,
        exchange,
        mode,
        REJECT.CASH_RESERVE_PROTECTION,
        `Cash reserve protection: keep ${MIN_CASH_RESERVE_PCT}% in ${symbolRules.quoteCurrency ?? 'USDT'} (spendable $${spendable.toFixed(2)}, requested $${config.tradeAmountUSD.toFixed(2)}).`,
      );
    }
    const maxPerOrder = availableQuote * (MAX_CAPITAL_USAGE_PCT / 100);
    if (config.tradeAmountUSD > maxPerOrder) {
      return reject(
        signal,
        exchange,
        mode,
        REJECT.CAPITAL_USAGE_EXCEEDED,
        `Capital usage cap exceeded: requested $${config.tradeAmountUSD.toFixed(2)} > ${MAX_CAPITAL_USAGE_PCT}% of quote balance ($${maxPerOrder.toFixed(2)}).`,
      );
    }
    const fleetCfg = botFleet.get();
    if (fleetCfg.activeRealBots > MAX_ACTIVE_REAL_BOTS) {
      return reject(
        signal,
        exchange,
        mode,
        REJECT.MAX_ACTIVE_REAL_BOTS,
        `Safe mode: max active real bots is ${MAX_ACTIVE_REAL_BOTS}. Current fleet config requests ${fleetCfg.activeRealBots}.`,
      );
    }
  }

  // 8b. Per-bot capital allocation check (Phase 4 — Option 3 fixed cap).
  // Cap = tradeAmountUSD × maxOpenPositions; closing-SELLs are not gated
  // because they REDUCE commitment, not add to it.
  const isClosingSellForAlloc = signal.side === 'sell' && availableBase > 0;
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

  // 9a. Smart scalper decision gate (pre-trade quality + anti-spam + exits).
  let scalperVerdict: ReturnType<typeof evaluateScalperOpportunity> | null = null;
  let scalperSnapshot: SmartScalperSnapshot | undefined;
  try {
    const snapRes = await apiClient.getMarketSnapshot(exchange, signal.symbol);
    if (snapRes.ok) {
      const raw = (snapRes.data as { snapshot?: {
        symbol?: string;
        price?: number;
        timestamp?: number;
        spreadPct?: number;
        candles?: {
          '1m'?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
          '3m'?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
          '5m'?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
        };
      } }).snapshot;
      const toLite = (
        rows: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }> | undefined,
      ) => (rows ?? []).map(c => ({
        time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      scalperSnapshot = {
        symbol: String(raw?.symbol ?? signal.symbol).toUpperCase(),
        price: Number(raw?.price ?? pricingPrice) || pricingPrice,
        timestamp: Number(raw?.timestamp ?? Date.now()) || Date.now(),
        spreadPct: Number(raw?.spreadPct ?? 0) || 0,
        candles: {
          '1m': toLite(raw?.candles?.['1m']),
          '3m': toLite(raw?.candles?.['3m']),
          '5m': toLite(raw?.candles?.['5m']),
        },
      };
    }
  } catch {
    /* snapshot optional */
  }
  if (scalperSnapshot) {
    const symbolHourCount = symbolTradesLastHour(exchange, signal.symbol);
    const baseEntry = getEntryPrice(exchange, baseTk);
    const openedAt = getLastFilledAt(exchange, baseTk);
    scalperVerdict = evaluateScalperOpportunity({
      symbol: signal.symbol,
      side: signal.side,
      signalPrice: pricingPrice,
      notionalUSD: config.tradeAmountUSD,
      confidence: signal.confidence ?? AUTOPILOT_CONFIDENCE_FLOOR,
      snapshot: scalperSnapshot,
      cooldownActive: gate.blocked && !isClosingSell,
      duplicateSignal: recentSignals.includes(signal.id),
      hasOpenPosition: availableBase > 0,
      hourlyTradesOnSymbol: symbolHourCount,
      maxTradesPerSymbolHour: MAX_TRADES_PER_SYMBOL_HOUR,
      weakSignalLoop: weakSignalLoop(exchange, signal.symbol),
      justOpenedAt: openedAt,
      takeProfitPct: config.takeProfitPct > 0 ? config.takeProfitPct : 1.2,
      stopLossPct: config.stopLossPct > 0 ? config.stopLossPct : 0.6,
      trailingStopPct: 0.4,
      positionEntryPrice: baseEntry > 0 ? baseEntry : undefined,
      symbolRulesMinNotional: symbolRules.minNotional,
      recentRejects: signal.botId ? Math.round(botActivityStore.rejectionRate(signal.botId) * 10) : 0,
    });
    if (!scalperVerdict.pass) {
      const rejectCode = toRejectCodeFromScalperReason(scalperVerdict.reason);
      noteSymbolAttempt(exchange, signal.symbol, signal.side, true);
      const d = scalperVerdict.diagnostics;
      return reject(
        signal,
        exchange,
        mode,
        rejectCode,
        `Smart scalper blocked ${signal.side.toUpperCase()} ${signal.symbol}: ${scalperVerdict.reason}`,
        {
          ...executionPriceFields(signal, pricingPrice, priceSource, normalizedSymbol),
          quoteTimestamp,
          finalNotional: config.tradeAmountUSD,
          scalperReason: scalperVerdict.reason,
          scalperConfidence: scalperVerdict.confidence,
          scalperRsi: d.rsi,
          scalperEmaStatus: `${d.emaShortAbovePrice ? 'price>emaS' : 'price<=emaS'} / ${d.emaTrendUp ? 'emaS>emaL' : 'emaS<=emaL'}`,
          scalperVolumeStatus: d.volumeAboveAvg ? 'above_avg' : 'below_avg',
          scalperSpreadPct: scalperSnapshot.spreadPct,
          scalperCooldown: d.cooldownActive,
          scalperSnapshotTs: scalperSnapshot.timestamp,
        },
      );
    }
  }
  noteSymbolAttempt(exchange, signal.symbol, signal.side, false);

  // 9b. Capital protection
  if (signal.side === 'buy') {
    const quoteTotal = availableQuote;
    const keepCash = quoteTotal * (MIN_CASH_RESERVE_PCT / 100);
    const after = quoteTotal - config.tradeAmountUSD;
    if (quoteTotal > 0 && after < keepCash) {
      return reject(
        signal,
        exchange,
        mode,
        REJECT.CASH_RESERVE_PROTECTION,
        `Cash reserve protection: buy would leave ${after.toFixed(2)} USDT below ${(MIN_CASH_RESERVE_PCT).toFixed(0)}% reserve (${keepCash.toFixed(2)}).`,
        {
          ...executionPriceFields(signal, pricingPrice, priceSource, normalizedSymbol),
          quoteTimestamp,
          finalNotional: config.tradeAmountUSD,
        },
      );
    }
    const usage = quoteTotal > 0 ? (config.tradeAmountUSD / quoteTotal) * 100 : 100;
    if (usage > MAX_CAPITAL_USAGE_PCT) {
      return reject(
        signal,
        exchange,
        mode,
        REJECT.CAPITAL_USAGE_EXCEEDED,
        `Capital usage ${usage.toFixed(1)}% exceeds max ${MAX_CAPITAL_USAGE_PCT}% per trade.`,
        {
          ...executionPriceFields(signal, pricingPrice, priceSource, normalizedSymbol),
          quoteTimestamp,
          finalNotional: config.tradeAmountUSD,
        },
      );
    }
    if (openPositionCount >= MAX_ACTIVE_REAL_BOTS) {
      return reject(
        signal,
        exchange,
        mode,
        REJECT.MAX_ACTIVE_REAL_BOTS,
        `Max active real bots (${MAX_ACTIVE_REAL_BOTS}) reached.`,
        {
          ...executionPriceFields(signal, pricingPrice, priceSource, normalizedSymbol),
          quoteTimestamp,
          finalNotional: config.tradeAmountUSD,
        },
      );
    }
  }

  // 9. Risk check
  const risk = validateRisk({
    exchange,
    symbol:           signal.symbol,
    side:             signal.side,
    price:            pricingPrice,
    amountUSD:        config.tradeAmountUSD,
    availableQuote,
    availableBase,
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

  let preflightSnapshot: SmartScalperSnapshot | undefined;
  if (mode === 'real' || mode === 'testnet') {
    try {
      const snapRes = await apiClient.getMarketSnapshot(exchange, signal.symbol);
      if (snapRes.ok) {
        const raw = (snapRes.data as { snapshot?: {
          symbol?: string;
          price?: number;
          timestamp?: number;
          spreadPct?: number;
          candles?: {
            '1m'?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
            '3m'?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
            '5m'?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
          };
        } }).snapshot;
        if (raw) {
          const toLite = (
            rows: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }> | undefined,
          ) => (rows ?? []).map(c => ({
            time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          }));
          preflightSnapshot = {
            symbol: String(raw.symbol ?? signal.symbol).toUpperCase(),
            price: Number(raw.price ?? pricingPrice) || pricingPrice,
            timestamp: Number(raw.timestamp ?? Date.now()) || Date.now(),
            spreadPct: Number(raw.spreadPct ?? 0) || 0,
            candles: {
              '1m': toLite(raw.candles?.['1m']),
              '3m': toLite(raw.candles?.['3m']),
              '5m': toLite(raw.candles?.['5m']),
            },
          };
        }
      }
    } catch {
      preflightSnapshot = undefined;
    }
  }
  const tradesOnSymbolHour = symbolTradesLastHour(exchange, normalizedSymbol);
  const weakLoop = weakSignalLoop(exchange, normalizedSymbol);
  const hasOpenOnSymbol = availableBase > 0;

  if (preflightSnapshot) {
    const scalperResult = evaluateScalperOpportunity({
      symbol: normalizedSymbol,
      side: signal.side,
      signalPrice: pricingPrice,
      notionalUSD: config.tradeAmountUSD,
      confidence: signal.confidence ?? 0,
      snapshot: preflightSnapshot,
      cooldownActive: gate.blocked,
      duplicateSignal: recentSignals.includes(signal.id),
      hasOpenPosition: hasOpenOnSymbol,
      hourlyTradesOnSymbol: tradesOnSymbolHour,
      maxTradesPerSymbolHour: MAX_TRADES_PER_SYMBOL_HOUR,
      weakSignalLoop: weakLoop || hasBuySellLoop(exchange, normalizedSymbol, signal.side),
      justOpenedAt: getLastFilledAt(exchange, baseTk),
      takeProfitPct: config.takeProfitPct,
      stopLossPct: config.stopLossPct,
      trailingStopPct: 0.4,
      positionEntryPrice: getEntryPrice(exchange, baseTk),
      symbolRulesMinNotional: symbolRules.minNotional,
      recentRejects: signal.botId ? Math.round(botActivityStore.rejectionRate(signal.botId) * 10) : 0,
    });
    if (!scalperResult.pass) {
      const code = toRejectCodeFromScalperReason(scalperResult.reason);
      noteSymbolAttempt(exchange, normalizedSymbol, signal.side, true);
      return reject(signal, exchange, mode, code, `Smart scalper blocked: ${scalperResult.reason}`, {
        ...executionPriceFields(signal, pricingPrice, priceSource, normalizedSymbol, quoteTimestamp),
        finalNotional: config.tradeAmountUSD,
        scalperReason: scalperResult.reason,
        scalperConfidence: scalperResult.confidence,
        scalperRsi: scalperResult.diagnostics.rsi,
        scalperEmaStatus: `${scalperResult.diagnostics.emaShortAbovePrice ? 'price>emaS' : 'price<=emaS'}|${scalperResult.diagnostics.emaTrendUp ? 'emaS>emaL' : 'emaS<=emaL'}`,
        scalperVolumeStatus: scalperResult.diagnostics.volumeAboveAvg ? 'volume_above_avg' : 'volume_below_avg',
        scalperSpreadPct: preflightSnapshot.spreadPct,
        scalperCooldown: scalperResult.diagnostics.cooldownActive,
        scalperSnapshotTs: preflightSnapshot.timestamp,
      });
    }
  }

  const pending = executionLog.add({
    mode,
    exchange,
    symbol:    signal.symbol,
    side:      signal.side,
    orderType: config.orderType,
    quantity:  risk.quantity!,
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
    ...executionPriceFields(signal, pricingPrice, priceSource, normalizedSymbol, quoteTimestamp),
    finalNotional: (risk.quantity ?? 0) * (risk.price ?? pricingPrice),
    scalperSpreadPct: preflightSnapshot?.spreadPct,
    scalperSnapshotTs: preflightSnapshot?.timestamp,
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
      executionLog.update(pending.id, {
        status:           'failed',
        errorMsg:         errMsg,
        rejectionDetail:  errMsg,
        latencyMs:        latency,
        exchangeResponse: orderRes,
      });
      feNoteFailure(gateKey);
      noteRejection(exchange, signal.symbol);
      console.error(`[engine][${mode}] Order failed: ${errMsg}`);
      return { ok: false, logId: pending.id, rejectReason: REJECT.EXCHANGE_REJECTED, detail: errMsg };
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
        if (signal.side === 'buy') {
          realProfitStore.recordRealBuy({
            exchange, baseAsset: baseTk,
            qty: risk.quantity!, price: risk.price!,
            botId: signal.botId,
          });
        } else {
          realProfitStore.recordRealSell({
            exchange, baseAsset: baseTk,
            qty: risk.quantity!, price: risk.price!,
            botId: signal.botId, botName: signal.botName,
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
  extras?: Partial<ExecutionEntry>,
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
    ...(extras ?? {}),
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
    noteSymbolAttempt(exchange, signal.symbol, signal.side);
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
      if (signal.botId && botDoctorStore.canDeepAct()) {
        const perBot = realProfitStore.snapshot().perBot[signal.botId];
        const net = perBot ? perBot.realizedPnlUSD - perBot.feesPaidUSD : 0;
        const breakdown = recentRejectBreakdown(signal.botId);
        const stop = evaluateBotStop({
          netPnlUSD: net,
          rejectionRate: rate,
          last10Net: perBot?.last10Net ?? [],
          spamRejectsRecent: breakdown.spamRejectsRecent,
          riskBreakRejectsRecent: breakdown.riskBreakRejectsRecent,
          badEntryRejectsRecent: breakdown.badEntryRejectsRecent,
        });
        if (stop.stop) {
          const why = stop.reasons.join(' | ');
          botDoctorStore.bench(signal.botId, 'underperforming_real', why, 30 * 60_000);
          void maybeReplaceStoppedBot(signal.botId, why);
        }
      }
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
