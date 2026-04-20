// ─── Exchange Mode Singleton ───────────────────────────────────────────────────
// Single source of truth for demo/paper/testnet/real state, arm status, and
// per-exchange creds.  Persists to localStorage.
// Import and use everywhere — never duplicate state.

export type ExchangeMode = 'demo' | 'paper' | 'testnet' | 'real';

// Explicit per-exchange connection state. Replaces the old four-boolean
// collapse so the UI and engine can distinguish *why* a real connection is
// not ready (transient network blip vs. invalid creds vs. empty account).
export type ConnectionState =
  | 'disconnected'
  | 'keys_saved'
  | 'validating'
  | 'network_error'
  | 'invalid_credentials'
  | 'permission_denied'
  | 'rate_limited'
  | 'connected'
  | 'balance_loaded'
  | 'balance_empty'
  | 'balance_error';

export interface ExchangeCredentials {
  apiKey:      string;
  secretKey:   string;
  passphrase?: string;
}

export interface ExchangeModeState {
  mode:            ExchangeMode;
  exchange:        string;   // currently selected exchange id
  armed:           boolean;  // Trading Armed — must be true for real orders
  apiValidated:    boolean;
  balanceFetched:  boolean;  // true after at least one successful balance fetch
  networkUp:       boolean;  // true after backend reachability confirmed
  permissions:     {
    read:        boolean;
    trade:       boolean;
    withdraw:    boolean;
    futures:     boolean;
    spot?:       boolean;     // granular: spot trading specifically
    margin?:     boolean;     // granular: margin trading
    options?:    boolean;     // granular: options trading
    accountType?: string;     // e.g. 'SPOT', 'MARGIN', 'UNIFIED'
  };
  uid?:            string;
  connectedAt?:    number;
  latency?:        number;
  connectionState:  ConnectionState;
  connectionError?: string;
  // ── Auto-retry scheduling ───────────────────────────────────────────────
  // When the connection enters `network_error` or `rate_limited` we schedule
  // a single, silent re-validation. `autoRetryAt` is the wall-clock epoch ms
  // at which the retry should fire — the UI uses it to render a countdown.
  // `autoRetryReason` is the originating error so the countdown copy can
  // be specific. `autoRetryAttempted` flips to true once the one auto-retry
  // for the current error cycle has been consumed; it resets on success,
  // disconnect, mode/exchange switch, or a manual user retry. This is what
  // prevents retry storms during a real outage or persistent throttle.
  autoRetryAt?:        number;
  autoRetryReason?:    'network' | 'rate_limit';
  autoRetryAttempted?: boolean;
}

// Default delays for the one-shot auto-retry. Network blips are usually a
// few seconds; rate-limit cooldowns from exchanges are typically tens of
// seconds and the backend may surface a stricter `Retry-After` hint that
// overrides the default.
export const AUTO_RETRY_NETWORK_MS    = 5_000;
export const AUTO_RETRY_RATE_LIMIT_MS = 30_000;

type Listener = (state: ExchangeModeState) => void;

const STORAGE_KEY = 'sx_exchange_mode_v1';

function defaultState(): ExchangeModeState {
  return {
    mode:            'demo',
    exchange:        'binance',
    armed:           false,
    apiValidated:    false,
    balanceFetched:  false,
    networkUp:       false,
    permissions:     { read: false, trade: false, withdraw: false, futures: false },
    connectionState: 'disconnected',
  };
}

function migrateMode(raw: Partial<ExchangeModeState>): ExchangeMode {
  const m = raw.mode as string | undefined;
  if (m === 'live') return 'real';
  if (m === 'demo' || m === 'paper' || m === 'testnet' || m === 'real') return m;
  return 'demo';
}

function loadState(): ExchangeModeState {
  try {
    const rawStr = localStorage.getItem(STORAGE_KEY);
    if (!rawStr) return defaultState();
    const parsed = JSON.parse(rawStr) as Partial<ExchangeModeState>;
    // Never persist armed=true — require explicit arm on every session
    // Migrate legacy 'live' → 'real'
    return { ...defaultState(), ...parsed, mode: migrateMode(parsed), armed: false };
  } catch { return defaultState(); }
}

