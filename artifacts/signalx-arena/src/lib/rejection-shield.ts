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

export type ShieldOutcome = 'pass' | 'block' | 'warn';

export interface ShieldInput {
  exchange:    ExchangeId;
  arenaSymbol: string;
  side:        'buy' | 'sell';
  amountUSD:   number;
  refPrice:    number;
  credentials?: ExchangeCredentials | null;
  forceRefresh?: boolean;
}

export interface ShieldVerdict {
  outcome:        ShieldOutcome;
  reason:         string;
  exchangeSymbol: string;
  category:       string;
  rules?:         SymbolRules;
  estimatedQty:   number;
  notional:       number;
  cooldownMs:     number;
  checks:         Array<{ id: string; ok: boolean; detail: string }>;
  checkedAt:      number;
}

interface RejectMemory { fails: number; lastFailAt: number; cooldownUntil: number }
const MEMORY = new Map<string, RejectMemory>();
const COOLDOWN_MS = 5 * 60_000;
const FAIL_THRESHOLD = 2;
function memKey(ex: string, sym: string) { return `${ex}:${sym}`; }

export function noteRejection(exchange: string, exchangeSymbol: string) {
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
    return {
      outcome: 'block',
      reason:  compliance.reason ?? `Asset not tradable on ${input.exchange}.`,
      exchangeSymbol: compliance.exchangeSymbol,
      category: compliance.category,
      estimatedQty: 0, notional: 0, cooldownMs: 0,
      checks, checkedAt: Date.now(),
    };
  }

  // Cooldown memory
  const mem = MEMORY.get(memKey(input.exchange, compliance.exchangeSymbol));
  if (mem && mem.cooldownUntil > Date.now()) {
    const remain = mem.cooldownUntil - Date.now();
    checks.push({ id: 'cooldown', ok: false, detail: `Symbol on cooldown (${Math.ceil(remain/1000)}s left after ${mem.fails} fails).` });
    return {
      outcome: 'block',
      reason:  `Cooldown active for ${compliance.exchangeSymbol}.`,
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

  if (rules) {
    if (estQty < rules.minQty) {
      checks.push({ id: 'minQty', ok: false, detail: `Qty ${estQty.toFixed(6)} < minQty ${rules.minQty}` });
      return finalize('block', `Trade size below exchange minQty (${rules.minQty}).`, compliance, rules, estQty, notional, checks);
    }
    if (rules.minNotional > 0 && notional < rules.minNotional) {
      checks.push({ id: 'minNotional', ok: false, detail: `Notional $${notional.toFixed(2)} < $${rules.minNotional}` });
      return finalize('block', `Trade size $${notional.toFixed(2)} below minNotional $${rules.minNotional}.`, compliance, rules, estQty, notional, checks);
    }
    checks.push({ id: 'minNotional', ok: true, detail: `Notional $${notional.toFixed(2)} OK.` });
  }

  // Side-aware balance peek (best-effort — do not hard-block on errors)
  if (input.credentials && rules) {
    const needed  = input.side === 'buy' ? notional * 1.01 : estQty;
    const asset   = input.side === 'buy' ? (rules.quoteCurrency ?? 'USDT') : (rules.baseCurrency ?? compliance.base);
    const have    = await fetchAvailable(input.exchange, asset, input.credentials);
    if (have !== undefined) {
      if (have < needed) {
        checks.push({ id: 'balance', ok: false, detail: `Need ${needed.toFixed(4)} ${asset}, have ${have.toFixed(4)}` });
        return finalize('warn', `Insufficient ${asset} on exchange (need ${needed.toFixed(4)}).`, compliance, rules, estQty, notional, checks);
      }
      checks.push({ id: 'balance', ok: true, detail: `${have.toFixed(4)} ${asset} available.` });
    }
  }

  return finalize('pass', 'All pre-flight checks passed.', compliance, rules, estQty, notional, checks);
}

function finalize(
  outcome: ShieldOutcome, reason: string,
  compliance: ReturnType<typeof resolveCompliance>,
  rules: SymbolRules | undefined,
  estQty: number, notional: number,
  checks: ShieldVerdict['checks'],
): ShieldVerdict {
  return {
    outcome, reason,
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
