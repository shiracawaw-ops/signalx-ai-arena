// ─── Rejection Prevention Shield (System #4) ──────────────────────────────────
// Pre-flight gate that runs BEFORE the execution engine actually contacts the
// exchange.  It combines:
//   • Compliance  (asset/exchange fit)
//   • Symbol rules (cached) — minNotional, stepSize, lot bounds
//   • Side-aware balance peek
//   • Recent rejection memory (5-min cooldown per symbol after 2 fails)
//
// Returns a verdict the UI / engine can act on without touching the wire.

import { apiClient } from './api-client';
import type { ExchangeCredentials } from './exchange-mode';
import { resolveCompliance, type ExchangeId } from './asset-compliance';
import { pipelineCache, TTL } from './pipeline-cache';
import type { SymbolRules } from './risk-manager';
import { baseTicker } from './risk-manager';
import { getOwned } from './internal-positions';
import { scoreTradeQuality, type TradeQualityVerdict } from './trade-quality';

export type ShieldOutcome = 'pass' | 'block' | 'warn';

export interface ShieldInput {
  exchange:    ExchangeId;
  arenaSymbol: string;
  side:        'buy' | 'sell';
  amountUSD:   number;
  refPrice:    number;
  credentials?: ExchangeCredentials | null;
  forceRefresh?: boolean;
  /** ms since the originating signal was generated. Used by the trade-quality
   *  gate to penalise stale prices. Defaults to 0 (treated as fresh). */
  signalAgeMs?: number;
  /** Optional caller-supplied confidence 0..100 for the quality gate. */
  confidence?: number;
  /** Optional caller-supplied expected edge in bps for the quality gate.
   *  When supplied and below the round-trip fee cost the gate vetoes. */
  expectedEdgeBps?: number;
  /** Optional free quote balance available for the intended order path. */
  freeQuoteBalance?: number;
  /** Optional free base balance available for sell path. */
  freeBaseBalance?: number;
  /** Optional reserve to keep aside for fees. */
  feeReserveUSD?: number;
  /** Optional reserve to keep aside as safety cushion. */
  safetyReserveUSD?: number;
  /** Optional strict max-daily trade gate details. */
  maxDailyTrades?: number;
  usedDailyTrades?: number;
}

/**
 * Categorized block reason. Maps 1:1 onto the operator-facing `REJECT.*` codes
 * in execution-log so the engine never has to surface a generic "symbol_blocked"
 * to the UI again — the operator can see the exact root cause.
 */
export type ShieldBlockCode =
  | 'symbol_not_found'
  | 'symbol_inactive'
  | 'symbol_mapping_failed'
  | 'symbol_temporarily_locked'
  | 'exchange_restriction'
  | 'stale_cache_conflict'
  | 'below_min_notional'
  | 'invalid_order_size'
  | 'insufficient_balance'
  | 'cooldown_active'
  | 'low_trade_quality'
  | 'edge_below_fees';

export interface ShieldVerdict {
  outcome:        ShieldOutcome;
  reason:         string;
  exchangeSymbol: string;
  category:       string;
  blockCode?:     ShieldBlockCode;     // present when outcome !== 'pass'
  rules?:         SymbolRules;
  estimatedQty:   number;
  notional:       number;
  cooldownMs:     number;
  checks:         Array<{ id: string; ok: boolean; detail: string }>;
  checkedAt:      number;
  /** Composite trade-quality verdict, populated for buy-side preflights
   *  whenever symbol rules are available. Closing-sells skip the gate. */
  quality?:       TradeQualityVerdict;
}

interface RejectMemory { fails: number; lastFailAt: number; cooldownUntil: number }
const MEMORY = new Map<string, RejectMemory>();
// 90s cooldown (was 5 min). Long enough to back off, short enough that a
// transient mapping issue does not freeze a symbol for a whole session.
const COOLDOWN_MS = 90_000;
const FAIL_THRESHOLD = 2;
// Drop entries older than this so stale fail-counts can never compound into
// a permanent block. Anything not touched in 10 min is cleared next access.
const MEMORY_TTL_MS = 10 * 60_000;
function memKey(ex: string, sym: string) { return `${ex}:${sym}`; }

