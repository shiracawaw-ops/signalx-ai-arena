
export interface Bot {
  id: string;
  name: string;
  symbol: string;
  strategy: string;
  balance: number;
  startingBalance: number;
  position: number;
  avgEntryPrice: number;
  trades: Trade[];
  isRunning: boolean;
  createdAt: number;
  color: string;
}

export interface Trade {
  id: string;
  botId: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  timestamp: number;
  pnl: number;
  indicators: string;
  fee?: number;
}

const BOTS_KEY = 'signalx_bots';
const TRADES_KEY = 'signalx_trades';

export function loadBots(): Bot[] {
  try {
    const raw = localStorage.getItem(BOTS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveBots(bots: Bot[]): void {
  localStorage.setItem(BOTS_KEY, JSON.stringify(bots));
}

export function loadTrades(): Trade[] {
  try {
    const raw = localStorage.getItem(TRADES_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

const MAX_TRADES_STORED = 2000;

export function saveTrades(trades: Trade[]): void {
  // Always cap to the most recent trades before storing
  const capped = trades.length > MAX_TRADES_STORED
    ? trades.slice(-MAX_TRADES_STORED)
    : trades;
  try {
    localStorage.setItem(TRADES_KEY, JSON.stringify(capped));
  } catch {
    // If quota still exceeded, trim further and retry
    const trimmed = capped.slice(-Math.floor(MAX_TRADES_STORED / 2));
    try {
      localStorage.setItem(TRADES_KEY, JSON.stringify(trimmed));
    } catch {
      // Last resort: clear and save only the most recent 200
      localStorage.removeItem(TRADES_KEY);
      localStorage.setItem(TRADES_KEY, JSON.stringify(capped.slice(-200)));
    }
  }
}

export function clearAllData(): void {
  localStorage.removeItem(BOTS_KEY);
  localStorage.removeItem(TRADES_KEY);
}

export const BOT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
  '#f97316', '#14b8a6', '#a855f7', '#e11d48',
];

export type AssetCategory = 'Crypto' | 'Stocks' | 'Metals' | 'Forex';

export interface AssetInfo {
  symbol: string;
  name: string;
  category: AssetCategory;
  basePrice: number;
  volatility: number; // daily %, e.g. 0.03 = 3%
}

export const ASSETS: AssetInfo[] = [
  // ── Crypto (April 2026 prices) ───────────────────────
  { symbol: 'BTC',    name: 'Bitcoin',          category: 'Crypto',  basePrice: 84000,  volatility: 0.025 },
  { symbol: 'ETH',    name: 'Ethereum',         category: 'Crypto',  basePrice: 1950,   volatility: 0.028 },
  { symbol: 'BNB',    name: 'BNB',              category: 'Crypto',  basePrice: 615,    volatility: 0.030 },
  { symbol: 'SOL',    name: 'Solana',           category: 'Crypto',  basePrice: 135,    volatility: 0.035 },
  { symbol: 'XRP',    name: 'Ripple',           category: 'Crypto',  basePrice: 2.20,   volatility: 0.032 },
  { symbol: 'ADA',    name: 'Cardano',          category: 'Crypto',  basePrice: 0.72,   volatility: 0.035 },
  { symbol: 'DOGE',   name: 'Dogecoin',         category: 'Crypto',  basePrice: 0.18,   volatility: 0.040 },
  { symbol: 'AVAX',   name: 'Avalanche',        category: 'Crypto',  basePrice: 25,     volatility: 0.038 },
  { symbol: 'LINK',   name: 'Chainlink',        category: 'Crypto',  basePrice: 14,     volatility: 0.033 },
  { symbol: 'LTC',    name: 'Litecoin',         category: 'Crypto',  basePrice: 92,     volatility: 0.025 },
  { symbol: 'DOT',    name: 'Polkadot',         category: 'Crypto',  basePrice: 6.5,    volatility: 0.035 },
  { symbol: 'ATOM',   name: 'Cosmos',           category: 'Crypto',  basePrice: 6.8,    volatility: 0.033 },
  // ── Global Stocks (April 2026) ───────────────────────
  { symbol: 'AAPL',   name: 'Apple',            category: 'Stocks',  basePrice: 225,    volatility: 0.012 },
  { symbol: 'TSLA',   name: 'Tesla',            category: 'Stocks',  basePrice: 290,    volatility: 0.022 },
  { symbol: 'NVDA',   name: 'NVIDIA',           category: 'Stocks',  basePrice: 1050,   volatility: 0.020 },
  { symbol: 'MSFT',   name: 'Microsoft',        category: 'Stocks',  basePrice: 475,    volatility: 0.011 },
  { symbol: 'AMZN',   name: 'Amazon',           category: 'Stocks',  basePrice: 225,    volatility: 0.014 },
  { symbol: 'GOOGL',  name: 'Alphabet',         category: 'Stocks',  basePrice: 190,    volatility: 0.013 },
  { symbol: 'META',   name: 'Meta',             category: 'Stocks',  basePrice: 630,    volatility: 0.016 },
  { symbol: 'NFLX',   name: 'Netflix',          category: 'Stocks',  basePrice: 1050,   volatility: 0.018 },
  { symbol: 'BABA',   name: 'Alibaba',          category: 'Stocks',  basePrice: 110,    volatility: 0.020 },
  { symbol: 'TSM',    name: 'TSMC',             category: 'Stocks',  basePrice: 195,    volatility: 0.017 },
  { symbol: 'JPM',    name: 'JPMorgan',         category: 'Stocks',  basePrice: 280,    volatility: 0.013 },
  { symbol: 'V',      name: 'Visa',             category: 'Stocks',  basePrice: 365,    volatility: 0.010 },
  { symbol: 'SAMSUNG',name: 'Samsung',          category: 'Stocks',  basePrice: 72,     volatility: 0.015 },
  { symbol: 'TOYOTA', name: 'Toyota',           category: 'Stocks',  basePrice: 235,    volatility: 0.012 },
  // ── Metals & Commodities (April 2026) ────────────────
  { symbol: 'GOLD',   name: 'Gold',             category: 'Metals',  basePrice: 3050,   volatility: 0.008 },
  { symbol: 'SILVER', name: 'Silver',           category: 'Metals',  basePrice: 33.5,   volatility: 0.012 },
  { symbol: 'PLAT',   name: 'Platinum',         category: 'Metals',  basePrice: 1020,   volatility: 0.010 },
  { symbol: 'COPPER', name: 'Copper',           category: 'Metals',  basePrice: 4.70,   volatility: 0.011 },
  { symbol: 'OIL',    name: 'Crude Oil (WTI)',  category: 'Metals',  basePrice: 72,     volatility: 0.015 },
  { symbol: 'NG',     name: 'Natural Gas',      category: 'Metals',  basePrice: 2.80,   volatility: 0.020 },
  // ── Forex ────────────────────────────────────────────
  { symbol: 'EURUSD', name: 'Euro / USD',       category: 'Forex',   basePrice: 1.095,  volatility: 0.004 },
  { symbol: 'GBPUSD', name: 'GBP / USD',        category: 'Forex',   basePrice: 1.300,  volatility: 0.005 },
  { symbol: 'USDJPY', name: 'USD / Yen',        category: 'Forex',   basePrice: 148.5,  volatility: 0.004 },
  { symbol: 'USDCHF', name: 'USD / CHF',        category: 'Forex',   basePrice: 0.882,  volatility: 0.003 },
  { symbol: 'AUDUSD', name: 'AUD / USD',        category: 'Forex',   basePrice: 0.642,  volatility: 0.005 },
  { symbol: 'USDCAD', name: 'USD / CAD',        category: 'Forex',   basePrice: 1.390,  volatility: 0.004 },
];

export const ASSET_MAP: Record<string, AssetInfo> = Object.fromEntries(ASSETS.map(a => [a.symbol, a]));

export const SYMBOLS = ASSETS.map(a => a.symbol);
export const STRATEGIES = ['RSI', 'MACD', 'VWAP', 'Bollinger', 'SMA Cross', 'Breakout', 'Multi-Signal'];
export const CATEGORIES: AssetCategory[] = ['Crypto', 'Stocks', 'Metals', 'Forex'];
