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
import type { RemainingMode } from './bot-fleet';

export interface AllocationInput {
  totalCapitalUSD: number;
  studies:         AssetStudy[];
  minPerBot?:      number;   // exchange minNotional fallback (default 10)
  maxPerBot?:      number;   // hard ceiling per bot (default totalCapital * 0.35)
  reservePct?:     number;   // % held as cash (default 10%)
  /** When set, only these bot IDs may receive real capital. */
  realBotIds?:     string[];
  /** What to label the non-real bots in the skipped list. Default: 'paper'. */
  remainingMode?:  RemainingMode;
  /**
   * Percentage of `totalCapitalUSD` the user has authorised for live trading.
   * 100 = trade with everything, 25 = use only a quarter of the balance.
   * Defaults to 100 to keep backwards compatibility.
   */
  capitalUsagePct?: number;
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
  const rawTotal   = Math.max(0, input.totalCapitalUSD);
  const usagePct   = Math.max(0, Math.min(100, input.capitalUsagePct ?? 100)) / 100;
  // The "total" we work with is what the user authorised, not the raw balance.
  const total      = rawTotal * usagePct;
  const reservePct = Math.max(0, Math.min(0.5, input.reservePct ?? 0.10));
  const reserved   = total * reservePct + (rawTotal - total); // include capital held back by usage cap
  const deployable = total - total * reservePct;
  const minPer     = Math.max(5, input.minPerBot ?? 10);
  const maxPer     = Math.max(minPer, input.maxPerBot ?? total * 0.35);

  const allocations: BotAllocation[] = [];
  const skipped:     BotAllocation[] = [];

  const realSet = input.realBotIds && input.realBotIds.length > 0
    ? new Set(input.realBotIds)
    : null;
  const remainingMode: RemainingMode = input.remainingMode ?? 'paper';
  const remainingLabel =
    remainingMode === 'standby'  ? 'Standby — fleet limit reached, no real capital'  :
    remainingMode === 'disabled' ? 'Disabled — fleet limit reached, bot inactive'    :
                                   'Paper mode — fleet limit reached, sim trades only';

  // Step 1: enforce fleet gating BEFORE verdict filtering. Bots not in the
  // real-bot allow-list never receive real capital regardless of verdict.
  const fleetEligible = realSet
    ? input.studies.filter(s => realSet.has(s.botId))
    : input.studies;
  const fleetBenched = realSet
    ? input.studies.filter(s => !realSet.has(s.botId))
    : [];

  for (const s of fleetBenched) {
    skipped.push({
      botId: s.botId, botName: s.botName, symbol: s.arenaSymbol,
      amountUSD: 0, weight: 0,
      reason: remainingLabel,
      active: false,
    });
  }

  const eligible = fleetEligible.filter(s => s.verdict === 'ready' || s.verdict === 'warm-up');
  const blocked  = fleetEligible.filter(s => s.verdict === 'blocked' || s.verdict === 'risky' || s.verdict === 'stalled');

  for (const s of blocked) {
    skipped.push({
      botId: s.botId, botName: s.botName, symbol: s.arenaSymbol,
      amountUSD: 0, weight: 0,
      reason: s.recommendation || `Skipped — verdict=${s.verdict}`,
      active: false,
    });
  }

  if (eligible.length === 0 || deployable <= 0) {
    return {
      totalCapitalUSD: rawTotal,
      reservedUSD:     Math.round(reserved * 100) / 100,
      deployedUSD:     0,
      allocations, skipped, generatedAt: Date.now(),
    };
  }

  // Step 1.5: deployable-cap invariant — if every eligible bot would receive
  // at least `minPer`, the floor sum already exceeds the deployable pool.
  // Trim the eligible set (lowest-priority bots first) until it fits, and
  // skip the trimmed bots with a clear reason. This keeps the contract
  // `sum(allocations) <= deployable` true even with low capital + many bots.
  let workingEligible = eligible;
  if (minPer * workingEligible.length > deployable) {
    const maxFit = Math.max(0, Math.floor(deployable / minPer));
    const ranked = [...workingEligible].sort((a, b) =>
      ((b.recentWinRate / 100) * (b.confidence / 100)) -
      ((a.recentWinRate / 100) * (a.confidence / 100)),
    );
    const fit  = ranked.slice(0, maxFit);
    const cut  = ranked.slice(maxFit);
    workingEligible = fit;
    for (const s of cut) {
      skipped.push({
        botId: s.botId, botName: s.botName, symbol: s.arenaSymbol,
        amountUSD: 0, weight: 0,
        reason: `Skipped — capital cap reached (need at least $${minPer.toFixed(2)} per bot)`,
        active: false,
      });
    }
  }

  if (workingEligible.length === 0) {
    return {
      totalCapitalUSD: rawTotal,
      reservedUSD:     Math.round(reserved * 100) / 100,
      deployedUSD:     0,
      allocations, skipped, generatedAt: Date.now(),
    };
  }

  // Step 2: equal base
  const baseShare = (deployable * 0.6) / workingEligible.length;

  // Step 3: 40% performance bonus
  const bonusPool = deployable * 0.4;
  const weights   = workingEligible.map(s =>
    Math.max(0.01, (s.recentWinRate / 100) * (s.confidence / 100) + 0.05),
  );
  const wSum      = weights.reduce((a, b) => a + b, 0);

  let deployed = 0;
  const raw: number[] = workingEligible.map((_, i) => {
    const bonus = (weights[i] / wSum) * bonusPool;
    return Math.min(maxPer, Math.max(minPer, baseShare + bonus));
  });

  // Step 4: enforce the deployable cap. If clamping pushed us over budget
  // (typically because `minPer` floors raised some bots), shave the excess
  // proportionally from bots that are still above `minPer`.
  let runningTotal = raw.reduce((a, b) => a + b, 0);
  if (runningTotal > deployable) {
    let overshoot = runningTotal - deployable;
    // Iteratively trim until we either fit or every bot sits at the floor.
    for (let pass = 0; pass < 5 && overshoot > 0.01; pass++) {
      const trimmable = raw
        .map((amt, i) => ({ i, slack: amt - minPer }))
        .filter(x => x.slack > 0);
      if (trimmable.length === 0) break;
      const slackTotal = trimmable.reduce((a, b) => a + b.slack, 0);
      const cut = Math.min(overshoot, slackTotal);
      for (const x of trimmable) {
        const take = (x.slack / slackTotal) * cut;
        raw[x.i] -= take;
      }
      runningTotal = raw.reduce((a, b) => a + b, 0);
      overshoot = runningTotal - deployable;
    }
  }

  workingEligible.forEach((s, i) => {
    const amount = raw[i];
    deployed += amount;
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
    totalCapitalUSD: rawTotal,
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