function gcMemory() {
  const now = Date.now();
  MEMORY.forEach((v, k) => {
    if (v.cooldownUntil <= now && now - v.lastFailAt > MEMORY_TTL_MS) {
      MEMORY.delete(k);
    }
  });
}

export function noteRejection(exchange: string, exchangeSymbol: string) {
  gcMemory();
  const k = memKey(exchange, exchangeSymbol);
  const m = MEMORY.get(k) ?? { fails: 0, lastFailAt: 0, cooldownUntil: 0 };
  m.fails += 1;
  m.lastFailAt = Date.now();
  if (m.fails >= FAIL_THRESHOLD) m.cooldownUntil = Date.now() + COOLDOWN_MS;
  MEMORY.set(k, m);
}

export function noteSuccess(exchange: string, exchangeSymbol: string) {
  MEMORY.delete(memKey(exchange, exchangeSymbol));
}

/** Manually clear all cooldown memory (used by the diagnostics "Clear locks" button). */
export function clearShieldMemory(): void {
  MEMORY.clear();
}

/** Clear cooldown for a single exchange:symbol — used by closing-sell path. */
export function clearShieldCooldownFor(exchange: string, arenaOrExchangeSymbol: string): void {
  const direct = memKey(exchange, arenaOrExchangeSymbol);
  if (MEMORY.has(direct)) MEMORY.delete(direct);
  // Also try the exchange-resolved variant (mapping is symmetric in practice).
  const compl = resolveCompliance(arenaOrExchangeSymbol, exchange as ExchangeId);
  if (compl.exchangeSymbol) MEMORY.delete(memKey(exchange, compl.exchangeSymbol));
}

async function fetchRules(exchange: string, exchangeSymbol: string, creds: ExchangeCredentials | null | undefined): Promise<SymbolRules | undefined> {
  if (!creds) return undefined;
  const key = `rules:${exchange}:${exchangeSymbol}`;
  return pipelineCache.memoize(key, TTL.SYMBOL_RULES, async () => {
    const res = await apiClient.getSymbolRules(exchange, creds, exchangeSymbol);
    if (res.ok) return (res.data as { rules: SymbolRules }).rules;
    return {
      symbol: exchangeSymbol, minQty: 0.00001, maxQty: 9_000_000, stepSize: 0.00001,
      minNotional: 5, tickSize: 0.01, filterSource: 'stub',
    };
  });
}

async function fetchAvailable(exchange: string, asset: string, creds: ExchangeCredentials | null | undefined): Promise<number | undefined> {
  if (!creds) return undefined;
  const key = `bal:${exchange}:${asset}`;
  return pipelineCache.memoize(key, 5_000, async () => {
    const res = await apiClient.getBalances(exchange, creds);
    if (!res.ok) return 0;
    const list = (res.data as { balances: Array<{ asset: string; available: number }> }).balances;
    return list.find(b => b.asset.toUpperCase() === asset.toUpperCase())?.available ?? 0;
  });
}

