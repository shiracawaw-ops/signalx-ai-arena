// ─── Base Adapter — HMAC utilities, fetch wrapper, error normalisation ─────────
import { createHmac, createHash } from 'node:crypto';
import type { ExchangeError, OrderResult, Balance, Permission, SymbolRules } from './types.js';

export function hmacSHA256(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}
export function hmacSHA256Base64(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64');
}
export function hmacSHA384Base64(secret: string, data: string): string {
  return createHmac('sha384', secret).update(data).digest('base64');
}
export function hmacSHA512Base64(secret: string, data: string): string {
  return createHmac('sha512', secret).update(data).digest('base64');
}
export function hmacSHA512Hex(secret: string, data: string): string {
  return createHmac('sha512', secret).update(data).digest('hex');
}
export function sha256(data: string): Buffer {
  return createHash('sha256').update(data).digest();
}
export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function maskKey(key: string): string {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

// Safe fetch with timeout + error normalization
export async function safeFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  exchange = 'unknown',
): Promise<{ ok: boolean; status: number; data: unknown; error?: ExchangeError }> {
  const { timeoutMs = 10_000, ...fetchInit } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchInit, signal: controller.signal });
    clearTimeout(timer);
    let data: unknown;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        error: {
          exchange,
          code: res.status,
          message: typeof data === 'object' && data !== null
            ? JSON.stringify(data)
            : String(data),
          status: res.status,
        },
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort = (err as Error)?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      data: null,
      error: {
        exchange,
        code: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: isAbort ? `Request timed out after ${timeoutMs}ms` : (err as Error)?.message ?? 'Unknown network error',
      },
    };
  }
}

// Stub result for demo balances (used when creds are empty in demo mode)
export function stubBalance(asset: string, amount: number): Balance {
  return { asset, available: amount, hold: 0, total: amount };
}

export function stubPermission(): Permission {
  return { read: true, trade: true, withdraw: false, futures: false };
}

export function stubOrder(exchange: string, symbol: string, side: 'buy' | 'sell', qty: number, price: number): OrderResult {
  return {
    orderId: `demo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    symbol, side, type: 'market', status: 'filled',
    quantity: qty, filledQty: qty,
    price, avgPrice: price,
    fee: qty * price * 0.001, feeCurrency: 'USDT',
    timestamp: Date.now(), exchange,
  };
}

export function stubSymbolRules(symbol: string): SymbolRules {
  return {
    symbol, baseCurrency: symbol.replace(/USDT$/, ''), quoteCurrency: 'USDT',
    minQty: 0.00001, maxQty: 9_000_000, stepSize: 0.00001,
    minNotional: 1, tickSize: 0.01, maxLeverage: 1,
  };
}

// Normalize a "BTC"-style symbol to exchange-specific format (default: BTCUSDT)
export function toUsdtPair(symbol: string): string {
  const raw = String(symbol ?? '').trim().toUpperCase();
  if (!raw) return '';
  const compact = raw.replace(/[\s/_-]/g, '');
  if (compact.endsWith('USDT')) return compact;
  if (compact.endsWith('USDC') || compact.endsWith('USDE') || compact.endsWith('BUSD') || compact.endsWith('USD')) {
    return `${compact.replace(/(USDC|USDE|BUSD|USD)$/, '')}USDT`;
  }
  return `${compact}USDT`;
}
