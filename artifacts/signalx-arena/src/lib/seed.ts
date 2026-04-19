
import { Bot, Trade, BOT_COLORS, ASSETS, STRATEGIES } from './storage';
import { MarketData, executeBotTick, tickMarket, initMarket } from './engine';

// ── Name pools for extended bot generation ───────────────────────────────────
const NAME_PREFIXES = [
  'Alpha','Beta','Gamma','Delta','Sigma','Omega','Apex','Nova','Blitz','Surge',
  'Storm','Ghost','Falcon','Titan','Eagle','Viper','Phantom','Shadow','Vector',
  'Forge','Nexus','Pulse','Edge','Prime','Force','Flux','Sonic','Turbo','Ultra',
  'Hyper','Mega','Nano','Zero','Void','Dark','Iron','Steel','Fire','Ice','Arc',
];
const NAME_SUFFIXES = [
  'Hunter','Ranger','Stalker','Striker','Sniper','Crusher','Raider','Blazer',
  'Runner','Drifter','Jumper','Seeker','Scout','Guard','Watcher','Keeper',
  'Oracle','Wizard','Ninja','Knight','Rogue','Samurai','Viking','Gladiator',
];

// ── Fixed seed definitions (first 50) ───────────────────────────────────────
const SEED_DEFS: Array<{ name: string; symbol: string; strategy: string; colorIdx: number }> = [
  { name: 'BTC Sniper',    symbol: 'BTC',    strategy: 'RSI',          colorIdx: 0  },
  { name: 'ETH Blitz',     symbol: 'ETH',    strategy: 'MACD',         colorIdx: 1  },
  { name: 'SOL Rocket',    symbol: 'SOL',    strategy: 'Breakout',     colorIdx: 2  },
  { name: 'BNB Hawk',      symbol: 'BNB',    strategy: 'VWAP',         colorIdx: 3  },
  { name: 'XRP Phantom',   symbol: 'XRP',    strategy: 'Multi-Signal', colorIdx: 4  },
  { name: 'DOGE Hunter',   symbol: 'DOGE',   strategy: 'RSI',          colorIdx: 5  },
  { name: 'AVAX Surge',    symbol: 'AVAX',   strategy: 'Bollinger',    colorIdx: 6  },
  { name: 'LINK Oracle',   symbol: 'LINK',   strategy: 'SMA Cross',    colorIdx: 7  },
  { name: 'LTC Ghost',     symbol: 'LTC',    strategy: 'MACD',         colorIdx: 8  },
  { name: 'ADA Viper',     symbol: 'ADA',    strategy: 'Breakout',     colorIdx: 9  },
  { name: 'DOT Pulse',     symbol: 'DOT',    strategy: 'VWAP',         colorIdx: 10 },
  { name: 'ATOM Gravity',  symbol: 'ATOM',   strategy: 'RSI',          colorIdx: 11 },
  { name: 'BTC Falcon',    symbol: 'BTC',    strategy: 'Multi-Signal', colorIdx: 2  },
  { name: 'ETH Specter',   symbol: 'ETH',    strategy: 'Bollinger',    colorIdx: 4  },
  { name: 'SOL Nova',      symbol: 'SOL',    strategy: 'MACD',         colorIdx: 6  },
  { name: 'XRP Storm',     symbol: 'XRP',    strategy: 'SMA Cross',    colorIdx: 8  },
  { name: 'AAPL Titan',    symbol: 'AAPL',   strategy: 'RSI',          colorIdx: 0  },
  { name: 'TSLA Fury',     symbol: 'TSLA',   strategy: 'Multi-Signal', colorIdx: 2  },
  { name: 'NVDA Alpha',    symbol: 'NVDA',   strategy: 'Bollinger',    colorIdx: 4  },
  { name: 'MSFT Sigma',    symbol: 'MSFT',   strategy: 'SMA Cross',    colorIdx: 6  },
  { name: 'AMZN Apex',     symbol: 'AMZN',   strategy: 'VWAP',         colorIdx: 8  },
  { name: 'META Storm',    symbol: 'META',   strategy: 'MACD',         colorIdx: 10 },
  { name: 'GOOGL Stealth', symbol: 'GOOGL',  strategy: 'RSI',          colorIdx: 1  },
  { name: 'NFLX Pulse',    symbol: 'NFLX',   strategy: 'Breakout',     colorIdx: 3  },
  { name: 'TSM Nexus',     symbol: 'TSM',    strategy: 'Multi-Signal', colorIdx: 5  },
  { name: 'JPM Shield',    symbol: 'JPM',    strategy: 'Bollinger',    colorIdx: 7  },
  { name: 'BABA Dragon',   symbol: 'BABA',   strategy: 'RSI',          colorIdx: 9  },
  { name: 'V Precision',   symbol: 'V',      strategy: 'SMA Cross',    colorIdx: 11 },
  { name: 'SAMSUNG Edge',  symbol: 'SAMSUNG',strategy: 'MACD',         colorIdx: 0  },
  { name: 'TOYOTA Drift',  symbol: 'TOYOTA', strategy: 'VWAP',         colorIdx: 2  },
  { name: 'AAPL Eclipse',  symbol: 'AAPL',   strategy: 'Breakout',     colorIdx: 4  },
  { name: 'TSLA Voltage',  symbol: 'TSLA',   strategy: 'VWAP',         colorIdx: 6  },
  { name: 'NVDA Omega',    symbol: 'NVDA',   strategy: 'RSI',          colorIdx: 8  },
  { name: 'META Cipher',   symbol: 'META',   strategy: 'SMA Cross',    colorIdx: 10 },
  { name: 'Gold Omega',    symbol: 'GOLD',   strategy: 'RSI',          colorIdx: 9  },
  { name: 'Silver Nova',   symbol: 'SILVER', strategy: 'MACD',         colorIdx: 11 },
  { name: 'Oil Crusher',   symbol: 'OIL',    strategy: 'Breakout',     colorIdx: 0  },
  { name: 'Platinum Edge', symbol: 'PLAT',   strategy: 'SMA Cross',    colorIdx: 2  },
  { name: 'Copper Core',   symbol: 'COPPER', strategy: 'Bollinger',    colorIdx: 4  },
  { name: 'Gas Phantom',   symbol: 'NG',     strategy: 'VWAP',         colorIdx: 6  },
  { name: 'Gold Titan',    symbol: 'GOLD',   strategy: 'Multi-Signal', colorIdx: 8  },
  { name: 'Oil Specter',   symbol: 'OIL',    strategy: 'RSI',          colorIdx: 10 },
  { name: 'EUR Ranger',    symbol: 'EURUSD', strategy: 'VWAP',         colorIdx: 4  },
  { name: 'GBP Thunder',   symbol: 'GBPUSD', strategy: 'RSI',          colorIdx: 6  },
  { name: 'JPY Shadow',    symbol: 'USDJPY', strategy: 'Bollinger',    colorIdx: 8  },
  { name: 'CHF Fortress',  symbol: 'USDCHF', strategy: 'Multi-Signal', colorIdx: 10 },
  { name: 'AUD Drifter',   symbol: 'AUDUSD', strategy: 'SMA Cross',    colorIdx: 1  },
  { name: 'CAD Infinity',  symbol: 'USDCAD', strategy: 'MACD',         colorIdx: 3  },
  { name: 'EUR Vortex',    symbol: 'EURUSD', strategy: 'Breakout',     colorIdx: 5  },
  { name: 'GBP Stealth',   symbol: 'GBPUSD', strategy: 'MACD',         colorIdx: 7  },
];

