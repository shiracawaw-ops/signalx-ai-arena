export interface BotStopInput {
  netPnlUSD: number;
  rejectionRate: number;
  last10Net?: number[];
  drawdownPct?: number;
  spamRejectsRecent?: number;
  riskBreakRejectsRecent?: number;
  badEntryRejectsRecent?: number;
}

export interface BotStopResult {
  stop: boolean;
  reasons: string[];
  consecutiveLosses: number;
  drawdownPct: number;
}

export interface ReplacementCandidateInput {
  botId: string;
  trades: number;
  realizedNetPnlUSD: number;
  recentWinRate: number;
  rejectionRate: number;
  last10Net?: number[];
  drawdownPct?: number;
  stabilityScore?: number; // 0..1
  complianceScore?: number; // 0..1
  spamRejectsRecent?: number;
  riskBreakRejectsRecent?: number;
  badEntryRejectsRecent?: number;
}

export interface ReplacementCandidateResult extends ReplacementCandidateInput {
  confidence: number;
  score: number;
  qualifies: boolean;
  reasons: string[];
}

export const STOP_BOT_NET_LOSS_USD = -25;
export const STOP_BOT_REJECTION_RATE = 0.4;
export const STOP_BOT_MAX_CONSECUTIVE_LOSSES = 3;
export const STOP_BOT_MAX_DRAWDOWN_PCT = 1;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function consecutiveLosses(last10Net: number[] = []): number {
  let losses = 0;
  for (const p of last10Net.slice(0, 10)) {
    if (p < 0) losses += 1;
    else break;
  }
  return losses;
}

export function estimateDrawdownPct(last10Net: number[] = []): number {
  if (last10Net.length === 0) return 0;
  const seq = [...last10Net.slice(0, 10)].reverse();
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const pnl of seq) {
    equity += pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      maxDd = Math.max(maxDd, dd);
    }
  }
  return Number.isFinite(maxDd) ? maxDd : 0;
}

export function evaluateBotStop(input: BotStopInput): BotStopResult {
  const last10 = input.last10Net ?? [];
  const lossStreak = consecutiveLosses(last10);
  const drawdown = input.drawdownPct ?? estimateDrawdownPct(last10);
  const reasons: string[] = [];

  if (input.netPnlUSD <= STOP_BOT_NET_LOSS_USD) {
    reasons.push(`net_loss:${input.netPnlUSD.toFixed(2)}<=${STOP_BOT_NET_LOSS_USD}`);
  }
  if (input.rejectionRate > STOP_BOT_REJECTION_RATE) {
    reasons.push(`rejection_rate:${(input.rejectionRate * 100).toFixed(1)}%`);
  }
  if (lossStreak >= STOP_BOT_MAX_CONSECUTIVE_LOSSES) {
    reasons.push(`consecutive_losses:${lossStreak}`);
  }
  if (drawdown > STOP_BOT_MAX_DRAWDOWN_PCT) {
    reasons.push(`drawdown:${drawdown.toFixed(2)}%`);
  }
  if ((input.spamRejectsRecent ?? 0) >= 3) {
    reasons.push(`spam_behavior:${input.spamRejectsRecent}`);
  }
  if ((input.riskBreakRejectsRecent ?? 0) >= 2) {
    reasons.push(`risk_breaks:${input.riskBreakRejectsRecent}`);
  }
  if ((input.badEntryRejectsRecent ?? 0) >= 3) {
    reasons.push(`repeated_bad_entries:${input.badEntryRejectsRecent}`);
  }

  return {
    stop: reasons.length > 0,
    reasons,
    consecutiveLosses: lossStreak,
    drawdownPct: drawdown,
  };
}

function normalizedStability(input: ReplacementCandidateInput): number {
  if (typeof input.stabilityScore === 'number') return clamp(input.stabilityScore, 0, 1);
  const dd = input.drawdownPct ?? estimateDrawdownPct(input.last10Net ?? []);
  return clamp(1 - (dd / 2), 0, 1);
}

function normalizedCompliance(input: ReplacementCandidateInput): number {
  if (typeof input.complianceScore === 'number') return clamp(input.complianceScore, 0, 1);
  const penalties =
    (input.spamRejectsRecent ?? 0) +
    (input.riskBreakRejectsRecent ?? 0) +
    (input.badEntryRejectsRecent ?? 0);
  return clamp(1 - penalties / 12, 0, 1);
}

export function scoreReplacementCandidate(input: ReplacementCandidateInput): ReplacementCandidateResult {
  const drawdown = input.drawdownPct ?? estimateDrawdownPct(input.last10Net ?? []);
  const stability = normalizedStability(input);
  const compliance = normalizedCompliance(input);
  const lowRejectionScore = clamp(1 - input.rejectionRate, 0, 1);
  const recentWinRate = clamp(input.recentWinRate, 0, 1);
  const pnlScore = clamp((input.realizedNetPnlUSD + 50) / 100, 0, 1);
  const drawdownPenalty = clamp((drawdown - STOP_BOT_MAX_DRAWDOWN_PCT) / 3, 0, 1);
  const spamPenalty = clamp((input.spamRejectsRecent ?? 0) / 10, 0, 1);
  const confidence = clamp(recentWinRate * lowRejectionScore * compliance * 100, 0, 100);
  const trend = input.last10Net?.slice(0, 10) ?? [];
  const trendAvg = trend.length > 0 ? trend.reduce((s, v) => s + v, 0) / trend.length : 0;
  const positiveTrend = trend.length >= 3 ? trendAvg > 0 : input.realizedNetPnlUSD > 0;
  const stableHistory = input.trades >= 5 && stability >= 0.6;
  const score =
    (pnlScore * recentWinRate * stability * lowRejectionScore * compliance) -
    drawdownPenalty -
    spamPenalty;

  const reasons: string[] = [];
  if (confidence < 75) reasons.push('confidence_below_75');
  if (drawdown > STOP_BOT_MAX_DRAWDOWN_PCT) reasons.push('drawdown_spike');
  if (!stableHistory) reasons.push('unstable_history');
  if (!positiveTrend) reasons.push('negative_trend');

  return {
    ...input,
    drawdownPct: drawdown,
    stabilityScore: stability,
    complianceScore: compliance,
    confidence,
    score,
    qualifies: reasons.length === 0,
    reasons,
  };
}

export function selectReplacementBot(
  candidates: ReplacementCandidateInput[],
  stoppedBotId?: string,
): ReplacementCandidateResult | undefined {
  return candidates
    .filter(c => !stoppedBotId || c.botId !== stoppedBotId)
    .map(scoreReplacementCandidate)
    .filter(c => c.qualifies)
    .sort((a, b) => b.score - a.score)[0];
}
