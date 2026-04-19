// ─── Trade Configuration ───────────────────────────────────────────────────────
// Per-exchange, per-user trade settings. Persisted to localStorage.

export interface TradeConfig {
  exchange:          string;
  tradeAmountUSD:    number;   // $ per order
  maxDailyTrades:    number;   // 0 = unlimited
  maxOpenPositions:  number;   // 0 = unlimited
  stopLossPct:       number;   // % e.g. 2.0 = 2%
  takeProfitPct:     number;   // % e.g. 4.0 = 4%
  cooldownSeconds:   number;   // seconds between trades
  allowedSymbols:    string[]; // empty = all allowed
  onlyLong:          boolean;  // spot only-long mode
  emergencyStop:     boolean;  // kills all execution immediately
  orderType:         'market' | 'limit';
}

const STORAGE_KEY = 'sx_trade_config_v1';

function defaultConfig(exchange = 'binance'): TradeConfig {
  return {
    exchange,
    tradeAmountUSD:   100,
    maxDailyTrades:   10,
    maxOpenPositions: 3,
    stopLossPct:      2.0,
    takeProfitPct:    4.0,
    cooldownSeconds:  60,
    allowedSymbols:   [],
    onlyLong:         true,
    emergencyStop:    false,
    orderType:        'market',
  };
}

type Listener = (configs: Record<string, TradeConfig>) => void;

class TradeConfigManager {
  private configs: Record<string, TradeConfig> = {};
  private listeners: Set<Listener> = new Set();

  constructor() { this.load(); }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.configs = raw ? JSON.parse(raw) : {};
    } catch { this.configs = {}; }
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.configs)); } catch {}
  }

  private notify() {
    const snap = { ...this.configs };
    this.listeners.forEach(fn => { try { fn(snap); } catch {} });
  }

  get(exchange: string): TradeConfig {
    return this.configs[exchange] ?? defaultConfig(exchange);
  }

  set(exchange: string, patch: Partial<TradeConfig>) {
    this.configs[exchange] = { ...this.get(exchange), ...patch, exchange };
    this.save();
    this.notify();
  }

  reset(exchange: string) {
    this.configs[exchange] = defaultConfig(exchange);
    this.save();
    this.notify();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const tradeConfig = new TradeConfigManager();
