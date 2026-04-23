// ─── Live Execution Bridge ────────────────────────────────────────────────────
// Pure, testable helpers that connect the three signal sources — bot-engine
// ticks, AutoPilot decisions, and the Manual Order form — to the unified
// Execution Engine (executeSignal). Every UI side effect (toasts, log rows)
// stays at the call site; this module returns plain values so the integration
// chain can be exercised end-to-end in unit tests by mocking executeSignal.

import type { Trade } from './storage.js';
import { ASSET_MAP } from './storage.js';
import { exchangeMode } from './exchange-mode.js';
import { apiClient } from './api-client.js';
import { executeSignal, type Signal, type EngineResult } from './execution-engine.js';
import { executionLog, REJECT } from './execution-log.js';
import { tradeConfig } from './trade-config.js';
import { credentialStore } from './credential-store.js';
import { orderProgress } from './order-progress.js';
import { baseTicker } from './risk-manager.js';
import type { AutoPilotDecision } from './autopilot.js';
import { botFleet, type RemainingMode } from './bot-fleet.js';
import { botActivityStore } from './bot-activity-store.js';

// ── Fleet gate ───────────────────────────────────────────────────────────────
// A bot is allowed to send REAL orders only when it appears in the fleet's
// `realBotIds` allow-list. Bots outside the list are "benched" — the engine
// must NOT submit anything live for them, regardless of the current trading
// mode. The benched mode (paper / standby / disabled) determines the
// rejection wording surfaced in the Execution Log.

interface FleetGateBenched { allowed: false; mode: RemainingMode; message: string }
interface FleetGateAllowed { allowed: true }
type FleetGateResult = FleetGateAllowed | FleetGateBenched;

function checkFleetGate(botId: string): FleetGateResult {
  const cfg = botFleet.get();
  // Empty allow-list (e.g. no bots created yet) is treated as "no gate" so
  // the original behaviour is preserved on first run before the panel ever
  // syncs IDs. Once the user touches the panel or the pipeline runs once,
  // realBotIds will be populated and the gate becomes active.
  if (cfg.realBotIds.length === 0) return { allowed: true };
  if (cfg.realBotIds.includes(botId)) return { allowed: true };
  const activity = botActivityStore.snapshot().bots[botId];
  if (
    activity?.realState === 'real_ineligible' ||
    activity?.realState === 'degraded' ||
    activity?.realState === 'blocked' ||
    activity?.realState === 'benched'
  ) {
    const reasonCode =
      activity.realGateReason === 'rejected_low_profit_after_fees'       ? REJECT.REJECTED_LOW_PROFIT_AFTER_FEES :
      activity.realGateReason === 'rejected_unhealthy_bot'               ? REJECT.REJECTED_UNHEALTHY_BOT :
      activity.realGateReason === 'rejected_high_reject_rate'            ? REJECT.REJECTED_HIGH_REJECT_RATE :
      activity.realGateReason === 'rejected_poor_recent_performance'     ? REJECT.REJECTED_POOR_RECENT_PERFORMANCE :
      activity.realGateReason === 'rejected_market_regime_mismatch'      ? REJECT.REJECTED_MARKET_REGIME_MISMATCH :
                                                                           REJECT.REJECTED_LOWER_RANK_THAN_ACTIVE_BOTS;
    return {
      allowed: false,
      mode: cfg.remainingMode,
      message: `${reasonCode}: Real-mode gate marked this bot ${activity.realState}; real execution is blocked.`,
    };
  }
  const wording =
    cfg.remainingMode === 'standby'  ? 'Bot is in fleet standby — real execution suppressed.' :
    cfg.remainingMode === 'disabled' ? 'Bot is disabled by fleet config — no real orders.'   :
                                       'Bot is paper-only by fleet config — real execution skipped.';
  return { allowed: false, mode: cfg.remainingMode, message: wording };
}

