
// ─── Platform-wide configuration and state ───────────────────────────────────

export const PLATFORM_FEE_RATE = 0.001; // 0.1% per trade (taker fee)
export const MAKER_FEE_RATE   = 0.0005; // 0.05%
export const RISK_FREE_RATE   = 0.0425; // 4.25% annual for Sharpe calc

export type UserRole = 'admin' | 'trader' | 'viewer';
export type ExchangeMode = 'demo' | 'testnet' | 'live';
export type BotStatus = 'Active' | 'Watch' | 'Limited' | 'Disabled' | 'Replaced';

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: number;
  lastLogin: number;
  virtualBalance: number;
  totalDeposited: number;
  totalWithdrawn: number;
}

export interface RiskConfig {
  maxDailyLossPercent: number;     // e.g. 5 = max 5% daily loss
  maxBotDrawdownPercent: number;   // e.g. 20 = replace bot if >20% DD
  maxUserExposurePercent: number;  // max % of capital in open positions
  maxSymbolExposurePercent: number;
  emergencyStopLoss: number;       // absolute $ loss to trigger kill switch
  safeMode: boolean;
  tradingEnabled: boolean;
}

export interface ExchangeConnection {
  id: string;
  exchange: 'binance' | 'bybit' | 'okx' | 'demo';
  mode: ExchangeMode;
  apiKeyMasked: string;
  isConnected: boolean;
  lastSync: number;
  balance: Record<string, number>;
  permissions: string[];
  error?: string;
}

export interface FeeAdjustedMetric {
  grossPnl: number;
  totalFees: number;
  netPnl: number;
  netReturn: number;
  feeImpactPercent: number;
}

// ── Storage keys ──────────────────────────────────────────────────────────────
const USER_KEY     = 'sx_user';
const RISK_KEY     = 'sx_risk_config';
const EXCHANGE_KEY = 'sx_exchange';
const ALERTS_KEY   = 'sx_alerts';

// ── Default objects ───────────────────────────────────────────────────────────
export const DEFAULT_USER: PlatformUser = {
  id: 'admin_001',
  name: 'Arena Admin',
  email: 'admin@signalx.ai',
  role: 'admin',
  createdAt: Date.now() - 30 * 86_400_000,
  lastLogin: Date.now(),
  virtualBalance: 50_000,
  totalDeposited: 50_000,
  totalWithdrawn: 0,
};

export const DEFAULT_RISK: RiskConfig = {
  maxDailyLossPercent: 5,
  maxBotDrawdownPercent: 20,
  maxUserExposurePercent: 80,
  maxSymbolExposurePercent: 30,
  emergencyStopLoss: 5000,
  safeMode: false,
  tradingEnabled: true,
};

export const DEMO_EXCHANGE: ExchangeConnection = {
  id: 'demo_exchange',
  exchange: 'demo',
  mode: 'demo',
  apiKeyMasked: 'DEMO-****-****-****',
  isConnected: true,
  lastSync: Date.now(),
  balance: { USDT: 50000, BTC: 0.5, ETH: 5, SOL: 50 },
  permissions: ['read', 'trade'],
};

// ── CRUD helpers ──────────────────────────────────────────────────────────────
export function loadUser(): PlatformUser {
  try {
    const r = localStorage.getItem(USER_KEY);
    return r ? JSON.parse(r) : DEFAULT_USER;
  } catch { return DEFAULT_USER; }
}

export function saveUser(u: PlatformUser) {
  localStorage.setItem(USER_KEY, JSON.stringify(u));
}

export function loadRisk(): RiskConfig {
  try {
    const r = localStorage.getItem(RISK_KEY);
    return r ? { ...DEFAULT_RISK, ...JSON.parse(r) } : DEFAULT_RISK;
  } catch { return DEFAULT_RISK; }
}

export function saveRisk(r: RiskConfig) {
  localStorage.setItem(RISK_KEY, JSON.stringify(r));
}

export function loadExchange(): ExchangeConnection {
  try {
    const r = localStorage.getItem(EXCHANGE_KEY);
    return r ? JSON.parse(r) : DEMO_EXCHANGE;
  } catch { return DEMO_EXCHANGE; }
}

export function saveExchange(e: ExchangeConnection) {
  localStorage.setItem(EXCHANGE_KEY, JSON.stringify(e));
}

export interface AlertRecord {
  id: string;
  level: 'info' | 'warn' | 'critical';
  message: string;
  timestamp: number;
  dismissed: boolean;
  source: string;
}

export function loadAlerts(): AlertRecord[] {
  try {
    const r = localStorage.getItem(ALERTS_KEY);
    return r ? JSON.parse(r) : [];
  } catch { return []; }
}

export function saveAlerts(a: AlertRecord[]) {
  localStorage.setItem(ALERTS_KEY, JSON.stringify(a.slice(-200)));
}

export function addAlert(level: AlertRecord['level'], message: string, source: string) {
  const alerts = loadAlerts();
  alerts.push({ id: `alert_${Date.now()}`, level, message, timestamp: Date.now(), dismissed: false, source });
  saveAlerts(alerts);
}

// ── Fee calculation ───────────────────────────────────────────────────────────
export function calcFeeAdjusted(
  grossPnl: number,
  tradeCount: number,
  avgTradeValue: number,
  startingBalance: number,
): FeeAdjustedMetric {
  const totalFees = tradeCount * avgTradeValue * PLATFORM_FEE_RATE;
  const netPnl = grossPnl - totalFees;
  const netReturn = startingBalance > 0 ? (netPnl / startingBalance) * 100 : 0;
  const feeImpactPercent = Math.abs(grossPnl) > 0 ? (totalFees / Math.abs(grossPnl)) * 100 : 0;
  return { grossPnl, totalFees, netPnl, netReturn, feeImpactPercent };
}

// ── Bot status rules ──────────────────────────────────────────────────────────
export function determineBotStatus(
  pnlPct: number,
  drawdown: number,
  winRate: number,
  tradeCount: number,
  riskConfig: RiskConfig,
): BotStatus {
  if (drawdown > riskConfig.maxBotDrawdownPercent) return 'Replaced';
  if (pnlPct < -15 || winRate < 20) return 'Disabled';
  if (pnlPct < -8 || drawdown > 12 || tradeCount < 3) return 'Limited';
  if (pnlPct < -3 || winRate < 35) return 'Watch';
  return 'Active';
}
