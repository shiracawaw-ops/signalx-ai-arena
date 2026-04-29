
import { Bot, Trade } from './storage';
import { getBotPnL, getBotTotalValue } from './engine';

export type AutoPilotAction = 'BUY' | 'SELL' | 'HOLD';
export type RiskLevel = 'SAFE' | 'MODERATE' | 'HIGH' | 'DANGER';

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
  portfolioPnL:   number;
  portfolioPnLPct:number;
  activeBotCount: number;
  timestamp:      number;
}

// Shared confidence floor used by AutoPilot selection and the smart-scalper
// gate in execution-engine so both paths enforce the same minimum signal
// quality before permitting new entries.
export const AUTOPILOT_CONFIDENCE_FLOOR = 50;

export interface DecisionLogEntry {
  id:        string;
  timestamp: number;
  type:      'select' | 'risk' | 'replace' | 'hold' | 'resume';
  message:   string;
  level:     'info' | 'warn' | 'danger' | 'success';
}

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

  const drawdown = Math.max(0, ((bot.startingBalance - bot.balance) / bot.startingBalance) * 100);
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
    const dd = Math.max(0, ((b.startingBalance - b.balance) / b.startingBalance) * 100);
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
): AutoPilotDecision {
  const risk       = assessRisk(bots, trades, getCurrentPrice);
  const activeBots = bots.filter(b => b.isRunning);

  const evaluations = activeBots.map(b => scoreBot(b, trades, getCurrentPrice));
  evaluations.sort((a, b) => b.score - a.score);

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
  if (risk.riskLevel === 'DANGER') masterAction = 'HOLD';
  else if (risk.riskLevel === 'HIGH' && masterAction === 'BUY') masterAction = 'HOLD';

  return {
    selectedBot,
    topBots,
    riskLevel:       risk.riskLevel,
    riskReason:      risk.riskReason,
    masterAction,
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