// Dedupe key per (botId, mode, signalSource) so we log one fleet-gate
// rejection per bot per source, not one per tick.
const fleetGateLogged = new Set<string>();

export function __resetFleetGateLog(): void {
  fleetGateLogged.clear();
}

function maybeLogFleetGate(args: {
  source:     'bot' | 'autopilot';
  botId:      string;
  symbol:     string;
  side:       'buy' | 'sell';
  price:      number;
  signalId:   string;
  gate:       FleetGateBenched;
}) {
  const modeState = exchangeMode.get();
  const key = `${args.source}|${args.botId}|${modeState.exchange}|${modeState.mode}|${args.gate.mode}`;
  if (fleetGateLogged.has(key)) return;
  fleetGateLogged.add(key);
  const cfg = tradeConfig.get(modeState.exchange);
  executionLog.add({
    mode:         modeState.mode,
    exchange:     modeState.exchange,
    symbol:       args.symbol,
    side:         args.side,
    orderType:    cfg.orderType,
    quantity:     cfg.tradeAmountUSD / (args.price || 1),
    price:        args.price,
    amountUSD:    cfg.tradeAmountUSD,
    status:       'rejected',
    rejectReason: REJECT.FLEET_GATE_BENCHED,
    errorMsg:     args.gate.message,
    signalId:     args.signalId,
  });
}

// ── Mode helpers ─────────────────────────────────────────────────────────────

export type LiveMode = 'real' | 'testnet';

export function isLiveTradingMode(mode: string): mode is LiveMode {
  return mode === 'real' || mode === 'testnet';
}

export function isCryptoSymbol(symbol: string): boolean {
  // Tolerant lookup so signals carrying the connected exchange's
  // quote-suffixed pair (e.g. `BTCUSDT`, `BTC-USD`, `BTCUSDC`) resolve to
  // the same crypto entry as the bare ticker (`BTC`). Without this, a
  // signal that already came back from the exchange in its native pair
  // form would be falsely rejected as non-crypto.
  if (ASSET_MAP[symbol]?.category === 'Crypto') return true;
  const base = baseTicker(symbol);
  return ASSET_MAP[base]?.category === 'Crypto';
}

// Tracks which (mode, exchange, symbol, side) combos we've already
// explained-and-rejected for the bot tick path, so we log one clear
// "asset class not supported" entry per combo instead of spamming the
// Execution Log on every bot tick. Switching exchange or mode (e.g.
// real → testnet, or binance → coinbase) yields fresh entries because
// operational context changed.
const warnedUnsupportedCombos = new Set<string>();

// Test-only escape hatch so unit tests can reset the dedupe state between
// cases without leaking it into production code paths.
export function __resetUnsupportedAssetWarnings(): void {
  warnedUnsupportedCombos.clear();
}

// ── 1. Bot tick → engine ─────────────────────────────────────────────────────
// Mirror a bot-engine Trade to the live Execution Engine when in real/testnet.
// Crypto symbols are forwarded to executeSignal. Stocks/metals/forex are
// explicitly logged as rejected (one entry per mode+exchange+symbol+side
// combo) so the user can see in the Execution Log why their AAPL/GOLD/EURUSD
// bot didn't place a real order, instead of AutoPilot looking like it
// silently behaves like demo. Returns the Promise<EngineResult> when
// dispatched, or null when skipped, so callers and tests can both observe
// the outcome without re-deriving the rules.