// Standby pool added on top of the active count — always ready to replace weak bots
export const STANDBY_POOL_SIZE = 10;

// ── Generate a bot definition for index >= 50 ────────────────────────────────
function genDef(idx: number) {
  const syms = ASSETS.map(a => a.symbol);
  const symbol   = syms[idx % syms.length];
  const strategy = STRATEGIES[idx % STRATEGIES.length];
  const prefix   = NAME_PREFIXES[idx % NAME_PREFIXES.length];
  const suffix   = NAME_SUFFIXES[Math.floor(idx / NAME_PREFIXES.length) % NAME_SUFFIXES.length];
  const colorIdx = idx % BOT_COLORS.length;
  return { name: `${symbol} ${prefix} ${suffix}`, symbol, strategy, colorIdx };
}

function makeBot(
  def: { name: string; symbol: string; strategy: string; colorIdx: number },
  idx: number,
  startingBalance: number,
  isStandby = false,
): Bot {
  return {
    id: `bot_${idx}`,
    name: def.name,
    symbol: def.symbol,
    strategy: def.strategy,
    balance: startingBalance,
    startingBalance,
    position: 0,
    avgEntryPrice: 0,
    trades: [],
    isRunning: !isStandby,         // standby bots start paused, all others active
    createdAt: Date.now() - (600 - idx) * 60_000,
    color: BOT_COLORS[def.colorIdx % BOT_COLORS.length],
  };
}

