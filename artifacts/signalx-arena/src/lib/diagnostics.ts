
// ─── Bot Doctor — Diagnostics Engine ─────────────────────────────────────────
import { Bot, Trade } from './storage';
import { BotStatus, RiskConfig, determineBotStatus } from './platform';

export type IssueLevel = 'critical' | 'warning' | 'info';
export type IssueCode =
  | 'LAZY_BOT'
  | 'LOW_ACTIVITY'
  | 'EXCESSIVE_LOSSES'
  | 'HIGH_DRAWDOWN'
  | 'STRATEGY_DRIFT'
  | 'PERFORMANCE_DEGRADATION'
  | 'RISK_LIMIT_BREACH'
  | 'ZERO_TRADES'
  | 'CONSECUTIVE_LOSSES'
  | 'LOW_WIN_RATE'
  | 'HEALTHY';

export interface BotIssue {
  code: IssueCode;
  level: IssueLevel;
  title: string;
  description: string;
  detectedAt: number;
  recommendation: string;
  actions: BotAction[];
}

export type BotAction =
  | 'restart'
  | 'reduce_risk'
  | 'pause'
  | 'replace'
  | 'rollback'
  | 'alert_admin'
  | 'monitor';

export interface BotDiagnostic {
  botId: string;
  botName: string;
  symbol: string;
  strategy: string;
  color: string;
  status: BotStatus;
  healthScore: number;         // 0–100
  issues: BotIssue[];
  metrics: DiagnosticMetrics;
  lastChecked: number;
}

export interface DiagnosticMetrics {
  totalTrades: number;
  tradesLast10Ticks: number;
  winRate: number;
  consecutiveLosses: number;
  maxDrawdown: number;
  currentDrawdown: number;
  grossPnl: number;
  avgTradeSize: number;
  profitFactor: number;
  stabilityScore: number;   // consistency of returns (0-100)
  activityScore: number;    // trade frequency score (0-100)
  latencyScore: number;     // always 100 in demo (mocked)
}

