// ─── Bot Scoring (System #11) ────────────────────────────────────────────────
// Pure helpers that turn raw Bot + Trade history into the `BotScore[]` payload
// expected by `botFleet.syncRealBotIds`. Kept in its own file so it stays:
//   • cheap to unit-test (no localStorage / DOM access),
//   • cheap to evolve (assignment-mode metrics live next to each other),
//   • cheap to reuse (per-bot reports + leaderboard pull from the same shape).

import type { Bot, Trade } from './storage';
import type { BotScore } from './bot-fleet';

const RECENT_TRADE_WINDOW = 25;

/** Build a single BotScore for one bot using its trade history slice. */
export function scoreOneBot(
  bot: Bot,
  trades: Trade[],
  getCurrentPrice?: (symbol: string) => number,
): BotScore {
  const own = trades.filter(t => t.botId === bot.id);
  const recent = own.slice(-RECENT_TRADE_WINDOW);

  const recentWins = recent.filter(t => t.pnl > 0).length;
  const recentWinRate = recent.length > 0 ? recentWins / recent.length : 0;

  // ROI relative to starting balance, clamped to [-100, +100].
  // Use total value (cash + marked position) so open positions are scored
  // truthfully instead of appearing as losses while capital is deployed.
  const markPrice = getCurrentPrice?.(bot.symbol);
  const positionMark = Number.isFinite(markPrice) && (markPrice ?? 0) > 0
    ? (markPrice as number)
    : bot.avgEntryPrice;
  const totalValue = bot.balance + bot.position * positionMark;
  const pnl = totalValue - bot.startingBalance;
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

  // Composite = mix of ROI, recent win-rate, and stability.
  const compositeScore =
    0.45 * roiNorm +
    0.35 * (recentWinRate * 100) +
    0.20 * stabilityScore;

  // Without rejection telemetry on the bot itself we infer from the overall
  // shield-rejection table elsewhere; default to 0 so it doesn't penalise.
  const rejectionRate = 0;

  return {
    id:              bot.id,
    name:            bot.name,
    compositeScore:  round1(compositeScore),
    recentScore:     round1(recentWinRate * 100),
    rejectionRate,
    stabilityScore:  round1(stabilityScore),
    realizedPnl:     round1(pnl),
  };
}

/** Build BotScore[] for all bots in one pass. */
export function scoreAllBots(
  bots: Bot[],
  trades: Trade[],
  getCurrentPrice?: (symbol: string) => number,
): BotScore[] {
  return bots.map(b => scoreOneBot(b, trades, getCurrentPrice));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
