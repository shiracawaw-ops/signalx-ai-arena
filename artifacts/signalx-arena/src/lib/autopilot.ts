
import { Bot, Trade } from './storage';
import { getBotPnL, getBotTotalValue } from './engine';

export type AutoPilotAction = 'BUY' | 'SELL' | 'HOLD';
export type RiskLevel = 'SAFE' | 'MODERATE' | 'HIGH' | 'DANGER';
export type AutoPilotHoldReasonCode =
  | 'no_breakout'
  | 'trend_filter_failed'
  | 'momentum_filter_failed'
  | 'risk_gate_prevented_entry'
  | 'symbol_level_block'
  | 'market_regime_says_hold'
  | 'no_entry_signal'
  | 'confidence_below_threshold';

export interface AutoPilotHoldReason {
  code: AutoPilotHoldReasonCode;
  message: string;
}

export interface BotEvaluation {
  bot:          Bot;
  score:        number;
  pnl:          number;
  pnlPct:       number;
  winRate:      number;
  drawdown:     number;
  tradeCount:   number;
  recentWins:   number;
  recentLosses: number;
  health:       'excellent' | 'good' | 'warning' | 'critical';
  action:       AutoPilotAction;
  confidence:   number;
  reasons:      string[];
}

export interface AutoPilotDecision {
  selectedBot:    BotEvaluation | null;
  topBots:        BotEvaluation[];
  riskLevel:      RiskLevel;
  riskReason:     string;
  masterAction:   AutoPilotAction;
  holdReasons:    AutoPilotHoldReason[];
  portfolioPnL:   number;
  portfolioPnLPct:number;
  activeBotCount: number;
  timestamp:      number;
}

export interface DecisionLogEntry {
  id:        string;
  timestamp: number;
  type:      'select' | 'risk' | 'replace' | 'hold' | 'resume';
  message:   string;
  level:     'info' | 'warn' | 'danger' | 'success';
}

export const AUTOPILOT_CONFIDENCE_FLOOR = 50;

// ── Score a single bot ─────────────────────────────────────────────────────
function scoreBot(
  bot: Bot,
  trades: Trade[],
  getCurrentPrice: (s: string) => number,
): BotEvaluation {
  const price      = getCurrentPrice(bot.symbol);
  const totalValue = getBotTotalValue(bot, price);
  const pnl        = getBotPnL(bot, price);
  const pnlPct     = bot.startingBalance > 0
    ? ((totalValue - bot.startingBalance) / bot.startingBalance) * 100
    : 0;

  const botTrades   = trades.filter(t => t.botId === bot.id);
  const sells       = botTrades.filter(t => t.type === 'SELL');
  const winSells    = sells.filter(t => t.pnl > 0);
  const winRate     = sells.length > 0 ? (winSells.length / sells.length) * 100 : 50;

  const recent       = sells.slice(-5);
  const recentWins   = recent.filter(t => t.pnl > 0).length;
  const recentLosses = recent.filter(t => t.pnl <= 0).length;
  const recentWinRate = recent.length > 0 ? (recentWins / recent.length) * 100 : 50;

  const drawdown = bot.startingBalance > 0
    ? Math.max(0, ((bot.startingBalance - totalValue) / bot.startingBalance) * 100)
    : 0;
  const tradeCount = botTrades.length;

  let health: BotEvaluation['health'];
  if (pnlPct >= 3)        health = 'excellent';
  else if (pnlPct >= 0)   health = 'good';
  else if (pnlPct >= -5)  health = 'warning';
  else                    health = 'critical';

  // Composite score (0–100)
  const pnlScore       = Math.max(0, Math.min(100, (pnlPct + 10) * (100 / 30)));
  const winScore       = winRate;
  const recentScore    = recentWinRate;
  const stabilityScore = Math.max(0, 100 - drawdown * 5);
  const activityScore  = Math.min(100, tradeCount * 4);

  const score = (pnlScore * 0.35) + (winScore * 0.25) + (recentScore * 0.20)
              + (stabilityScore * 0.15) + (activityScore * 0.05);

  // Action & reasons
  // eslint-disable-next-line no-useless-assignment
  let action: AutoPilotAction = 'HOLD';
  const reasons: string[] = [];

  if (pnlPct < -8) {
    action = 'HOLD';
    reasons.push(`PnL at ${pnlPct.toFixed(1)}% — holding for stability`);
  } else if (bot.position > 0) {
    if (pnlPct > 0) {
      action = 'HOLD';
      reasons.push(`Long position open — riding +${pnlPct.toFixed(1)}% gain`);
    } else {
      action = 'SELL';
      reasons.push(`Open position in drawdown — exit considered`);
    }
  } else {
    if (recentWins >= 3) {
      action = 'BUY';
      reasons.push(`${recentWins}/5 recent wins — strong momentum`);
    } else if (pnlPct > 1 && winRate > 55) {
      action = 'BUY';
      reasons.push(`Win rate ${winRate.toFixed(0)}% — healthy entry signal`);
    } else if (recentLosses >= 3) {
      action = 'HOLD';
      reasons.push(`${recentLosses}/5 recent losses — waiting for setup`);
    } else {
      action = 'HOLD';
      reasons.push(`Monitoring market conditions`);
    }
  }

  if (score > 70)    reasons.push(`High composite score: ${score.toFixed(0)}/100`);
  if (drawdown < 1)  reasons.push(`Capital fully protected — 0% drawdown`);
  if (winRate > 60)  reasons.push(`Win rate ${winRate.toFixed(0)}% exceeds benchmark`);
  if (tradeCount === 0) reasons.push(`Warming up — no trade history yet`);

  const confidence = Math.min(95, score * 0.85 + (tradeCount > 5 ? 12 : 0));

  return {
    bot, score, pnl, pnlPct, winRate, drawdown,
    tradeCount, recentWins, recentLosses, health,
    action, confidence, reasons,
  };
}

