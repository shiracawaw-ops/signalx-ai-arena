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
  permissions:     { read: boolean; trade: boolean; withdraw: boolean; futures: boolean };
  uid?:            string;
  connectedAt?:    number;
  latency?:        number;
  connectionState:  ConnectionState;
  connectionError?: string;
}

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
    });
  }

  // Transition to a new connection state with an optional error message.
  // Does not touch `mode` — failures during connect must NOT silently flip
  // the user back to Demo. The user remains in Real / Testnet and the UI
  // shows the classified error.
  setConnectionState(state: ConnectionState, error?: string) {
    const patch: Partial<ExchangeModeState> = { connectionState: state };
    if (error !== undefined) patch.connectionError = error;
    else if (state === 'connected' || state === 'balance_loaded' || state === 'disconnected') {
      patch.connectionError = undefined;
    }
    this.update(patch);
  }

  arm()   { this.update({ armed: true  }); }
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