// ── Make a fresh standby bot (for pool refill after replacement) ──────────────
export function makeFreshStandbyBot(startingBalance: number, existingCount: number): Bot {
  const idx    = existingCount;
  const def    = idx < SEED_DEFS.length ? SEED_DEFS[idx] : genDef(idx);
  const color  = BOT_COLORS[idx % BOT_COLORS.length];
  return {
    id: `bot_fresh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: `${def.name} II`,
    symbol: def.symbol,
    strategy: def.strategy,
    balance: startingBalance,
    startingBalance,
    position: 0,
    avgEntryPrice: 0,
    trades: [],
    isRunning: false,
    createdAt: Date.now(),
    color,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
// Generates `count` ACTIVE bots + STANDBY_POOL_SIZE standby bots.
// All active bots run from tick 1; standby bots wait to replace weak ones.
export function generateBots(
  count: number,
  startingBalance: number,
): { bots: Bot[]; trades: Trade[]; market: MarketData } {
  const totalBots   = count + STANDBY_POOL_SIZE;
  // Warm-up: enough to seed candle history, small enough to avoid PnL skew
  const warmupTicks = count <= 10 ? 20 : count <= 50 ? 25 : count <= 100 ? 20 : count <= 200 ? 15 : 10;

  // Build bot list — first `count` are active, last STANDBY_POOL_SIZE are standby
  let bots: Bot[] = Array.from({ length: totalBots }, (_, i) => {
    const def = i < SEED_DEFS.length ? SEED_DEFS[i] : genDef(i);
    return makeBot(def, i, startingBalance, i >= count);
  });

  const trades: Trade[] = [];
  let market = initMarket();

  // Warm-up phase: advance market AND run bot trades.
  // The initial 200 candles end with a recovery phase (positive drift),
  // so warmup ticks run in the bullish zone — generating profitable initial trades.
  for (let tick = 0; tick < warmupTicks; tick++) {
    market = tickMarket(market);
    bots = bots.map(bot => {
      if (!bot.isRunning) return bot;
      const candles = market[bot.symbol] || [];
      if (candles.length < 52) return bot;
      const { bot: updatedBot, trade } = executeBotTick(bot, candles, trades, 0.3);
      if (trade) trades.push(trade);
      return updatedBot;
    });
  }

  const cappedTrades = trades.slice(-2000);
  return { bots, trades: cappedTrades, market };
}

// ── Legacy export ─────────────────────────────────────────────────────────────
export function seedBots(initialMarket: MarketData): { bots: Bot[]; trades: Trade[]; market: MarketData } {
  return generateBots(30, 1000);
}
