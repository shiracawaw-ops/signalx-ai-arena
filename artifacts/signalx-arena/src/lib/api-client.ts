// ─── API Client — Frontend → Backend Exchange Proxy ───────────────────────────
// All real exchange calls go through the backend (CORS proxy).
// API keys are NEVER stored in localStorage — they live in React state only
// and are passed per-request as request headers to the backend.
// Keys are masked in all console logs.

import { exchangeMode } from './exchange-mode.js';
import type { ExchangeCredentials } from './exchange-mode.js';

// ── Backend URL detection ─────────────────────────────────────────────────────
// Electron  → api-server runs locally on port 18080 (embedded process)
// Dev       → api-server runs on port 8080 (separate workflow)
// Prod      → api-server is proxied at /api-server path on the same origin

declare global {
  interface Window {
    signalxElectron?: { apiPort: number; platform: string; version: string };
  }
}

function getBackendBase(): string {
  if (typeof window === 'undefined') return '/api-server/api';
  const { protocol, hostname, port } = window.location;

  // Electron: file:// protocol — api server runs as embedded local process
  if (
    protocol === 'file:' ||
    (import.meta.env as Record<string, string>)['VITE_IS_ELECTRON'] === 'true'
  ) {
    const electronPort =
      window.signalxElectron?.apiPort ??
      Number((import.meta.env as Record<string, string>)['VITE_ELECTRON_API_PORT'] ?? 18080);
    return `http://localhost:${electronPort}/api`;
  }

  // Dev server on localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${protocol}//${hostname}:8080/api`;
  }

  // Production / Replit proxy
  return `${protocol}//${hostname}${port ? ':' + port : ''}/api-server/api`;
}

const BACKEND = getBackendBase();

// ── Credential helpers ────────────────────────────────────────────────────────
// Keys travel as request headers to the backend — never persisted anywhere.

