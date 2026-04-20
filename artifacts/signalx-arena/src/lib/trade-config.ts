// ─── Trade Configuration ───────────────────────────────────────────────────────
// Per-exchange, per-user trade settings. Persisted to localStorage.

import { exchangeMode } from './exchange-mode.js';
import { setPollTimeout, type ProgressSource } from './order-progress.js';

export interface PollTimeoutSeconds {
  close:     number;
  manual:    number;
  autopilot: number;
}

export interface TradeConfig {
  exchange:           string;
  tradeAmountUSD:     number;   // $ per order
  maxDailyTrades:     number;   // 0 = unlimited
  maxOpenPositions:   number;   // 0 = unlimited
  stopLossPct:        number;   // % e.g. 2.0 = 2%
  takeProfitPct:      number;   // % e.g. 4.0 = 4%
  cooldownSeconds:    number;   // seconds between trades
  allowedSymbols:     string[]; // empty = all allowed
  onlyLong:           boolean;  // spot only-long mode
  emergencyStop:      boolean;  // kills all execution immediately
  orderType:          'market' | 'limit';
  pollTimeoutSeconds: PollTimeoutSeconds; // per-source order-tracking timeout
}

const STORAGE_KEY = 'sx_trade_config_v1';

// Sane bounds for the per-source order-tracking timeout. The lower bound
// has to be long enough that a slow exchange round-trip can complete at
// least once; the upper bound caps how long an abandoned order will keep
// burning poll requests before the "Resume polling" affordance appears.
export const POLL_TIMEOUT_MIN_SEC = 10;
export const POLL_TIMEOUT_MAX_SEC = 1800; // 30 minutes

export const DEFAULT_POLL_TIMEOUT_SECONDS: PollTimeoutSeconds = {
  close:     60,
  manual:    60,
  autopilot: 120,
};

export function clampPollTimeoutSeconds(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return POLL_TIMEOUT_MIN_SEC;
  return Math.min(POLL_TIMEOUT_MAX_SEC, Math.max(POLL_TIMEOUT_MIN_SEC, Math.round(n)));
}

function normalizePollTimeouts(raw: unknown): PollTimeoutSeconds {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PollTimeoutSeconds>;
  return {
    close:     clampPollTimeoutSeconds(r.close     ?? DEFAULT_POLL_TIMEOUT_SECONDS.close),
    manual:    clampPollTimeoutSeconds(r.manual    ?? DEFAULT_POLL_TIMEOUT_SECONDS.manual),
    autopilot: clampPollTimeoutSeconds(r.autopilot ?? DEFAULT_POLL_TIMEOUT_SECONDS.autopilot),
  };
}

function defaultConfig(exchange = 'binance'): TradeConfig {
  return {
    exchange,
    tradeAmountUSD:     100,
    maxDailyTrades:     10,
    maxOpenPositions:   3,
    stopLossPct:        2.0,
    takeProfitPct:      4.0,
    cooldownSeconds:    60,
    allowedSymbols:     [],
    onlyLong:           true,
    emergencyStop:      false,
    orderType:          'market',
    pollTimeoutSeconds: { ...DEFAULT_POLL_TIMEOUT_SECONDS },
  };
}

type Listener = (configs: Record<string, TradeConfig>) => void;

class TradeConfigManager {
  private configs: Record<string, TradeConfig> = {};
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.load();
    // Apply the active exchange's tracking timeouts to the global poll
    // store now and whenever the user switches exchange so the chosen
    // values take effect on app start without requiring a tab visit.
    this.applyPollTimeouts(exchangeMode.get().exchange);
    try {
      exchangeMode.subscribe(s => this.applyPollTimeouts(s.exchange));
    } catch { /* exchange-mode not available in tests */ }
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) as Record<string, Partial<TradeConfig>> : {};
      // Defensive normalization: older persisted configs won't have
      // `pollTimeoutSeconds`; backfill defaults so the UI always has
      // bounded values to render.
      const out: Record<string, TradeConfig> = {};
      for (const [ex, cfg] of Object.entries(parsed)) {
        out[ex] = {
          ...defaultConfig(ex),
          ...cfg,
          exchange:           ex,
          pollTimeoutSeconds: normalizePollTimeouts(cfg?.pollTimeoutSeconds),
        };
      }
      this.configs = out;
    } catch { this.configs = {}; }
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.configs)); } catch { /* storage full */ }
  }

  private notify() {
    const snap = { ...this.configs };
    this.listeners.forEach(fn => { try { fn(snap); } catch { /* ignore errors from individual listeners */ } });
  }

  // Push the per-source tracking timeouts for `exchange` into the global
  // `POLL_TIMEOUTS_MS` store so newly-started pollers honour them. Safe
  // to call repeatedly — it only mutates the global on every invocation.
  private applyPollTimeouts(exchange: string) {
    const t = this.get(exchange).pollTimeoutSeconds;
    (Object.keys(t) as ProgressSource[]).forEach(src => {
      setPollTimeout(src, t[src] * 1000);
    });
  }

  get(exchange: string): TradeConfig {
    return this.configs[exchange] ?? defaultConfig(exchange);
  }

  set(exchange: string, patch: Partial<TradeConfig>) {
    const merged = { ...this.get(exchange), ...patch, exchange };
    if (patch.pollTimeoutSeconds) {
      merged.pollTimeoutSeconds = normalizePollTimeouts({
        ...this.get(exchange).pollTimeoutSeconds,
        ...patch.pollTimeoutSeconds,
      });
    }
    this.configs[exchange] = merged;
    this.save();
    if (exchange === exchangeMode.get().exchange) this.applyPollTimeouts(exchange);
    this.notify();
  }

  reset(exchange: string) {
    this.configs[exchange] = defaultConfig(exchange);
    this.save();
    if (exchange === exchangeMode.get().exchange) this.applyPollTimeouts(exchange);
    this.notify();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const tradeConfig = new TradeConfigManager();