function computeMetrics(
  bot: Bot,
  botTrades: Trade[],
  currentPrice: number,
): DiagnosticMetrics {
  const totalValue = bot.balance + bot.position * currentPrice;
  const grossPnl = totalValue - bot.startingBalance;
  const sells = botTrades.filter(t => t.type === 'SELL');
  const wins  = sells.filter(t => t.pnl > 0).length;
  const winRate = sells.length > 0 ? (wins / sells.length) * 100 : 0;

  // Consecutive losses (from most recent sells)
  let consecutiveLosses = 0;
  for (let i = sells.length - 1; i >= 0; i--) {
    if (sells[i].pnl <= 0) consecutiveLosses++;
    else break;
  }

  // Profit factor
  const grossWins   = sells.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(sells.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 1;

  // Max drawdown: peak-to-trough using cumulative pnl per sell
  let peak = 0;
  let runningPnl = 0;
  let maxDD = 0;
  for (const t of sells) {
    runningPnl += t.pnl;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak > 0 ? ((peak - runningPnl) / (bot.startingBalance + peak)) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const currentDrawdown = grossPnl < 0 ? Math.abs(grossPnl / bot.startingBalance) * 100 : 0;

  const tradesLast10Ticks = botTrades.filter(
    t => t.timestamp > Date.now() - 10 * 800
  ).length;

  const avgTradeSize = sells.length > 0
    ? sells.reduce((s, t) => s + t.quantity * t.price, 0) / sells.length
    : 0;

  // Stability: std dev of sell pnls — lower variance = higher stability
  const pnls = sells.map(t => t.pnl);
  let stabilityScore = 50;
  if (pnls.length > 2) {
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length;
    const std = Math.sqrt(variance);
    const cv = mean !== 0 ? Math.abs(std / mean) : 1;
    stabilityScore = Math.max(0, Math.min(100, 100 - cv * 30));
  } else if (pnls.length > 0) {
    stabilityScore = 60;
  }

  const activityScore = Math.min(100, (botTrades.length / 5) * 20);
  const latencyScore  = 98 + Math.random() * 2; // mock

  return {
    totalTrades: botTrades.length,
    tradesLast10Ticks,
    winRate,
    consecutiveLosses,
    maxDrawdown: maxDD,
    currentDrawdown,
    grossPnl,
    avgTradeSize,
    profitFactor,
    stabilityScore,
    activityScore,
    latencyScore,
  };
}

function detectIssues(m: DiagnosticMetrics, riskCfg: RiskConfig): BotIssue[] {
  const issues: BotIssue[] = [];
  const now = Date.now();

  if (m.totalTrades === 0) {
    issues.push({
      code: 'ZERO_TRADES',
      level: 'warning',
      title: 'No trades executed',
      description: 'Bot has not executed a single trade since deployment. Strategy may not be triggering under current market conditions.',
      detectedAt: now,
      recommendation: 'Check market conditions. Consider switching to Multi-Signal or Breakout strategy.',
      actions: ['restart', 'monitor'],
    });
  } else if (m.totalTrades < 3) {
    issues.push({
      code: 'LAZY_BOT',
      level: 'warning',
      title: 'Lazy Bot — Very low trade count',
      description: `Only ${m.totalTrades} trades recorded. Bot is barely participating.`,
      detectedAt: now,
      recommendation: 'Review strategy sensitivity or increase market volatility simulation.',
      actions: ['restart', 'reduce_risk', 'monitor'],
    });
  }

  if (m.activityScore < 20 && m.totalTrades > 0) {
    issues.push({
      code: 'LOW_ACTIVITY',
      level: 'info',
      title: 'Low Activity Score',
      description: `Activity score: ${m.activityScore.toFixed(0)}/100. Bot is trading infrequently.`,
      detectedAt: now,
      recommendation: 'Normal for some conservative strategies. Watch for prolonged inactivity.',
      actions: ['monitor'],
    });
  }

  if (m.currentDrawdown > riskCfg.maxBotDrawdownPercent) {
    issues.push({
      code: 'HIGH_DRAWDOWN',
      level: 'critical',
      title: 'Drawdown Limit Breached',
      description: `Current drawdown ${m.currentDrawdown.toFixed(1)}% exceeds limit of ${riskCfg.maxBotDrawdownPercent}%.`,
      detectedAt: now,
      recommendation: 'Immediately reduce exposure or replace bot with a backup strategy.',
      actions: ['pause', 'reduce_risk', 'replace', 'alert_admin'],
    });
  } else if (m.maxDrawdown > riskCfg.maxBotDrawdownPercent * 0.7) {
    issues.push({
      code: 'HIGH_DRAWDOWN',
      level: 'warning',
      title: 'Approaching Drawdown Limit',
      description: `Historical max drawdown: ${m.maxDrawdown.toFixed(1)}%. Approaching limit of ${riskCfg.maxBotDrawdownPercent}%.`,
      detectedAt: now,
      recommendation: 'Monitor closely. Consider reducing position size.',
      actions: ['reduce_risk', 'monitor'],
    });
  }

  if (m.consecutiveLosses >= 5) {
    issues.push({
      code: 'CONSECUTIVE_LOSSES',
      level: 'critical',
      title: `${m.consecutiveLosses} Consecutive Losses`,
      description: 'Pattern of repeated losing trades detected. Strategy may be misaligned with market regime.',
      detectedAt: now,
      recommendation: 'Pause bot and review strategy. Market may have shifted. Consider rollback.',
      actions: ['pause', 'rollback', 'alert_admin'],
    });
  } else if (m.consecutiveLosses >= 3) {
    issues.push({
      code: 'CONSECUTIVE_LOSSES',
      level: 'warning',
      title: `${m.consecutiveLosses} Consecutive Losses`,
      description: 'Losing streak detected. Monitor closely for continued deterioration.',
      detectedAt: now,
      recommendation: 'Watch closely. If it continues, consider pausing and reviewing.',
      actions: ['reduce_risk', 'monitor'],
    });
  }

  if (m.winRate < 25 && m.totalTrades >= 5) {
    issues.push({
      code: 'LOW_WIN_RATE',
      level: m.winRate < 15 ? 'critical' : 'warning',
      title: `Low Win Rate: ${m.winRate.toFixed(0)}%`,
      description: `Win rate ${m.winRate.toFixed(1)}% is below acceptable threshold of 30%.`,
      detectedAt: now,
      recommendation: 'Strategy is underperforming. Review signal quality or replace strategy.',
      actions: m.winRate < 15 ? ['replace', 'alert_admin'] : ['reduce_risk', 'monitor'],
    });
  }

  if (m.grossPnl < -50 && m.totalTrades >= 5) {
    issues.push({
      code: 'EXCESSIVE_LOSSES',
      level: m.grossPnl < -100 ? 'critical' : 'warning',
      title: `Excessive Loss: $${Math.abs(m.grossPnl).toFixed(0)}`,
      description: `Bot has lost $${Math.abs(m.grossPnl).toFixed(2)} — ${(Math.abs(m.grossPnl) / 1000 * 100).toFixed(1)}% of starting capital.`,
      detectedAt: now,
      recommendation: m.grossPnl < -100 ? 'Replace bot immediately.' : 'Reduce position size and monitor.',
      actions: m.grossPnl < -100 ? ['pause', 'replace', 'alert_admin'] : ['reduce_risk'],
    });
  }

  if (m.profitFactor < 0.8 && m.totalTrades >= 5) {
    issues.push({
      code: 'PERFORMANCE_DEGRADATION',
      level: 'warning',
      title: 'Poor Profit Factor',
      description: `Profit factor: ${m.profitFactor.toFixed(2)} (good bots aim for >1.5).`,
      detectedAt: now,
      recommendation: 'Strategy not generating enough profit relative to losses.',
      actions: ['reduce_risk', 'monitor'],
    });
  }

  return issues;
}

function calcHealthScore(m: DiagnosticMetrics, issues: BotIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    if (issue.level === 'critical') score -= 30;
    else if (issue.level === 'warning') score -= 15;
    else score -= 5;
  }
  // Bonus for good metrics
  if (m.winRate > 55) score += 5;
  if (m.profitFactor > 2) score += 5;
  if (m.stabilityScore > 70) score += 5;
  return Math.max(0, Math.min(100, score));
}

export function diagnoseBots(
  bots: Bot[],
  trades: Trade[],
  currentPrices: Record<string, number>,
  riskCfg: RiskConfig,
): BotDiagnostic[] {
  return bots.map(bot => {
    const botTrades = trades.filter(t => t.botId === bot.id);
    const price = currentPrices[bot.symbol] || 1;
    const metrics = computeMetrics(bot, botTrades, price);
    const issues  = detectIssues(metrics, riskCfg);
    const healthScore = calcHealthScore(metrics, issues);

    const totalValue = bot.balance + bot.position * price;
    const pnlPct = ((totalValue - bot.startingBalance) / bot.startingBalance) * 100;
    const sells  = botTrades.filter(t => t.type === 'SELL');
    const winRate = sells.length > 0 ? (sells.filter(t => t.pnl > 0).length / sells.length) * 100 : 0;
    const status = determineBotStatus(pnlPct, metrics.maxDrawdown, winRate, sells.length, riskCfg);

    return {
      botId: bot.id,
      botName: bot.name,
      symbol: bot.symbol,
      strategy: bot.strategy,
      color: bot.color,
      status,
      healthScore,
      issues,
      metrics,
      lastChecked: Date.now(),
    };
  });
}