function saveState(state: ExchangeModeState) {
  try {
    // Never persist armed=true or credentials
    const toSave = { ...state, armed: false };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch { /* storage full */ }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

class ExchangeModeManager {
  private state: ExchangeModeState;
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.state = loadState();
  }

  get(): ExchangeModeState { return { ...this.state }; }

  update(patch: Partial<ExchangeModeState>) {
    this.state = { ...this.state, ...patch };
    saveState(this.state);
    this.notify();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const snap = this.get();
    this.listeners.forEach(fn => { try { fn(snap); } catch { /* ignore errors from individual listeners */ } });
  }

  // ── Convenience helpers ──────────────────────────────────────────────────

  setMode(mode: ExchangeMode) {
    // Switching mode clears all sensitive state
    this.update({
      mode,
      armed:           false,
      apiValidated:    false,
      balanceFetched:  false,
      networkUp:       false,
      permissions:     { read: false, trade: false, withdraw: false, futures: false },
      uid:             undefined,
      connectionState: 'disconnected',
      connectionError: undefined,
      autoRetryAt:        undefined,
      autoRetryReason:    undefined,
      autoRetryAttempted: false,
    });
  }

  setExchange(exchange: string) {
    // Switching exchange clears connection state
    this.update({
      exchange,
      armed:           false,
      apiValidated:    false,
      balanceFetched:  false,
      networkUp:       false,
      permissions:     { read: false, trade: false, withdraw: false, futures: false },
      uid:             undefined,
      connectedAt:     undefined,
      latency:         undefined,
      connectionState: 'disconnected',
      connectionError: undefined,
      autoRetryAt:        undefined,
      autoRetryReason:    undefined,
      autoRetryAttempted: false,
    });
  }

  // Cancel any pending auto-retry without otherwise touching state. Called
  // when the user manually clicks Retry (we want their click to fire the
  // attempt, not a duplicate timer firing right after).
  cancelAutoRetry() {
    if (this.state.autoRetryAt === undefined && this.state.autoRetryReason === undefined) return;
    this.update({ autoRetryAt: undefined, autoRetryReason: undefined });
  }

  // Flip the one-shot flag so the same error class can't schedule another
  // auto-retry until a clean state resets it.
  markAutoRetryConsumed() {
    this.update({ autoRetryAt: undefined, autoRetryReason: undefined, autoRetryAttempted: true });
  }

  // Schedule a one-shot auto-retry WITHOUT changing the connection state.
  // Used by lightweight refresh paths (balance / order history refresh)
  // when the connection itself is still considered healthy and we just
  // want the same short-backoff retry the connect flow uses. No-op if a
  // retry is already pending or the one-shot has been consumed for the
  // current error cycle.
  scheduleAutoRetry(reason: 'network' | 'rate_limit', retryAfterMs?: number) {
    if (this.state.autoRetryAttempted) return;
    if (this.state.autoRetryAt !== undefined) return;
    const delay = reason === 'rate_limit'
      ? Math.max(1_000, retryAfterMs ?? AUTO_RETRY_RATE_LIMIT_MS)
      : AUTO_RETRY_NETWORK_MS;
    this.update({ autoRetryAt: Date.now() + delay, autoRetryReason: reason });
  }

  // Transition to a new connection state with an optional error message.
  // Does not touch `mode` — failures during connect must NOT silently flip
  // the user back to Demo. The user remains in Real / Testnet and the UI
  // shows the classified error.
  //
  // Readiness booleans (networkUp / apiValidated / balanceFetched) and the
  // `armed` flag are kept STRICTLY SYNCHRONIZED with connectionState so
  // that isExecutionReady() can never be true while the connection is in
  // an error state. This is the contract the execution gate relies on.
  setConnectionState(state: ConnectionState, error?: string, retryAfterMs?: number) {
    const patch: Partial<ExchangeModeState> = { connectionState: state };
    if (error !== undefined) patch.connectionError = error;
    else if (state === 'connected' || state === 'balance_loaded' || state === 'balance_empty' || state === 'disconnected') {
      patch.connectionError = undefined;
    }

    // Auto-retry scheduling. Only the two transient classes get an auto-retry,
    // and only once per error cycle (cleared on a successful state below).
    if (state === 'network_error' && !this.state.autoRetryAttempted) {
      patch.autoRetryAt     = Date.now() + AUTO_RETRY_NETWORK_MS;
      patch.autoRetryReason = 'network';
    } else if (state === 'rate_limited' && !this.state.autoRetryAttempted) {
      const delay = retryAfterMs ?? AUTO_RETRY_RATE_LIMIT_MS;
      patch.autoRetryAt     = Date.now() + Math.max(1_000, delay);
      patch.autoRetryReason = 'rate_limit';
    } else if (
      state === 'connected' || state === 'balance_loaded' ||
      state === 'balance_empty' || state === 'disconnected' ||
      state === 'keys_saved'
    ) {
      // A clean state — clear the schedule and let future errors get a
      // fresh one-shot retry.
      patch.autoRetryAt        = undefined;
      patch.autoRetryReason    = undefined;
      patch.autoRetryAttempted = false;
    } else {
      // Validating / invalid_credentials / permission_denied / balance_error:
      // cancel any pending auto-retry so we don't fire on a stale schedule.
      patch.autoRetryAt     = undefined;
      patch.autoRetryReason = undefined;
    }

    switch (state) {
      case 'keys_saved':
      case 'disconnected':
        patch.networkUp = false; patch.apiValidated = false; patch.balanceFetched = false; patch.armed = false;
        break;
      case 'validating':
        // mid-flight — clear validated/balance until success but keep network
        patch.apiValidated = false; patch.balanceFetched = false; patch.armed = false;
        break;
      case 'network_error':
        patch.networkUp = false; patch.apiValidated = false; patch.balanceFetched = false; patch.armed = false;
        break;
      case 'invalid_credentials':
      case 'permission_denied':
        patch.apiValidated = false; patch.balanceFetched = false; patch.armed = false;
        break;
      case 'rate_limited':
        // Connection still healthy logically; just block trading until clears
        patch.armed = false;
        break;
      case 'balance_error':
        patch.balanceFetched = false; patch.armed = false;
        break;
      case 'connected':
        patch.networkUp = true;
        break;
      case 'balance_loaded':
        patch.networkUp = true; patch.balanceFetched = true;
        break;
      case 'balance_empty':
        // Successful fetch with zero assets — fetch path is healthy but
        // user has nothing to trade with, so do not let arm engage.
        patch.networkUp = true; patch.balanceFetched = true; patch.armed = false;
        break;
    }

    this.update(patch);
  }

  // Returns true only when every prerequisite is met to safely flip the
  // arm switch. Used by both the readiness panel and the arm toggle.
  canArm(): boolean {
    const s = this.state;
    return (
      s.mode             === 'real'  &&
      s.networkUp        === true    &&
      s.apiValidated     === true    &&
      s.balanceFetched   === true    &&
      s.permissions.trade === true
    );
  }

  arm() {
    if (!this.canArm()) return false;
    this.update({ armed: true });
    return true;
  }
  disarm(){ this.update({ armed: false }); }

  // Mode helpers
  isDemo():   boolean { return this.state.mode === 'demo'; }
  isPaper():  boolean { return this.state.mode === 'paper'; }
  isTestnet():boolean { return this.state.mode === 'testnet'; }
  isReal():   boolean { return this.state.mode === 'real'; }
  isSimulated(): boolean { return this.state.mode === 'demo' || this.state.mode === 'paper'; }

  // Full readiness: 6 conditions must be true for real trading
  isExecutionReady(): boolean {
    const s = this.state;
    return (
      s.mode            === 'real' &&
      s.networkUp       === true   &&
      s.apiValidated    === true   &&
      s.balanceFetched  === true   &&
      s.permissions.trade          === true &&
      s.armed           === true
    );
  }

  readinessReport(): Record<string, boolean | string> {
    const s = this.state;
    return {
      liveMode:         s.mode === 'real',
      networkUp:        s.networkUp,
      apiValidated:     s.apiValidated,
      balanceFetched:   s.balanceFetched,
      tradePermission:  s.permissions.trade,
      tradingArmed:     s.armed,
      ready:            this.isExecutionReady(),
    };
  }

  disconnect() {
    this.update({
      armed:           false,
      apiValidated:    false,
      balanceFetched:  false,
      networkUp:       false,
      permissions:     { read: false, trade: false, withdraw: false, futures: false },
      uid:             undefined,
      connectedAt:     undefined,
      latency:         undefined,
      connectionState: 'disconnected',
      connectionError: undefined,
      autoRetryAt:        undefined,
      autoRetryReason:    undefined,
      autoRetryAttempted: false,
    });
  }
}

export const exchangeMode = new ExchangeModeManager();

// ── Mode label helper (canonical display strings) ─────────────────────────────
export function modeLabel(mode: ExchangeMode): string {
  switch (mode) {
    case 'demo':    return 'DEMO';
    case 'paper':   return 'PAPER';
    case 'testnet': return 'TESTNET';
    case 'real':    return 'REAL TRADING';
  }
}
