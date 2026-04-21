// ─── Champion Detector + Strategy Cloner ──────────────────────────────────────
// Picks the single best-performing real-money bot from the realized-PnL store
// and lets the user clone its strategy onto other bots so the proven playbook
// runs on more symbols.
//
// Champion criteria (REAL data only, no synthetic mixing):
//   - At least MIN_TRADES closed trades
//   - Net realized after fees > 0
//   - Score = netRealized × winRateBias × (1 - rejectionRate)
//
// `cloneStrategyTo` returns a partial Bot patch the caller applies. We only
// copy pure-strategy fields (strategy id, sensitivity, take-profit etc.) —
// never balance, position, or symbol, so each target keeps its own market.

import type { BotRealStat } from './real-profit-store.js';
import type { Bot } from './storage.js';

export interface ChampionStat {
  botId:        string;
  botName?:     string;
  netRealized:  number;
  winRate:      number;     // 0..1
  trades:       number;
  rejectionRate: number;    // 0..1, optional input
  score:        number;
}

export interface ChampionResult {
  champion:    ChampionStat;
  runnersUp:   ChampionStat[];
}

const MIN_TRADES = 3;

export function rankBotsByRealPerformance(
  perBot: Record<string, BotRealStat>,
  rejectionRates: Record<string, number> = {},
  nameLookup: Record<string, string> = {},
): ChampionStat[] {
  const stats: ChampionStat[] = [];
  for (const [botId, s] of Object.entries(perBot)) {
    const trades = s.wins + s.losses;
    if (trades < MIN_TRADES) continue;
    const net = s.realizedPnlUSD - s.feesPaidUSD;
    if (net <= 0) continue;
    const winRate = trades > 0 ? s.wins / trades : 0;
    const rej = Math.max(0, Math.min(1, rejectionRates[botId] ?? 0));
    // Score tilts toward profitable & consistent. Win-rate bias kicks in
    // around 0.5 (50%) so a 20-trade 60% win bot beats a 3-trade lucky bot.
    const winBias = 0.5 + winRate;
    const score = net * winBias * (1 - rej);
    stats.push({ botId, botName: nameLookup[botId], netRealized: net, winRate, trades, rejectionRate: rej, score });
  }
  return stats.sort((a, b) => b.score - a.score);
}

export function findChampion(
  perBot: Record<string, BotRealStat>,
  rejectionRates: Record<string, number> = {},
  nameLookup: Record<string, string> = {},
): ChampionResult | null {
  const ranked = rankBotsByRealPerformance(perBot, rejectionRates, nameLookup);
  if (ranked.length === 0) return null;
  const [champion, ...rest] = ranked;
  return { champion, runnersUp: rest.slice(0, 3) };
}

/**
 * Returns a partial Bot patch to make `target` mirror `champion`'s strategy.
 * Only strategy-related fields are copied — never balance, position, symbol.
 */
export function cloneStrategyTo(champion: Bot, target: Bot): Partial<Bot> {
  if (champion.id === target.id) return {};
  return {
    strategy: champion.strategy,
  };
}
