import type { Bot, Trade } from './storage';
import { computeAllIndicators } from './indicators';
import { evaluateBots, type BotEvaluation, type AutoPilotHoldReason } from './autopilot';
import { botFleet } from './bot-fleet';
import { botActivityStore } from './bot-activity-store';
import { getBotTotalValue } from './engine';

export type StandbyReasonCode =
  | 'no_entry_signal'
  | 'hold_regime'
  | 'confidence_below_threshold'
  | 'drift_block'
  | 'cooldown'
  | 'fleet_standby'
  | 'benched'
  | 'risk_gate_prevented_entry'
  | 'symbol_level_block'
  | 'trend_filter_failed'
  | 'momentum_filter_failed'
  | 'no_breakout'
  | 'market_regime_says_hold';

export interface BotActivationDiagnostic {
  botId: string;
  botName: string;
  symbol: string;
  strategy: string;
  eligible: boolean;
  selectedByAutopilot: boolean;
  signalDirection: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  entryScore: number;
  standbyReasonCode: StandbyReasonCode;
  standbyReason: string;
  detail: string;
}

export interface HoldDiagnosis {
  reasons: AutoPilotHoldReason[];
  summary: string;
}

const CONFIDENCE_FLOOR = 50;

export function diagnoseBotActivations(input: {
  bots: Bot[];
  trades: Trade[];
  market: Record<string, Array<{ close: number; high: number; low: number; volume: number; time: number; open: number }>>;
  selectedBotId?: string | null;
  holdReasons?: AutoPilotHoldReason[];
}): BotActivationDiagnostic[] {
  const { bots, trades, market, selectedBotId, holdReasons = [] } = input;
  const configuredEligible = botFleet.get().realBotIds;
  const eligible = new Set(
    configuredEligible.length > 0
      ? configuredEligible
      : bots.filter(b => b.isRunning).map(b => b.id),
  );
  const evaluations = evaluateBots(bots, trades, symbol => {
    const candles = market[symbol];
    const price = candles?.[candles.length - 1]?.close ?? 0;
    return Number.isFinite(price) ? price : 0;
  }, { eligibleBotIds: eligible });
  const evalById = new Map<string, BotEvaluation>(evaluations.map(ev => [ev.bot.id, ev]));
  const activity = botActivityStore.snapshot().bots;

  return bots
    .filter(b => eligible.has(b.id))
    .map(bot => {
      const ev = evalById.get(bot.id);
      const candles = market[bot.symbol] ?? [];
      const ind = candles.length >= 52 ? computeAllIndicators(candles) : null;
      const direction: 'BUY' | 'SELL' | 'HOLD' = ev?.action ?? 'HOLD';
      const confidence = ev?.confidence ?? 0;
      const score = ev?.score ?? 0;
      const isSelected = selectedBotId === bot.id;
      const lastReject = activity[bot.id]?.lastRejectCode?.toLowerCase() ?? '';

      let standbyReasonCode: StandbyReasonCode = 'no_entry_signal';
      let standbyReason = 'Standby: no entry signal';
      let detail = ev?.reasons[0] ?? 'No actionable entry from strategy.';

      if (!bot.isRunning) {
        standbyReasonCode = 'fleet_standby';
        standbyReason = 'Standby: fleet standby';
        detail = 'Bot is in eligible set but currently paused in standby mode.';
      } else if (isSelected && direction === 'BUY' && holdReasons.length > 0) {
        const code = holdReasons[0].code;
        if (code === 'risk_gate_prevented_entry') {
          standbyReasonCode = 'risk_gate_prevented_entry';
          standbyReason = 'Standby: risk gate prevented entry';
          detail = holdReasons[0].message;
        } else if (code === 'market_regime_says_hold') {
          standbyReasonCode = 'market_regime_says_hold';
          standbyReason = 'Standby: hold regime';
          detail = holdReasons[0].message;
        } else if (code === 'symbol_level_block') {
          standbyReasonCode = 'symbol_level_block';
          standbyReason = 'Standby: symbol-level block';
          detail = holdReasons[0].message;
        } else if (code === 'confidence_below_threshold') {
          standbyReasonCode = 'confidence_below_threshold';
          standbyReason = 'Standby: confidence below threshold';
          detail = holdReasons[0].message;
        }
      } else if (lastReject.includes('price_drift_too_large')) {
        standbyReasonCode = 'drift_block';
        standbyReason = 'Standby: drift block';
        detail = activity[bot.id]?.lastRejectDetail ?? 'Signal price drifted too far from live quote.';
      } else if (lastReject.includes('cooldown')) {
        standbyReasonCode = 'cooldown';
        standbyReason = 'Standby: cooldown';
        detail = activity[bot.id]?.lastRejectDetail ?? 'Cooldown is active after repeated failures.';
      } else if (confidence < CONFIDENCE_FLOOR) {
        standbyReasonCode = 'confidence_below_threshold';
        standbyReason = 'Standby: confidence below threshold';
        detail = `Confidence ${confidence.toFixed(0)}% is below ${CONFIDENCE_FLOOR}% floor.`;
      } else if (!ind) {
        standbyReasonCode = 'hold_regime';
        standbyReason = 'Standby: hold regime';
        detail = 'Insufficient candles for full indicator set.';
      } else if (ind.sma.sma20 <= ind.sma.sma50 && direction !== 'SELL') {
        standbyReasonCode = 'trend_filter_failed';
        standbyReason = 'Standby: trend filter failed';
        detail = `SMA20 (${ind.sma.sma20.toFixed(4)}) <= SMA50 (${ind.sma.sma50.toFixed(4)}).`;
      } else if (ind.breakout.signal !== 'BUY' && bot.strategy === 'Breakout' && direction !== 'SELL') {
        standbyReasonCode = 'no_breakout';
        standbyReason = 'Standby: no breakout';
        detail = `Breakout signal is ${ind.breakout.signal}.`;
      } else if (direction === 'HOLD') {
        standbyReasonCode = 'momentum_filter_failed';
        standbyReason = 'Standby: momentum filter failed';
        detail = ev?.reasons[0] ?? 'Momentum criteria not met for entry.';
      }

      return {
        botId: bot.id,
        botName: bot.name,
        symbol: bot.symbol,
        strategy: bot.strategy,
        eligible: true,
        selectedByAutopilot: isSelected,
        signalDirection: direction,
        confidence,
        entryScore: score,
        standbyReasonCode,
        standbyReason,
        detail,
      };
    })
    .sort((a, b) => b.entryScore - a.entryScore);
}

export function summarizeHoldReasons(holdReasons: AutoPilotHoldReason[]): HoldDiagnosis {
  if (holdReasons.length === 0) {
    return {
      reasons: [],
      summary: 'No HOLD blockers detected — strategy can trade when a qualifying signal appears.',
    };
  }
  return {
    reasons: holdReasons,
    summary: holdReasons.map(h => h.message).join(' · '),
  };
}

export function summarizePortfolioSnapshot(
  bots: Bot[],
  getCurrentPrice: (s: string) => number,
): {
  totalPortfolio: number;
  totalStarting: number;
  totalPnL: number;
  totalPnLPct: number;
} {
  const totalPortfolio = bots.reduce(
    (sum, b) => sum + getBotTotalValue(b, getCurrentPrice(b.symbol)),
    0,
  );
  const totalStarting = bots.reduce((sum, b) => sum + b.startingBalance, 0);
  const totalPnL = totalPortfolio - totalStarting;
  const totalPnLPct = totalStarting > 0 ? (totalPnL / totalStarting) * 100 : 0;
  return { totalPortfolio, totalStarting, totalPnL, totalPnLPct };
}