export function maskKey(key: string): string {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

function credHeaders(
  creds: ExchangeCredentials,
  extra?: Record<string, string>,
): Record<string, string> {
  const isTestnet = exchangeMode.get().mode === 'testnet';
  return {
    'x-api-key':    creds.apiKey,
    'x-secret-key': creds.secretKey,
    ...(creds.passphrase ? { 'x-passphrase': creds.passphrase } : {}),
    ...(isTestnet ? { 'x-testnet': '1' } : {}),
    'Content-Type': 'application/json',
    ...extra,
  };
}

// ── Safe JSON parser ──────────────────────────────────────────────────────────
// Handles: empty body, 204 No Content, non-JSON (HTML error pages), malformed JSON.
// Never throws "Unexpected end of JSON input" — returns null instead.

async function safeParseJson(res: Response): Promise<unknown> {
  // 204 No Content or explicitly empty
  if (res.status === 204) return null;
  const contentLength = res.headers.get('content-length');
  if (contentLength === '0') return null;

  // Read raw text first — much safer than .json() directly
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }

  if (!text || !text.trim()) return null;

  // Only parse if it looks like JSON (starts with { or [)
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    // Server returned HTML or plain-text error — surface it as an error string
    throw new Error(`Server error (HTTP ${res.status}): ${trimmed.slice(0, 200)}`);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Malformed JSON from server (HTTP ${res.status}): ${trimmed.slice(0, 100)}`);
  }
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────

export type ExchangeErrorCode =
  | 'network'
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'account_type'
  | 'empty'
  | 'unknown';

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; code?: ExchangeErrorCode; retryAfterMs?: number };

// Parse a `Retry-After` header value (seconds-int or HTTP-date) into ms.
// Returns undefined when the header is missing or unparseable.
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  const delta = dateMs - Date.now();
  return delta > 0 ? delta : 0;
}

const FETCH_TIMEOUT_MS = 15_000;

async function request<T = unknown>(url: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
    clearTimeout(timer);

    let data: unknown;
    try {
      data = await safeParseJson(res);
    } catch (parseErr) {
      // Parse failed — response was malformed or non-JSON
      return {
        ok: false,
        error: (parseErr as Error).message ?? 'Could not parse server response',
        status: res.status,
      };
    }

    if (!res.ok) {
      const obj = (data as Record<string, unknown> | null) ?? null;
      const errMsg =
        (obj?.['error'] as string | undefined) ??
        (obj?.['message'] as string | undefined) ??
        `Server returned HTTP ${res.status}`;
      const code = obj?.['code'] as ExchangeErrorCode | undefined;
      const retryAfterMs =
        parseRetryAfter(res.headers.get('Retry-After')) ??
        (typeof obj?.['retryAfter'] === 'number' ? Math.floor((obj['retryAfter'] as number) * 1000) : undefined);
      return {
        ok: false, error: errMsg, status: res.status,
        ...(code ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }

    // The backend may return a 200 with `{ ok: false, code, error }` for
    // structured exchange errors. Surface those as ApiResult failures so the
    // caller doesn't have to special-case them.
    if (data && typeof data === 'object' && (data as Record<string, unknown>)['ok'] === false) {
      const obj = data as Record<string, unknown>;
      const errMsg = (obj['error'] as string | undefined) ?? (obj['message'] as string | undefined) ?? 'Exchange error';
      const code   = obj['code']  as ExchangeErrorCode | undefined;
      const retryAfterMs =
        parseRetryAfter(res.headers.get('Retry-After')) ??
        (typeof obj['retryAfter'] === 'number' ? Math.floor((obj['retryAfter'] as number) * 1000) : undefined);
      return {
        ok: false, error: errMsg, status: res.status,
        ...(code ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }

    return { ok: true, data: (data ?? {}) as T };

  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;

    // Friendly error messages for common network failures.
    // Note: never tell the user we are "switching to demo" — we do not.
    // Demo is only entered on explicit user action.
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Request timed out — check your connection or try again.', code: 'network' };
    }
    if (err.message?.toLowerCase().includes('failed to fetch') ||
        err.message?.toLowerCase().includes('network')) {
      return { ok: false, error: 'Cannot reach the API server.', code: 'network' };
    }
    return { ok: false, error: err.message ?? 'Network error', code: 'network' };
  }
}

// ── Reachability probe ────────────────────────────────────────────────────────
// Quick check before any live operation — returns true if backend is up.

let _lastProbeOk: boolean | null = null;
let _lastProbeTs                 = 0;
const PROBE_TTL_MS               = 10_000;

export async function isBackendReachable(): Promise<boolean> {
  const now = Date.now();
  if (_lastProbeOk !== null && now - _lastProbeTs < PROBE_TTL_MS) {
    return _lastProbeOk;
  }
  // Use the healthz endpoint (same /api prefix as the rest of the backend)
  const r = await request<{ status: string }>(`${BACKEND}/healthz`);
  _lastProbeOk = r.ok;
  _lastProbeTs = now;
  return r.ok;
}

// ── Public API ────────────────────────────────────────────────────────────────

export const apiClient = {

  async ping(exchange: string): Promise<{ latency: number } | { error: string }> {
    const r = await request<{ latency: number }>(`${BACKEND}/exchange/${exchange}/ping`);
    if (r.ok) return { latency: r.data.latency ?? 0 };
    return { error: r.error };
  },

  async validate(exchange: string, creds: ExchangeCredentials): Promise<ApiResult<unknown>> {
    console.log(`[api-client] validate ${exchange} key=${maskKey(creds.apiKey)}`);
    return request(`${BACKEND}/exchange/${exchange}/validate`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    '{}',
    });
  },

  async getPermissions(exchange: string, creds: ExchangeCredentials): Promise<ApiResult<unknown>> {
    return request(`${BACKEND}/exchange/${exchange}/permissions`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    '{}',
    });
  },

  async getBalances(
    exchange: string,
    creds: ExchangeCredentials,
  ): Promise<ApiResult<{
    balances: Array<{ asset: string; available: number; hold: number; total: number; usdtValue?: number; scope?: string }>;
    // Optional: per-scope breakdown (currently populated for Bybit). When
    // present the UI shows the breakdown panel; when absent, falls back to
    // the legacy single-row total.
    summary?: BalanceSummary;
  }>> {
    console.log(`[api-client] getBalances ${exchange} key=${maskKey(creds.apiKey)}`);
    return request(`${BACKEND}/exchange/${exchange}/balances`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    '{}',
    });
  },

  async placeOrder(
    exchange: string,
    creds: ExchangeCredentials,
    order: {
      symbol:    string;
      side:      'buy' | 'sell';
      type:      'market' | 'limit';
      quantity:  number;
      price?:    number;
      clientId?: string;
      testnet?:  boolean;
    },
  ): Promise<ApiResult<{ order: { orderId: string } }>> {
    const { testnet, ...orderBody } = order;
    console.log(
      `[api-client] placeOrder ${exchange} ${order.side} ${order.quantity} ${order.symbol}` +
      ` key=${maskKey(creds.apiKey)}${testnet ? ' [TESTNET]' : ''}`,
    );
    return request(`${BACKEND}/exchange/${exchange}/order/place`, {
      method:  'POST',
      headers: credHeaders(creds, testnet ? { 'x-testnet': '1' } : {}),
      body:    JSON.stringify(orderBody),
    });
  },

  async testOrder(
    exchange: string,
    creds: ExchangeCredentials,
    order: {
      symbol:    string;
      side:      'buy' | 'sell';
      type:      'market' | 'limit';
      quantity:  number;
      price?:    number;
      testnet?:  boolean;
    },
  ): Promise<ApiResult<{ test: {
    ok:           boolean;
    reason?:      string;
    detail?:      string;
    exchangeCode?: string | number;
    httpStatus?:  number;
    rules?:       Record<string, unknown>;
    echo?:        { symbol: string; side: string; quantity: string; price?: string };
    raw?:         unknown;
  } }>> {
    const { testnet, ...orderBody } = order;
    console.log(
      `[api-client] testOrder ${exchange} ${order.side} ${order.quantity} ${order.symbol}` +
      ` key=${maskKey(creds.apiKey)}${testnet ? ' [TESTNET]' : ''}`,
    );
    return request(`${BACKEND}/exchange/${exchange}/order/test`, {
      method:  'POST',
      headers: credHeaders(creds, testnet ? { 'x-testnet': '1' } : {}),
      body:    JSON.stringify(orderBody),
    });
  },

  async cancelOrder(
    exchange: string,
    creds: ExchangeCredentials,
    orderId: string,
    symbol?: string,
  ): Promise<ApiResult<unknown>> {
    return request(`${BACKEND}/exchange/${exchange}/order/cancel`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    JSON.stringify({ orderId, symbol }),
    });
  },

  async getOrderStatus(
    exchange: string,
    creds: ExchangeCredentials,
    orderId: string,
    symbol?: string,
  ): Promise<ApiResult<{ order: {
    orderId:    string;
    symbol:     string;
    side:       'buy' | 'sell';
    type:       'market' | 'limit';
    status:     'open' | 'filled' | 'canceled' | 'rejected' | 'partial';
    quantity:   number;
    filledQty:  number;
    price:      number;
    avgPrice:   number;
    timestamp:  number;
  } | null }>> {
    return request(`${BACKEND}/exchange/${exchange}/order/get`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    JSON.stringify({ orderId, symbol }),
    });
  },

  async getOrderHistory(
    exchange: string,
    creds: ExchangeCredentials,
    symbol?: string,
    limit = 50,
  ): Promise<ApiResult<{ orders: unknown[] }>> {
    return request(`${BACKEND}/exchange/${exchange}/orders/history`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    JSON.stringify({ symbol, limit }),
    });
  },

  async getSymbolRules(
    exchange: string,
    creds: ExchangeCredentials,
    symbol: string,
  ): Promise<ApiResult<unknown>> {
    return request(`${BACKEND}/exchange/${exchange}/symbol/rules`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    JSON.stringify({ symbol }),
    });
  },

  async getPrice(
    exchange: string,
    symbol: string,
  ): Promise<ApiResult<{ price: number }>> {
    return request(`${BACKEND}/exchange/${exchange}/price/${encodeURIComponent(symbol)}`);
  },

  async listExchanges(): Promise<string[]> {
    const r = await request<{ exchanges: string[] }>(`${BACKEND}/exchange`);
    return r.ok ? (r.data.exchanges ?? []) : [];
  },

  // ── Diagnostics ──────────────────────────────────────────────────────────
  // Pull the full transparency report (outbound IP, account JSON snapshot,
  // every step's pass/fail with the exchange's own error code) so the
  // Diagnostics panel can show the user EXACTLY why a permission check is
  // failing, instead of an opaque "trading permission missing" string.

  async getDiagnostic(
    exchange: string,
    creds: ExchangeCredentials,
  ): Promise<ApiResult<{ diagnostic: ExchangeDiagnostic }>> {
    console.log(`[api-client] diagnostic ${exchange} key=${maskKey(creds.apiKey)}`);
    return request(`${BACKEND}/exchange/${exchange}/diagnostic`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    '{}',
    });
  },

  async runSelfTest(
    exchange: string,
    creds: ExchangeCredentials,
  ): Promise<ApiResult<{ selfTest: SelfTestResult }>> {
    console.log(`[api-client] self-test ${exchange} key=${maskKey(creds.apiKey)}`);
    return request(`${BACKEND}/exchange/${exchange}/self-test`, {
      method:  'POST',
      headers: credHeaders(creds),
      body:    '{}',
    });
  },
};

// ── Diagnostic types (mirror of backend types.ts) ─────────────────────────────

// ── Balance breakdown types (mirror of api-server BalanceScope/Summary) ──────
export interface BalanceScope {
  accountType:        string;
  fetched:            boolean;
  totalEquityUSD?:    number;
  walletBalanceUSD?:  number;
  availableUSD?:      number;
  lockedUSD?:         number;
  coinCount?:         number;
  error?:             string;
  note?:              string;
}
export interface BalanceSummary {
  totalEquityUSD:     number;
  totalWalletUSD:     number;
  totalAvailableUSD:  number;
  totalLockedUSD:     number;
  fundingUSD:         number;
  tradingUSD:         number;
  externalUSD?:       number;
  externalBreakdown?: Array<{ source: string; usd: number; coinCount: number; note?: string }>;
  scopes:             BalanceScope[];
  notes:              string[];
  exchangeReported?: {
    totalEquityUSD?:    number;
    totalWalletUSD?:    number;
    totalAvailableUSD?: number;
  };
}

export interface DiagnosticStep {
  step:        string;
  ok:          boolean;
  detail?:     string;
  code?:       string | number;
  httpStatus?: number;
  raw?:        unknown;
  durationMs?: number;
}

export interface ExchangeDiagnostic {
  exchange:        string;
  apiKeyMasked:    string;
  testnet:         boolean;
  outboundIp?:     string;
  permissions: {
    read:        boolean;
    trade:       boolean;
    withdraw:    boolean;
    futures:     boolean;
    spot?:       boolean;
    margin?:     boolean;
    options?:    boolean;
    accountType?: string;
  };
  accountType?:    string;
  steps:           DiagnosticStep[];
  recommendation?: string;
  timestamp:       number;
}

export interface SelfTestResult {
  exchange:     string;
  apiKeyMasked: string;
  testnet:      boolean;
  pass:         boolean;
  steps:        DiagnosticStep[];
  summary:      string;
  timestamp:    number;
}
