// ─── MEXC REST Adapter ────────────────────────────────────────────────────────
import { hmacSHA256, safeFetch, stubSymbolRules, toUsdtPair } from './base-adapter.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE = 'https://api.mexc.com';

function sign(secret: string, data: string): string {
  return hmacSHA256(secret, data);
}

function qs(params: Record<string, string | number>): string {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function authHeaders(apiKey: string) {
  return { 'X-MEXC-APIKEY': apiKey, 'Content-Type': 'application/json' };
}

function signedQs(params: Record<string, string | number>, secret: string): string {
  const q = qs(params);
  return `${q}&signature=${sign(secret, q)}`;
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'FILLED':           return 'filled';
    case 'CANCELED':         return 'canceled';
    case 'PARTIALLY_FILLED': return 'partial';
    default:                 return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  return {
    orderId:     String(o['orderId'] ?? ''),
    clientId:    String(o['clientOrderId'] ?? ''),
    symbol:      String(o['symbol'] ?? ''),
    side:        String(o['side'] ?? '').toLowerCase() as 'buy' | 'sell',
    type:        String(o['type'] ?? '').toLowerCase() as 'market' | 'limit',
    status:      mapStatus(String(o['status'] ?? '')),
    quantity:    parseFloat(String(o['origQty'] ?? '0')),
    filledQty:   parseFloat(String(o['executedQty'] ?? '0')),
    price:       parseFloat(String(o['price'] ?? '0')),
    avgPrice:    parseFloat(String(o['price'] ?? '0')),
    fee:         0,
    feeCurrency: 'USDT',
    timestamp:   parseInt(String(o['time'] ?? o['updateTime'] ?? Date.now())),
    exchange:    'mexc',
    raw: o,
  };
}

export class MexcAdapter implements ExchangeAdapter {
  readonly id   = 'mexc';
  readonly name = 'MEXC Global';

  normalizeSymbol(symbol: string): string { return toUsdtPair(symbol); }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/api/v3/ping`, {}, 'mexc');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const q = signedQs({ timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/account?${q}`, { headers: authHeaders(creds.apiKey) }, 'mexc');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
    return { success: true, permissions: { read: true, trade: true, withdraw: false, futures: false } };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const q = signedQs({ timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/account?${q}`, { headers: authHeaders(creds.apiKey) }, 'mexc');
    if (!r.ok) throw new Error(r.error?.message);
    const d   = r.data as Record<string, unknown>;
    const raw = (d['balances'] as Array<Record<string, string>>) ?? [];
    return raw
      .filter(b => parseFloat(b['free'] ?? '0') + parseFloat(b['locked'] ?? '0') > 0)
      .map(b => ({
        asset:     b['asset'] ?? '',
        available: parseFloat(b['free'] ?? '0'),
        hold:      parseFloat(b['locked'] ?? '0'),
        total:     parseFloat(b['free'] ?? '0') + parseFloat(b['locked'] ?? '0'),
      }));
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${BASE}/api/v3/exchangeInfo?symbol=${sym}`, {}, 'mexc');
    if (!r.ok) return stubSymbolRules(sym);
    const d    = r.data as Record<string, unknown>;
    const info = ((d['symbols'] as Array<Record<string, unknown>>)?.[0] ?? {}) as Record<string, unknown>;
    const filters = (info['filters'] as Array<Record<string, string>>) ?? [];
    const lot  = filters.find(f => f['filterType'] === 'LOT_SIZE') ?? {};
    return {
      symbol: sym, baseCurrency: String(info['baseAsset'] ?? ''), quoteCurrency: String(info['quoteAsset'] ?? 'USDT'),
      minQty: parseFloat(lot['minQty'] ?? '0.00001'), maxQty: parseFloat(lot['maxQty'] ?? '9000000'),
      stepSize: parseFloat(lot['stepSize'] ?? '0.00001'), minNotional: 1, tickSize: 0.01, maxLeverage: 1,
    };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const sym = this.normalizeSymbol(order.symbol);
    const params: Record<string, string | number> = {
      symbol: sym, side: order.side.toUpperCase(),
      type: order.type.toUpperCase(), quantity: order.quantity, timestamp: Date.now(),
    };
    if (order.type === 'limit' && order.price) { params['timeInForce'] = 'GTC'; params['price'] = order.price; }
    if (order.clientId) params['newClientOrderId'] = order.clientId;
    const q = signedQs(params, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/order?${q}`, { method: 'POST', headers: authHeaders(creds.apiKey) }, 'mexc');
    if (!r.ok) throw new Error(`MEXC order failed: ${r.error?.message}`);
    return parseOrder(r.data as Record<string, unknown>);
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean> {
    if (!symbol) return false;
    const q = signedQs({ symbol: this.normalizeSymbol(symbol), orderId, timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/order?${q}`, { method: 'DELETE', headers: authHeaders(creds.apiKey) }, 'mexc');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym = symbol ? this.normalizeSymbol(symbol) : 'BTCUSDT';
    const q   = signedQs({ symbol: sym, limit, timestamp: Date.now() }, creds.secretKey);
    const r   = await safeFetch(`${BASE}/api/v3/allOrders?${q}`, { headers: authHeaders(creds.apiKey) }, 'mexc');
    if (!r.ok) return [];
    return ((r.data as unknown[]) ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null> {
    if (!symbol) return null;
    const q = signedQs({ symbol: this.normalizeSymbol(symbol), orderId, timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/order?${q}`, { headers: authHeaders(creds.apiKey) }, 'mexc');
    if (!r.ok) return null;
    return parseOrder(r.data as Record<string, unknown>);
  }
}
