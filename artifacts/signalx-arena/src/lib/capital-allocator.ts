// ─── Capital Allocation Engine (System #5) ────────────────────────────────────
// Distributes a single pool of capital across N bots based on performance,
// confidence, and risk.  Output is the per-bot $ allocation that the
// execution engine should use as `tradeAmountUSD` for that bot's next order.
//
// Allocation rules:
//   1. Blocked / risky bots get 0.
//   2. Remaining bots split a base allocation equally.
//   3. Up to 40% of pool is then redistributed as a bonus weighted by
//      (recent win-rate × confidence).  Top performer never gets > 35% solo.
//   4. Each bot is clamped to [minNotional, maxPerBot] to respect exchange
//      minimums and overall risk caps.

import type { AssetStudy } from './asset-study';

export interface AllocationInput {
  totalCapitalUSD: number;
  studies:         AssetStudy[];
  minPerBot?:      number;   // exchange minNotional fallback (default 10)
  maxPerBot?:      number;   // hard ceiling per bot (default totalCapital * 0.35)
  reservePct?:     number;   // % held as cash (default 10%)
}

export interface BotAllocation {
  botId:        string;
  botName:      string;
  symbol:       string;
  amountUSD:    number;
  weight:       number;        // 0-1
  reason:       string;
  active:       boolean;       // false → bot skipped this round
}

export interface AllocationPlan {
  totalCapitalUSD: number;
  reservedUSD:     number;
  deployedUSD:     number;
  allocations:     BotAllocation[];
  skipped:         BotAllocation[];
  generatedAt:     number;
}

export function allocateCapital(input: AllocationInput): AllocationPlan {
  const total      = Math.max(0, input.totalCapitalUSD);
  const reservePct = Math.max(0, Math.min(0.5, input.reservePct ?? 0.10));
  const reserved   = total * reservePct;
  const deployable = total - reserved;
  const minPer     = Math.max(5, input.minPerBot ?? 10);
  const maxPer     = Math.max(minPer, input.maxPerBot ?? total * 0.35);

  const allocations: BotAllocation[] = [];
  const skipped:     BotAllocation[] = [];

  const eligible = input.studies.filter(s => s.verdict === 'ready' || s.verdict === 'warm-up');
  const blocked  = input.studies.filter(s => s.verdict === 'blocked' || s.verdict === 'risky' || s.verdict === 'stalled');

  for (const s of blocked) {
    skipped.push({
      botId: s.botId, botName: s.botName, symbol: s.arenaSymbol,
      amountUSD: 0, weight: 0,
      reason: s.recommendation || `Skipped — verdict=${s.verdict}`,
      active: false,
    });
  }

  if (eligible.length === 0 || deployable <= 0) {
    return { totalCapitalUSD: total, reservedUSD: reserved, deployedUSD: 0, allocations, skipped, generatedAt: Date.now() };
  }

  // Step 2: equal base
  const baseShare = (deployable * 0.6) / eligible.length;

  // Step 3: 40% performance bonus
  const bonusPool = deployable * 0.4;
  const weights   = eligible.map(s => Math.max(0.01, (s.recentWinRate / 100) * (s.confidence / 100) + 0.05));
  const wSum      = weights.reduce((a, b) => a + b, 0);

  let deployed = 0;
  eligible.forEach((s, i) => {
    const bonus  = (weights[i] / wSum) * bonusPool;
    let amount   = baseShare + bonus;
    amount       = Math.min(maxPer, Math.max(minPer, amount));
    deployed    += amount;
    allocations.push({
      botId: s.botId, botName: s.botName, symbol: s.arenaSymbol,
      amountUSD: Math.round(amount * 100) / 100,
      weight: weights[i] / wSum,
      reason:
        s.verdict === 'warm-up'
          ? `Warm-up allocation (collecting data)`
          : `Win ${s.recentWinRate.toFixed(0)}%, conf ${s.confidence.toFixed(0)}%, ${s.signal}`,
      active: true,
    });
  });

  return {
    totalCapitalUSD: total,
    reservedUSD:     Math.round(reserved * 100) / 100,
    deployedUSD:     Math.round(deployed * 100) / 100,
    allocations,
    skipped,
    generatedAt:     Date.now(),
  };
}

/** Look up the planned amount for a single bot, with sensible fallback. */
export function amountForBot(plan: AllocationPlan, botId: string, fallback = 100): number {
  return plan.allocations.find(a => a.botId === botId)?.amountUSD ?? fallback;
}
