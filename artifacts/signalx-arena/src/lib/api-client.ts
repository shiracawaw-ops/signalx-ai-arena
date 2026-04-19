// ─── API Client — Frontend → Backend Exchange Proxy ───────────────────────────
// All real exchange calls go through the backend (CORS proxy).
// API keys are NEVER stored in localStorage — they live in React state only
// and are passed per-request as request headers to the backend.
// Keys are masked in all console logs.

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
  return {
    'x-api-key':    creds.apiKey,
    'x-secret-key': creds.secretKey,
    ...(creds.passphrase ? { 'x-passphrase': creds.passphrase } : {}),
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

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

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
      const errMsg =
        (data as Record<string, string> | null)?.['error'] ??
        (data as Record<string, string> | null)?.['message'] ??
        `Server returned HTTP ${res.status}`;
      return { ok: false, error: errMsg, status: res.status };
    }

    return { ok: true, data: (data ?? {}) as T };

  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;

    // Friendly error messages for common network failures
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Request timed out — check your connection or try again.' };
    }
    if (err.message?.toLowerCase().includes('failed to fetch') ||
        err.message?.toLowerCase().includes('network')) {
      return { ok: false, error: 'Cannot reach the API server. Switching to demo mode.' };
    }
    return { ok: false, error: err.message ?? 'Network error' };
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
  ): Promise<ApiResult<{ balances: Array<{ asset: string; available: number; hold: number; total: number }> }>> {
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
};
