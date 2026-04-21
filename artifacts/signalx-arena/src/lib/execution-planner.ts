// ─── Smart Execution Planner (System #6) ──────────────────────────────────────
// Turns a high-level intent ("buy SOL with $250") into a concrete plan
// that the rejection shield + execution engine can run safely.
//
// Considers:
//   • Compliance      → exchange-side symbol & quote
//   • Liquidity hint  → splits large notional into smaller child orders
//   • Order type      → market vs limit (price-buffer aware)
//   • Latency         → recommended max round-trip and retry-after
//   • Diagnostics tag → unique plan ID propagates to logs

import { resolveCompliance, type ExchangeId } from './asset-compliance';

export type PlannerOrderType = 'market' | 'limit';

export interface PlanInput {
  exchange:     ExchangeId;
  arenaSymbol:  string;
  side:         'buy' | 'sell';
  amountUSD:    number;
  refPrice:     number;            // last known price
  preferredType?: PlannerOrderType;
  maxSlippagePct?: number;         // default 0.5% market, 0% limit
  splitThresholdUSD?: number;      // notional above which we shard (default $5k)
}

export interface ChildOrder {
  index:    number;
  symbol:   string;
  side:     'buy' | 'sell';
  type:     PlannerOrderType;
  amountUSD:number;
  price?:   number;          // limit only
  notes:    string;
}

export interface ExecutionPlan {
  planId:        string;
  exchange:      ExchangeId;
  arenaSymbol:   string;
  exchangeSymbol:string;
  ok:            boolean;
  reason?:       string;
  side:          'buy' | 'sell';
  totalUSD:      number;
  refPrice:      number;
  effectivePrice:number;
  type:          PlannerOrderType;
  children:      ChildOrder[];
  expectedSlippagePct: number;
  retryAfterMs:  number;
  createdAt:     number;
}

const PLAN_PREFIX = 'plan_';
function newPlanId() { return `${PLAN_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`; }

export function planExecution(input: PlanInput): ExecutionPlan {
  const compliance = resolveCompliance(input.arenaSymbol, input.exchange);
  const split = input.splitThresholdUSD ?? 5_000;

  if (!compliance.ok) {
    return {
      planId:        newPlanId(),
      exchange:      input.exchange,
      arenaSymbol:   input.arenaSymbol,
      exchangeSymbol:compliance.exchangeSymbol,
      ok:            false,
      reason:        compliance.reason ?? 'Asset not tradable on this exchange.',
      side:          input.side,
      totalUSD:      input.amountUSD,
      refPrice:      input.refPrice,
      effectivePrice:input.refPrice,
      type:          input.preferredType ?? 'market',
      children:      [],
      expectedSlippagePct: 0,
      retryAfterMs:  0,
      createdAt:     Date.now(),
    };
  }

  const type = input.preferredType ?? 'market';
  const slippageCap = input.maxSlippagePct ?? (type === 'market' ? 0.5 : 0);
  const slippageMultiplier = (type === 'market' ? slippageCap / 100 : 0);

  // Effective limit price = refPrice ± slippage buffer (buy → +buffer)
  const effectivePrice = type === 'limit'
    ? input.refPrice
    : input.side === 'buy'
        ? input.refPrice * (1 + slippageMultiplier)
        : input.refPrice * (1 - slippageMultiplier);

  // Decide whether to shard
  let chunks = 1;
  if (input.amountUSD > split) {
    chunks = Math.min(5, Math.ceil(input.amountUSD / split));
  }
  const perChunk = input.amountUSD / chunks;

  const children: ChildOrder[] = [];
  for (let i = 0; i < chunks; i++) {
    children.push({
      index:    i,
      symbol:   compliance.exchangeSymbol,
      side:     input.side,
      type,
      amountUSD: Math.round(perChunk * 100) / 100,
      ...(type === 'limit' ? { price: input.refPrice } : {}),
      notes:    chunks > 1 ? `Child ${i + 1}/${chunks} — laddered to reduce slippage` : 'Single fill',
    });
  }

  return {
    planId:        newPlanId(),
    exchange:      input.exchange,
    arenaSymbol:   input.arenaSymbol,
    exchangeSymbol:compliance.exchangeSymbol,
    ok:            true,
    side:          input.side,
    totalUSD:      input.amountUSD,
    refPrice:      input.refPrice,
    effectivePrice,
    type,
    children,
    expectedSlippagePct: slippageCap,
    retryAfterMs:  type === 'market' ? 250 : 1_000,
    createdAt:     Date.now(),
  };
}