export function bridgeBotTradeToExchange(trade: Trade): Promise<EngineResult> | null {
  const modeState = exchangeMode.get();
  const mode = modeState.mode;
  if (!isLiveTradingMode(mode)) return null;

  if (!isCryptoSymbol(trade.symbol)) {
    const exchange = modeState.exchange;
    const side: 'buy' | 'sell' = trade.type === 'BUY' ? 'buy' : 'sell';
    const dedupeKey = `${mode}|${exchange}|${trade.symbol}|${side}`;
    if (!warnedUnsupportedCombos.has(dedupeKey)) {
      warnedUnsupportedCombos.add(dedupeKey);
      const cfg = tradeConfig.get(exchange);
      const category = ASSET_MAP[trade.symbol]?.category ?? 'Unknown';
      executionLog.add({
        mode,
        exchange,
        symbol:    trade.symbol,
        side,
        orderType: cfg.orderType,
        quantity:  cfg.tradeAmountUSD / (trade.price || 1),
        price:     trade.price,
        amountUSD: cfg.tradeAmountUSD,
        status:    'rejected',
        rejectReason: REJECT.UNSUPPORTED_ASSET,
        errorMsg: `${category} symbol ${trade.symbol} cannot be traded on ${exchange} (crypto-only exchange). Bot signal ignored in ${mode} mode.`,
        signalId: `bot_${trade.id}`,
      });
      console.warn(
        `[arena→engine][${mode}] ${trade.type} ${trade.symbol} skipped — ${category} not supported on ${exchange}.`,
      );
    }
    return null;
  }

  // Fleet gate: bots not in the real-bot allow-list must NOT submit live
  // orders even when the trade fully passes the live-mode + crypto filter.
  const gate = checkFleetGate(trade.botId);
  if (!gate.allowed) {
    maybeLogFleetGate({
      source:   'bot',
      botId:    trade.botId,
      symbol:   trade.symbol,
      side:     trade.type === 'BUY' ? 'buy' : 'sell',
      price:    trade.price,
      signalId: `bot_${trade.id}`,
      gate,
    });
    return null;
  }

  const signal: Signal = {
    id:     `bot_${trade.id}`,
    symbol: trade.symbol,
    side:   trade.type === 'BUY' ? 'buy' : 'sell',
    price:  trade.price,
    ts:     trade.timestamp,
    source: 'bot-engine',
    botId:  trade.botId,
    // A bot SELL is always an exit decision — close the FULL owned
    // position so we never leave a price-appreciation residual that
    // would later sit below minNotional as un-sellable dust.
    ...(trade.type === 'SELL' ? { closeAll: true } : {}),
  };
  return executeSignal(signal);
}

// ── 2. AutoPilot decision → engine ───────────────────────────────────────────
// Encapsulates the dedupe-by-(botId, action) latch so the engine is invoked
// exactly once per BUY/SELL transition while the decision stays the same on
// the next 5-second cycle. HOLD always clears the latch (signalled via
// `reset`) so the next BUY/SELL fires. For non-crypto symbols in live mode
// we also write an explicit `rejected` row to the Execution Log (and latch
// it) so the user sees why their AAPL/GOLD/EURUSD signal was ignored
// instead of AutoPilot silently doing nothing.

export interface AutoPilotDispatchKey {
  botId:  string;
  action: 'BUY' | 'SELL';
}

export interface AutoPilotDispatchOutcome {
  dispatched: boolean;
  signal:     Signal | null;
  newLast:    AutoPilotDispatchKey | null;
  result:     EngineResult | null;
  reset?:     boolean;     // caller should clear its latch (HOLD path)
  reason?:    'not-actionable' | 'not-live' | 'not-crypto' | 'duplicate';
}

