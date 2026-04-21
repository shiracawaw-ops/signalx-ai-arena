// ─── Pipeline Diagnostics (System #7) ─────────────────────────────────────────
// Aggregates the health of every pre-trade subsystem in one call so the new
// "Trading Pipeline" page can render a single consolidated dashboard.

import { pipelineCache } from './pipeline-cache';
import { shieldStats } from './rejection-shield';
import { complianceMatrix, SUPPORTED_EXCHANGES, type ExchangeId } from './asset-compliance';
import { studyAll, studySummary, type AssetStudy, type BotInputs } from './asset-study';
import { allocateCapital, type AllocationPlan } from './capital-allocator';
import { botFleet } from './bot-fleet';

export interface PipelineSnapshot {
  takenAt:        number;
  exchange:       ExchangeId;
  totalCapital:   number;
  cache:          ReturnType<typeof pipelineCache.stats>;
  shield:         ReturnType<typeof shieldStats>;
  compliance:     ReturnType<typeof complianceMatrix>;
  studies:        AssetStudy[];
  studySummary:   ReturnType<typeof studySummary>;
  allocation:     AllocationPlan;
}

export interface SnapshotInput {
  exchange:     ExchangeId;
  totalCapital: number;
  bots:         BotInputs[];
  symbols:      string[];
}

export function takeSnapshot(input: SnapshotInput): PipelineSnapshot {
  const studies = studyAll(input.bots);
  // Fleet-gating: keep the persisted real-bot list in sync with the live bots
  // and pass it down so non-real bots never receive real capital.
  const fleetCfg = botFleet.get();
  const realBotIds = botFleet.syncRealBotIds(input.bots.map(b => ({ id: b.bot.id, name: b.bot.name })));
  const allocation = allocateCapital({
    totalCapitalUSD: input.totalCapital,
    studies,
    minPerBot: 10,
    maxPerBot: input.totalCapital * 0.30,
    reservePct: 0.10,
    realBotIds,
    remainingMode:   fleetCfg.remainingMode,
    capitalUsagePct: fleetCfg.capitalUsagePct,
  });
  return {
    takenAt:      Date.now(),
    exchange:     input.exchange,
    totalCapital: input.totalCapital,
    cache:        pipelineCache.stats(),
    shield:       shieldStats(),
    compliance:   complianceMatrix(input.symbols),
    studies,
    studySummary: studySummary(studies),
    allocation,
  };
}

export { SUPPORTED_EXCHANGES };