export function evaluateBots(
  bots: Bot[],
  trades: Trade[],
  getCurrentPrice: (s: string) => number,
  opts: { eligibleBotIds?: Iterable<string> } = {},
): BotEvaluation[] {
  const eligible = opts.eligibleBotIds ? new Set(opts.eligibleBotIds) : null;
  const activeBots = bots.filter(b => b.isRunning && (!eligible || eligible.has(b.id)));
  const evaluations = activeBots.map(b => scoreBot(b, trades, getCurrentPrice));
  evaluations.sort((a, b) => b.score - a.score);
  return evaluations;
}

// ── Portfolio risk ────────────────────────────────────────────────────────
function assessRisk(
  bots: Bot[],
  trades: Trade[],
  getCurrentPrice: (s: string) => number,
) {
  const activeBots     = bots.filter(b => b.isRunning);
  const totalPortfolio = activeBots.reduce((s, b) => s + getBotTotalValue(b, getCurrentPrice(b.symbol)), 0);
  const totalStarting  = activeBots.reduce((s, b) => s + b.startingBalance, 0);
  const portfolioPnL   = totalPortfolio - totalStarting;
  const portfolioPnLPct = totalStarting > 0 ? (portfolioPnL / totalStarting) * 100 : 0;

  const maxDrawdown = activeBots.reduce((max, b) => {
    const botValue = getBotTotalValue(b, getCurrentPrice(b.symbol));
    const dd = b.startingBalance > 0
      ? Math.max(0, ((b.startingBalance - botValue) / b.startingBalance) * 100)
      : 0;
    return Math.max(max, dd);
  }, 0);

  const recentSells   = trades.filter(t => t.type === 'SELL').slice(-20);
  const recentLossRate = recentSells.length > 0
    ? (recentSells.filter(t => t.pnl < 0).length / recentSells.length) * 100
    : 0;

  let riskLevel: RiskLevel;
  let riskReason: string;

  if (portfolioPnLPct < -3 || maxDrawdown > 15) {
    riskLevel  = 'DANGER';
    riskReason = portfolioPnLPct < -3
      ? `Daily loss limit breached (${portfolioPnLPct.toFixed(1)}% / −3% limit) — all positions paused`
      : `Critical bot drawdown ${maxDrawdown.toFixed(1)}% — emergency risk mode`;
  } else if (portfolioPnLPct < -1.5 || maxDrawdown > 8 || recentLossRate > 65) {
    riskLevel  = 'HIGH';
    riskReason = maxDrawdown > 8
      ? `Elevated drawdown ${maxDrawdown.toFixed(1)}% — reducing exposure`
      : recentLossRate > 65
        ? `${recentLossRate.toFixed(0)}% of recent trades unprofitable — market shift detected`
        : `Portfolio down ${Math.abs(portfolioPnLPct).toFixed(1)}% — approaching daily limit`;
  } else if (portfolioPnLPct < -0.5 || recentLossRate > 45) {
    riskLevel  = 'MODERATE';
    riskReason = recentLossRate > 45
      ? `Mixed recent performance — monitoring strategy alignment`
      : `Minor drawdown ${Math.abs(portfolioPnLPct).toFixed(1)}% — within safe parameters`;
  } else {
    riskLevel  = 'SAFE';
    riskReason = portfolioPnLPct >= 0
      ? `Portfolio up ${portfolioPnLPct.toFixed(2)}% — all systems optimal`
      : `Negligible drawdown — risk parameters healthy`;
  }

  return { riskLevel, riskReason, portfolioPnL, portfolioPnLPct };
}