export async function dispatchAutoPilotLiveSignal(args: {
  decision:        AutoPilotDecision;
  lastDispatch:    AutoPilotDispatchKey | null;
  getCurrentPrice: (sym: string) => number;
}): Promise<AutoPilotDispatchOutcome> {
  const { decision: d, lastDispatch, getCurrentPrice } = args;

  if (!d.selectedBot || (d.masterAction !== 'BUY' && d.masterAction !== 'SELL')) {
    // HOLD / no bot — clear latch so the next BUY/SELL fires.
    return { dispatched: false, signal: null, newLast: null, result: null, reset: true, reason: 'not-actionable' };
  }

  const sym       = d.selectedBot.bot.symbol;
  const modeState = exchangeMode.get();
  const mode      = modeState.mode;

  if (!isLiveTradingMode(mode)) {
    return { dispatched: false, signal: null, newLast: lastDispatch, result: null, reason: 'not-live' };
  }

  const sig: AutoPilotDispatchKey = { botId: d.selectedBot.bot.id, action: d.masterAction };
  const transitioned = !lastDispatch || lastDispatch.botId !== sig.botId || lastDispatch.action !== sig.action;

  if (!isCryptoSymbol(sym)) {
    // Non-crypto symbol on a crypto-only exchange: explicitly reject so the
    // user sees why their signal didn't become a real order. Latch on this
    // outcome too so we don't repeat the rejection on every 5s cycle for
    // the same (bot, action) pair.
    if (transitioned) {
      const exchange = modeState.exchange;
      const cfg      = tradeConfig.get(exchange);
      const category = ASSET_MAP[sym]?.category ?? 'Unknown';
      const price    = getCurrentPrice(sym);
      executionLog.add({
        mode,
        exchange,
        symbol:    sym,
        side:      sig.action === 'BUY' ? 'buy' : 'sell',
        orderType: cfg.orderType,
        quantity:  cfg.tradeAmountUSD / (price || 1),
        price,
        amountUSD: cfg.tradeAmountUSD,
        status:    'rejected',
        rejectReason: REJECT.UNSUPPORTED_ASSET,
        errorMsg:  `${category} symbol ${sym} cannot be traded on ${exchange} (crypto-only exchange).`,
        signalId:  `autopilot_${sig.botId}_${sig.action}`,
      });
    }
    return {
      dispatched: false,
      signal:     null,
      newLast:    sig,        // latch so we don't spam the rejection
      result:     null,
      reason:     'not-crypto',
    };
  }

  // Fleet gate: AutoPilot may have selected a bot that is not in the real-bot
  // allow-list. Refuse to dispatch and latch so we don't rejection-spam every
  // 5-second decision cycle.
  const gate = checkFleetGate(sig.botId);
  if (!gate.allowed) {
    if (transitioned) {
      const price = getCurrentPrice(sym);
      maybeLogFleetGate({
        source:   'autopilot',
        botId:    sig.botId,
        symbol:   sym,
        side:     sig.action === 'BUY' ? 'buy' : 'sell',
        price,
        signalId: `autopilot_${sig.botId}_${sig.action}`,
        gate,
      });
    }
    return { dispatched: false, signal: null, newLast: sig, result: null, reason: 'not-actionable' };
  }

  if (!transitioned) {
    return { dispatched: false, signal: null, newLast: lastDispatch, result: null, reason: 'duplicate' };
  }

  const price = getCurrentPrice(sym);
  // Wire AutoPilot's per-bot composite confidence (0..95, derived from
  // realized PnL + win rate + drawdown + recency in autopilot.scoreBot)
  // through to the trade-quality gate. Without this the gate evaluates
  // every AutoPilot signal at the neutral default 0.7, so a bot scoring
  // 92% gets the same quality weighting as one scoring 35% — defeating
  // the point of the composite-quality preflight.
  const signal: Signal = {
    id:         `autopilot_${sig.botId}_${sig.action}_${Date.now()}`,
    symbol:     sym,
    side:       sig.action === 'BUY' ? 'buy' : 'sell',
    price,
    ts:         Date.now(),
    source:     'autopilot',
    botId:      sig.botId,
    botName:    d.selectedBot.bot.name,
    confidence: d.selectedBot.confidence,
    // AutoPilot SELLs are always position exits — close the full owned
    // base balance so we never leave a residual fragment behind that
    // would later become dust below the venue's minNotional.
    ...(sig.action === 'SELL' ? { closeAll: true } : {}),
  };
  const result = await executeSignal(signal);

  // Begin tracking the live fill so the Live Status tab shows real
  // Submitting → Pending → Filled progress (qty / avg price / partials)
  // instead of users only seeing a single toast + log row.
  if (result.ok && result.orderId) {
    const exId = modeState.exchange;
    const key  = `autopilot:${result.orderId}`;
    orderProgress.start({
      key, source: 'autopilot', exchange: exId, symbol: sym,
      side: signal.side, label: `AutoPilot ${signal.side.toUpperCase()} ${sym}`,
    });
    orderProgress.update(key, { orderId: result.orderId, phase: 'pending' });
    const looksReal = !result.orderId.startsWith('demo_') && !result.orderId.startsWith('paper_');
    const creds     = credentialStore.get(exId);
    if (looksReal && creds) {
      orderProgress.poll({
        key, orderId: result.orderId, exchange: exId, symbol: sym, creds,
      });
    } else {
      orderProgress.update(key, { phase: 'filled' });
    }
  }

  return {
    dispatched: true,
    signal,
    // Only latch on success — failed attempts (e.g. transient not-armed)
    // should not block a retry on the next decision cycle.
    newLast:    result.ok ? sig : lastDispatch,
    result,
  };
}

