// ─── Execution Log ─────────────────────────────────────────────────────────────
// Stores every execution decision — pending, executed, rejected — with full context.
// Capped at 500 entries (oldest removed). Persisted to localStorage.

export type LogStatus = 'pending' | 'executing' | 'executed' | 'rejected' | 'failed';
export type ExchangeMode = 'demo' | 'paper' | 'testnet' | 'real';

export interface ExecutionEntry {
  id:           string;
  ts:           number;       // unix ms
  mode:         ExchangeMode;
  exchange:     string;
  symbol:       string;
  side:         'buy' | 'sell';
  orderType:    'market' | 'limit';
  quantity:     number;
  price:        number;
  amountUSD:    number;
  status:       LogStatus;
  orderId?:     string;
  rejectReason?: string;
  errorMsg?:    string;
  exchangeResponse?: unknown;
  signalId?:    string;
  latencyMs?:   number;
}

const STORAGE_KEY = 'sx_execution_log_v1';
const MAX_ENTRIES = 500;

type Listener = (entries: ExecutionEntry[]) => void;

class ExecutionLogManager {
  private entries: ExecutionEntry[] = [];
  private listeners: Set<Listener> = new Set();

  constructor() { this.load(); }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.entries = raw ? JSON.parse(raw) : [];
    } catch { this.entries = []; }
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries.slice(0, MAX_ENTRIES)));
    } catch { /* storage full */ }
  }

  private notify() {
    const snap = [...this.entries];
    this.listeners.forEach(fn => { try { fn(snap); } catch { /* ignore errors from individual listeners */ } });
  }

  all(): ExecutionEntry[]      { return [...this.entries]; }
  pending(): ExecutionEntry[]  { return this.entries.filter(e => e.status === 'pending' || e.status === 'executing'); }
  executed(): ExecutionEntry[] { return this.entries.filter(e => e.status === 'executed'); }
  rejected(): ExecutionEntry[] { return this.entries.filter(e => e.status === 'rejected' || e.status === 'failed'); }

  add(entry: Omit<ExecutionEntry, 'id' | 'ts'>): ExecutionEntry {
    const full: ExecutionEntry = {
      ...entry,
      id: `ex_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
    };
    this.entries = [full, ...this.entries].slice(0, MAX_ENTRIES);
    this.save();
    this.notify();
    return full;
  }

  update(id: string, patch: Partial<ExecutionEntry>) {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return;
    this.entries[idx] = { ...this.entries[idx], ...patch };
    this.save();
    this.notify();
  }

  clear() {
    this.entries = [];
    this.save();
    this.notify();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const executionLog = new ExecutionLogManager();

// ── Rejection reason codes ─────────────────────────────────────────────────────
export const REJECT = {
  LIVE_DISABLED:           'live_disabled',
  BOT_NOT_ARMED:           'bot_not_armed',
  NO_TRADE_PERMISSION:     'no_trade_permission',
  INSUFFICIENT_BALANCE:    'insufficient_balance',
  SYMBOL_BLOCKED:          'symbol_blocked',
  SYMBOL_UNSUPPORTED:      'symbol_unsupported',
  COOLDOWN_ACTIVE:         'cooldown_active',
  MAX_DAILY_TRADES:        'max_daily_trades_reached',
  DUPLICATE_SIGNAL:        'duplicate_signal',
  INVALID_ORDER_SIZE:      'invalid_order_size',
  BELOW_MIN_NOTIONAL:      'below_min_notional',
  EXCHANGE_REJECTED:       'exchange_rejected_request',
  ADAPTER_NOT_READY:       'adapter_not_ready',
  EXCHANGE_UNAVAILABLE:    'exchange_unavailable',
  EMERGENCY_STOP:          'emergency_stop',
  MISSING_CREDENTIALS:     'missing_credentials',
  PRICE_UNAVAILABLE:       'price_unavailable',
  AMOUNT_TOO_SMALL:        'amount_too_small',
  MAX_POSITIONS:           'max_open_positions_reached',
  STALE_PRICE:             'stale_price',
  INVALID_SIDE:            'invalid_side',
} as const;

export type RejectReason = typeof REJECT[keyof typeof REJECT];