// ── Main decision function — call every 5 seconds ─────────────────────────
export function computeAutoPilotDecision(
  bots: Bot[],
  trades: Trade[],
  getCurrentPrice: (s: string) => number,
  opts: { eligibleBotIds?: Iterable<string> } = {},
): AutoPilotDecision {
  const risk       = assessRisk(bots, trades, getCurrentPrice);
  const eligible   = opts.eligibleBotIds ? new Set(opts.eligibleBotIds) : null;
  const activeBots = bots.filter(b => b.isRunning);
  const eligibleActiveCount = eligible
    ? activeBots.filter(b => eligible.has(b.id)).length
    : activeBots.length;
  const evaluations = evaluateBots(bots, trades, getCurrentPrice, opts);

  // AutoPilot confidence floor — never let a low-confidence bot drive the
  // master action. Bots warming up (no trade history) or with a poor track
  // record (low pnl + low recent win rate) score < 50 in scoreBot. Picking
  // them as the master action driver is what produces the "AutoPilot fired
  // BUY but it lost immediately" experience. Below the floor we still
  // expose `topBots` for the UI, but the SELECTED bot (and therefore the
  // dispatch action) is gated. Floor of 50 chosen to match the "good"
  // health threshold (pnlPct >= 0 → score weighting >= 50-ish).
  const topBots     = evaluations.slice(0, 3);
  const qualifying  = evaluations.filter(e => e.confidence >= AUTOPILOT_CONFIDENCE_FLOOR);
  const selectedBot = qualifying[0] ?? null;

  let masterAction: AutoPilotAction = selectedBot?.action ?? 'HOLD';
  const holdReasons: AutoPilotHoldReason[] = [];
  if (!selectedBot) {
    holdReasons.push({
      code: 'confidence_below_threshold',
      message: `No bot passed confidence floor (${AUTOPILOT_CONFIDENCE_FLOOR}%).`,
    });
    if (eligible && activeBots.length > 0 && eligibleActiveCount === 0) {
      holdReasons.push({
        code: 'symbol_level_block',
        message: 'No running bot currently sits in the real-eligible fleet set. Move bots out of standby/paper or lower active real bot count.',
      });
    }
  }
  if (risk.riskLevel === 'DANGER') masterAction = 'HOLD';
  else if (risk.riskLevel === 'HIGH' && masterAction === 'BUY') masterAction = 'HOLD';

  if (risk.riskLevel === 'DANGER') {
    holdReasons.push({
      code: 'market_regime_says_hold',
      message: `Risk level ${risk.riskLevel}: ${risk.riskReason}`,
    });
  } else if (risk.riskLevel === 'HIGH' && selectedBot?.action === 'BUY' && masterAction === 'HOLD') {
    holdReasons.push({
      code: 'risk_gate_prevented_entry',
      message: `Risk level ${risk.riskLevel} blocked BUY: ${risk.riskReason}`,
    });
  }

  if (masterAction === 'HOLD' && selectedBot?.action === 'HOLD') {
    holdReasons.push({
      code: 'no_entry_signal',
      message: selectedBot.reasons[0] ?? 'Selected bot has no actionable entry signal.',
    });
  }

  return {
    selectedBot,
    topBots,
    riskLevel:       risk.riskLevel,
    riskReason:      risk.riskReason,
    masterAction,
    holdReasons,
    portfolioPnL:    risk.portfolioPnL,
    portfolioPnLPct: risk.portfolioPnLPct,
    activeBotCount:  activeBots.length,
    timestamp:       Date.now(),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────
export function makeLogEntry(
  type: DecisionLogEntry['type'],
  message: string,
  level: DecisionLogEntry['level'] = 'info',
): DecisionLogEntry {
  return { id: `log_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, timestamp: Date.now(), type, message, level };
}