// ── 3. Manual Order form → engine ────────────────────────────────────────────
// Resolve a reference price (override or apiClient.getPrice), refuse to size
// a live order from a placeholder, then submit through executeSignal. Returns
// the same `{ ok, message }` shape the form renders into the inline result
// banner so the UI mapping is trivially testable.

export interface ManualOrderInput {
  exchangeId:    string;
  exchangeName:  string;
  symbol:        string;
  side:          'buy' | 'sell';
  priceOverride: string;
  mode:          string;
}

export interface ManualOrderOutcome {
  ok:      boolean;
  message: string;
  signal?: Signal;
  result?: EngineResult;
}

export async function submitManualOrder(input: ManualOrderInput): Promise<ManualOrderOutcome> {
  const { exchangeId, exchangeName, symbol, side, priceOverride, mode } = input;

  // Reject non-crypto tickers up front in live modes so users get a clear
  // `unsupported_asset_class` instead of a downstream exchange error like
  // "symbol not whitelisted". Paper/demo still let them simulate any
  // ticker so the rest of the simulator UX is unchanged.
  const liveMode = mode === 'real' || mode === 'testnet';
  if (liveMode && !isCryptoSymbol(symbol)) {
    return {
      ok: false,
      message: `unsupported_asset_class — ${symbol} is not a crypto asset supported on ${exchangeName}.`,
    };
  }

  let price = Number(priceOverride) || 0;
  if (price <= 0) {
    try {
      const pr = await apiClient.getPrice(exchangeId, symbol);
      if (pr.ok) {
        price = Number((pr.data as { price?: number }).price) || 0;
      }
    } catch { /* fall through to live-mode guard / demo fallback */ }
  }

  const isLive = mode === 'real' || mode === 'testnet';
  if (price <= 0) {
    if (isLive) {
      return {
        ok: false,
        message: `Cannot resolve a live price for ${symbol} on ${exchangeName}. Enter a reference price or retry once the exchange responds — refusing to size a live order from a placeholder.`,
      };
    }
    price = 1; // demo / paper fallback only
  }

  const signal: Signal = {
    id:     `manual_${side}_${symbol}_${Date.now()}`,
    symbol,
    side,
    price,
    ts:     Date.now(),
    source: 'manual',
  };
  const res = await executeSignal(signal);

  if (res.ok) {
    const message = res.demo
      ? `Simulated ${side.toUpperCase()} ${symbol} logged.`
      : `Live ${side.toUpperCase()} ${symbol} placed — orderId ${res.orderId ?? '—'}`;
    return { ok: true, message, signal, result: res };
  }
  const message = `${res.rejectReason ?? 'Rejected'}${res.detail ? ' — ' + res.detail : ''}`;
  return { ok: false, message, signal, result: res };
}