export async function preflight(input: ShieldInput): Promise<ShieldVerdict> {
  const checks: ShieldVerdict['checks'] = [];
  const compliance = resolveCompliance(input.arenaSymbol, input.exchange);

  checks.push({
    id: 'compliance',
    ok: compliance.ok,
    detail: compliance.ok
      ? `${input.arenaSymbol} → ${compliance.exchangeSymbol}`
      : (compliance.reason ?? 'Asset not supported'),
  });
  if (!compliance.ok) {
    // Distinguish between "wrong exchange for this asset class" (restriction)
    // and "this base ticker is not in our catalog at all" (mapping failure).
    const reasonText = compliance.reason ?? `Asset not tradable on ${input.exchange}.`;
    const isMapping  = /not in the catalog/i.test(reasonText);
    const code: ShieldBlockCode = isMapping ? 'symbol_mapping_failed' : 'exchange_restriction';
    return {
      outcome: 'block',
      reason:  reasonText,
      blockCode: code,
      exchangeSymbol: compliance.exchangeSymbol,
      category: compliance.category,
      estimatedQty: 0, notional: 0, cooldownMs: 0,
      checks, checkedAt: Date.now(),
    };
  }

  // ── Closing-sell bypass ──────────────────────────────────────────────────
  // If we already own the base asset (per local ledger), this is a CLOSE.
  // Closes must never be blocked by entry-side guards: cooldown, min-notional
  // for the requested USD amount, or balance pre-checks. The exchange and the
  // risk manager will still cap the qty to what's actually owned.
  const ownedBase   = getOwned(input.exchange, baseTicker(input.arenaSymbol));
  const isClosingSell = input.side === 'sell' && ownedBase > 0;

  // Cooldown memory
  const mem = MEMORY.get(memKey(input.exchange, compliance.exchangeSymbol));
  if (!isClosingSell && mem && mem.cooldownUntil > Date.now()) {
    const remain = mem.cooldownUntil - Date.now();
    checks.push({ id: 'cooldown', ok: false, detail: `Symbol on cooldown (${Math.ceil(remain/1000)}s left after ${mem.fails} fails).` });
    return {
      outcome: 'block',
      reason:  `Cooldown active for ${compliance.exchangeSymbol}.`,
      blockCode: 'symbol_temporarily_locked',
      exchangeSymbol: compliance.exchangeSymbol,
      category: compliance.category,
      estimatedQty: 0, notional: 0, cooldownMs: remain,
      checks, checkedAt: Date.now(),
    };
  }
  checks.push({ id: 'cooldown', ok: true, detail: 'No active cooldown.' });

  // Symbol rules
  const rules = await fetchRules(input.exchange, compliance.exchangeSymbol, input.credentials);
  if (!rules) {
    checks.push({ id: 'rules', ok: true, detail: 'Skipped (no credentials provided).' });
  } else {
    checks.push({ id: 'rules', ok: true,
      detail: `minNotional=${rules.minNotional} stepSize=${rules.stepSize} (${rules.filterSource})` });
  }

  const price = input.refPrice > 0 ? input.refPrice : 1;
  const estQty = input.amountUSD / price;
  const notional = estQty * price;

  if (rules && !isClosingSell) {
    if (estQty < rules.minQty) {
      checks.push({ id: 'minQty', ok: false, detail: `Qty ${estQty.toFixed(6)} < minQty ${rules.minQty}` });
      return finalize('block', `Trade size below exchange minQty (${rules.minQty}).`, compliance, rules, estQty, notional, checks, 'invalid_order_size');
    }
    if (rules.minNotional > 0 && notional < rules.minNotional) {
      checks.push({ id: 'minNotional', ok: false, detail: `Notional $${notional.toFixed(2)} < $${rules.minNotional}` });
      return finalize('block', `Trade size $${notional.toFixed(2)} below minNotional $${rules.minNotional}.`, compliance, rules, estQty, notional, checks, 'below_min_notional');
    }
    checks.push({ id: 'minNotional', ok: true, detail: `Notional $${notional.toFixed(2)} OK.` });
  } else if (isClosingSell) {
    checks.push({ id: 'closingSell', ok: true, detail: `Closing sell — bypassing entry-side size checks (owned ${ownedBase}).` });
  }

  // ── Composite trade-quality gate (entries only) ──────────────────────────
  // Phase 2/3 of the profitability brief: stop low-edge entries that either
  //   • cannot exit cleanly after fees (veto), or
  //   • score below the composite quality floor.
  // Closing-sells must never be gated by entry-side quality — they have a
  // dedicated upfront SELL min-notional gate in the execution engine.
  let qualityVerdict: TradeQualityVerdict | undefined;
  if (!isClosingSell && input.side === 'buy') {
    const memEntry = MEMORY.get(memKey(input.exchange, compliance.exchangeSymbol));
    qualityVerdict = scoreTradeQuality({
      notional,
      refPrice:        price,
      signalAgeMs:     input.signalAgeMs ?? 0,
      rules,
      recentFails:     memEntry?.fails ?? 0,
      expectedEdgeBps: input.expectedEdgeBps,
      confidence:      input.confidence,
      exchange:        input.exchange,
    });
    checks.push({
      id:     'tradeQuality',
      ok:     qualityVerdict.pass,
      detail: `score ${qualityVerdict.score.toFixed(2)} / floor ${qualityVerdict.floor} — ${qualityVerdict.reason}`,
    });
    if (!qualityVerdict.pass) {
      // An "edge_below_fees" or "exit notional won't clear minNotional"
      // veto is a stronger signal than just a low composite — surface a
      // dedicated block code so the operator/UI can show the right copy.
      const isFeeVeto = qualityVerdict.vetoes.some(v =>
        /round-trip cost|exit notional|after fees/i.test(v));
      const code: ShieldBlockCode = isFeeVeto ? 'edge_below_fees' : 'low_trade_quality';
      const verdict = finalize('block', `Trade quality: ${qualityVerdict.reason}`,
        compliance, rules, estQty, notional, checks, code);
      verdict.quality = qualityVerdict;
      return verdict;
    }
  }

  // Side-aware balance peek (best-effort — do not hard-block on errors)
  // For closing-sells we trust the local ledger and let the engine's risk
  // manager clamp qty to owned amount; skip exchange balance check here.
  if (input.credentials && rules && !isClosingSell) {
    const needed  = input.side === 'buy' ? notional * 1.01 : estQty;
    const asset   = input.side === 'buy' ? (rules.quoteCurrency ?? 'USDT') : (rules.baseCurrency ?? compliance.base);
    let have: number | undefined;
    if (input.side === 'buy' && input.freeQuoteBalance !== undefined) {
      have = Math.max(0, input.freeQuoteBalance - (input.feeReserveUSD ?? 0) - (input.safetyReserveUSD ?? 0));
    } else if (input.side === 'sell' && input.freeBaseBalance !== undefined) {
      have = input.freeBaseBalance;
    } else {
      have = await fetchAvailable(input.exchange, asset, input.credentials);
    }
    if (have !== undefined) {
      if (have < needed) {
        checks.push({ id: 'balance', ok: false, detail: `Need ${needed.toFixed(4)} ${asset}, have ${have.toFixed(4)}` });
        return finalize('warn', `Insufficient ${asset} on exchange (need ${needed.toFixed(4)}).`, compliance, rules, estQty, notional, checks, 'insufficient_balance');
      }
      checks.push({ id: 'balance', ok: true, detail: `${have.toFixed(4)} ${asset} available.` });
    }
  }

  // Strict final block when daily trade limit has already been consumed.
  if (
    input.maxDailyTrades !== undefined &&
    input.maxDailyTrades > 0 &&
    input.usedDailyTrades !== undefined &&
    input.usedDailyTrades >= input.maxDailyTrades
  ) {
    checks.push({
      id: 'maxDailyTrades',
      ok: false,
      detail: `Used ${input.usedDailyTrades}/${input.maxDailyTrades} trades today.`,
    });
    return finalize(
      'block',
      `Max daily trades reached (${input.usedDailyTrades}/${input.maxDailyTrades}).`,
      compliance,
      rules,
      estQty,
      notional,
      checks,
      'cooldown_active',
    );
  }

  const passVerdict = finalize('pass', 'All pre-flight checks passed.', compliance, rules, estQty, notional, checks);
  if (qualityVerdict) passVerdict.quality = qualityVerdict;
  return passVerdict;
}

function finalize(
  outcome: ShieldOutcome, reason: string,
  compliance: ReturnType<typeof resolveCompliance>,
  rules: SymbolRules | undefined,
  estQty: number, notional: number,
  checks: ShieldVerdict['checks'],
  blockCode?: ShieldBlockCode,
): ShieldVerdict {
  return {
    outcome, reason,
    ...(blockCode ? { blockCode } : {}),
    exchangeSymbol: compliance.exchangeSymbol,
    category:       compliance.category,
    ...(rules ? { rules } : {}),
    estimatedQty: estQty,
    notional,
    cooldownMs: 0,
    checks,
    checkedAt: Date.now(),
  };
}

export function shieldStats() {
  const now = Date.now();
  const items: Array<{ key: string; fails: number; cooldownLeftMs: number }> = [];
  MEMORY.forEach((v, k) => {
    items.push({ key: k, fails: v.fails, cooldownLeftMs: Math.max(0, v.cooldownUntil - now) });
  });
  return { total: items.length, items };
}
