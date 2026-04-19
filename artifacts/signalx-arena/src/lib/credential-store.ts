// ─── Credential Store ─────────────────────────────────────────────────────────
// In-memory, per-Electron-session credential store keyed by exchange id.
// Full secrets NEVER touch localStorage. Only a masked hint is persisted so
// the UI can show "previously connected with key 4abc***xyz9 — re-enter
// secret to reconnect" after an app restart.
//
// Lives outside React component state so creds survive page navigation.
// The ExchangePage reads from / writes to this store rather than holding
// the keys in its own useState.

import type { ExchangeCredentials } from './exchange-mode.js';

export interface MaskedHint {
  exchange:   string;
  maskedKey:  string;
  savedAt:    number;
}

type Listener = (exchange: string) => void;

export interface ExchangeDataCache {
  liveBalances?: Array<{ asset: string; available: number; hold: number; total: number }>;
  liveOrders?:   unknown[];
  permissions?:  { read: boolean; trade: boolean; withdraw: boolean; futures: boolean };
  latency?:      number;
  fetchedAt?:    number;
}

const HINT_STORAGE_KEY = 'sx_credential_hints_v1';

function maskKey(key: string): string {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

function loadHints(): Record<string, MaskedHint> {
  try {
    const raw = localStorage.getItem(HINT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, MaskedHint>;
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

function saveHints(hints: Record<string, MaskedHint>): void {
  try { localStorage.setItem(HINT_STORAGE_KEY, JSON.stringify(hints)); }
  catch { /* storage full / denied */ }
}

class CredentialStoreManager {
  private creds: Map<string, ExchangeCredentials> = new Map();
  private cache: Map<string, ExchangeDataCache>   = new Map();
  private hints: Record<string, MaskedHint>       = loadHints();
  private listeners: Set<Listener>                = new Set();

  // Cache last successful live data per exchange so the user sees it
  // again after navigating away and back to /exchange. In-memory only —
  // never written to disk.
  setCache(exchange: string, patch: ExchangeDataCache): void {
    const prev = this.cache.get(exchange) ?? {};
    this.cache.set(exchange, { ...prev, ...patch, fetchedAt: Date.now() });
  }

  getCache(exchange: string): ExchangeDataCache | null {
    return this.cache.get(exchange) ?? null;
  }

  clearCache(exchange: string): void {
    this.cache.delete(exchange);
  }

  set(exchange: string, creds: ExchangeCredentials): void {
    this.creds.set(exchange, { ...creds });
    this.hints[exchange] = {
      exchange,
      maskedKey: maskKey(creds.apiKey),
      savedAt:   Date.now(),
    };
    saveHints(this.hints);
    this.notify(exchange);
  }

  get(exchange: string): ExchangeCredentials | null {
    const c = this.creds.get(exchange);
    return c ? { ...c } : null;
  }

  has(exchange: string): boolean { return this.creds.has(exchange); }

  getMaskedHint(exchange: string): MaskedHint | null {
    return this.hints[exchange] ?? null;
  }

  clear(exchange: string, opts: { keepHint?: boolean } = {}): void {
    this.creds.delete(exchange);
    this.cache.delete(exchange);
    if (!opts.keepHint) {
      delete this.hints[exchange];
      saveHints(this.hints);
    }
    this.notify(exchange);
  }

  clearAll(): void {
    this.creds.clear();
    this.cache.clear();
    this.hints = {};
    saveHints(this.hints);
    this.listeners.forEach(fn => { try { fn(''); } catch { /* ignore */ } });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(exchange: string): void {
    this.listeners.forEach(fn => { try { fn(exchange); } catch { /* ignore */ } });
  }
}

export const credentialStore = new CredentialStoreManager();
export { maskKey };
