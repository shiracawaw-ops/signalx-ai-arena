// ─── Bot Scoring (System #11) ────────────────────────────────────────────────
// Pure helpers that turn raw Bot + Trade history into the `BotScore[]` payload
// expected by `botFleet.syncRealBotIds`. Kept in its own file so it stays:
//   • cheap to unit-test (no localStorage / DOM access),
//   • cheap to evolve (assignment-mode metrics live next to each other),
//   • cheap to reuse (per-bot reports + leaderboard pull from the same shape).

import type { Bot, Trade } from './storage';
import type { BotScore } from './bot-fleet';
import type { BotRealStat } from './real-profit-store';
import type { BotActivity } from './bot-activity-store';

const RECENT_TRADE_WINDOW = 25;

export interface ScoreTelemetryInput {
  perBotReal?: Record<string, BotRealStat>;
  perBotActivity?: Record<string, BotActivity>;
}

/** Build a single BotScore for one bot using its trade history slice. */
export function scoreOneBot(bot: Bot, trades: Trade[], telemetry: ScoreTelemetryInput = {}): BotScore {
  const own = trades.filter(t => t.botId === bot.id);
  const recent = own.slice(-RECENT_TRADE_WINDOW);

  const recentWins = recent.filter(t => t.pnl > 0).length;
  const recentWinRate = recent.length > 0 ? recentWins / recent.length : 0;

  // ROI relative to starting balance, clamped to [-100, +100].
  const pnl = bot.balance - bot.startingBalance;
  const roi = bot.startingBalance > 0 ? (pnl / bot.startingBalance) * 100 : 0;
  const roiNorm = Math.max(0, Math.min(100, 50 + roi)); // 50 = break-even

  // Stability = inverse of equity drawdown across the trade sequence.
  let peak = bot.startingBalance;
  let runningEquity = bot.startingBalance;
  let maxDrawdownPct = 0;
  for (const t of own) {
    runningEquity += t.pnl;
    if (runningEquity > peak) peak = runningEquity;
    if (peak > 0) {
      const dd = ((peak - runningEquity) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }
  const stabilityScore = Math.max(0, 100 - maxDrawdownPct * 2);

  const real = telemetry.perBotReal?.[bot.id];
  const activity = telemetry.perBotActivity?.[bot.id];
  const netRealizedAfterFees = real
    ? (real.realizedPnlUSD - real.feesPaidUSD)
    : 0;
  const recentRealizedNetPnl = real?.todayNetPnlUSD ?? 0;
  const rejectionRate = activity?.invalidAttemptRate
    ?? (activity?.recent && activity.recent.length > 0
      ? (() => {
          const submitted = activity.recent.filter(x => x.kind === 'attempt' || x.kind === 'success' || x.kind === 'reject').length;
          const rejects = activity.recent.filter(x => x.kind === 'reject').length;
          return submitted > 0 ? rejects / submitted : 0;
        })()
      : 0);
  const executionQualityScore = activity?.executionQualityScore
    ?? Math.max(0, 100 - rejectionRate * 100);
  const invalidAttemptRate = rejectionRate;
  const drawdownPct = maxDrawdownPct;
  const marketRegimeFitScore = Math.max(0, Math.min(100, 40 + recentWinRate * 60));
  const slippageQualityScore = Math.max(0, Math.min(100, 100 - rejectionRate * 70));
  const doctorHealthStatus = activity?.doctorHealthStatus ?? 'healthy';

  // Composite = strict real-money metrics first, then execution cleanliness.
  // When no real history exists yet, fall back to simulation-derived ROI.
  const realizedAnchor = real
    ? Math.max(0, Math.min(100, 100 * (1 - Math.exp(-Math.max(0, netRealizedAfterFees) / 100))))
    : roiNorm;
  const compositeScore =
    0.35 * realizedAnchor +
    0.20 * (recentWinRate * 100) +
    0.15 * stabilityScore +
    0.15 * executionQualityScore +
    0.15 * (100 - rejectionRate * 100);

  return {
    id:              bot.id,
    name:            bot.name,
    compositeScore:  round1(compositeScore),
    recentScore:     round1(recentWinRate * 100),
    rejectionRate:   round1(rejectionRate * 100) / 100,
    stabilityScore:  round1(stabilityScore),
    realizedPnl:     round1(pnl),
    netRealizedAfterFees: round1(netRealizedAfterFees),
    recentRealizedNetPnl: round1(recentRealizedNetPnl),
    executionQualityScore: round1(executionQualityScore),
    invalidAttemptRate: round1(invalidAttemptRate * 100) / 100,
    drawdownPct: round1(drawdownPct),
    slippageQualityScore: round1(slippageQualityScore),
    marketRegimeFitScore: round1(marketRegimeFitScore),
    doctorHealthStatus,
  };
}

/** Build BotScore[] for all bots in one pass. */
export function scoreAllBots(bots: Bot[], trades: Trade[], telemetry: ScoreTelemetryInput = {}): BotScore[] {
  return bots.map(b => scoreOneBot(b, trades, telemetry));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
