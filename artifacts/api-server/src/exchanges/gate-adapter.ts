// ─── Gate.io REST Adapter (v4) ────────────────────────────────────────────────
import { hmacSHA512Hex, sha256Hex, safeFetch, stubSymbolRules } from './base-adapter.js';
import { classifyHttpFailure, check200Error, withUsdtValue } from './exchange-error.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE = 'https://api.gateio.ws/api/v4';

function sign(secret: string, method: string, path: string, query: string, bodyHash: string, ts: number): string {
  const msg = `${method}\n${path}\n${query}\n${bodyHash}\n${ts}`;
  return hmacSHA512Hex(secret, msg);
}

function headers(creds: ExchangeCredentials, method: string, path: string, query: string, body: string, ts: number) {
  const bodyHash = sha256Hex(body);
  const sig      = sign(creds.secretKey, method, path, query, bodyHash, ts);
  return {
    'KEY':          creds.apiKey,
    'SIGN':         sig,
    'Timestamp':    String(ts),
    'Content-Type': 'application/json',
  };
}

function normalizeGateSymbol(symbol: string): string {
  const base = symbol.replace(/-/g, '_').replace(/USDT$/, '');
  return `${base}_USDT`;
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'closed':    return 'filled';
    case 'cancelled': return 'canceled';
    default:          return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  return {
    orderId:     String(o['id'] ?? ''),
    clientId:    String(o['text'] ?? ''),
    symbol:      String(o['currency_pair'] ?? ''),
    side:        String(o['side'] ?? '') as 'buy' | 'sell',
    type:        String(o['type'] ?? '') as 'market' | 'limit',
    status:      mapStatus(String(o['status'] ?? '')),
    quantity:    parseFloat(String(o['amount'] ?? '0')),
    filledQty:   parseFloat(String(o['filled_amount'] ?? '0')),
    price:       parseFloat(String(o['price'] ?? '0')),
    avgPrice:    parseFloat(String(o['avg_deal_price'] ?? '0')),
    fee:         parseFloat(String(o['fee'] ?? '0')),
    feeCurrency: String(o['fee_currency'] ?? 'USDT'),
    timestamp:   Math.round(parseFloat(String(o['create_time'] ?? Date.now() / 1000)) * 1000),
    exchange:    'gate',
    raw: o,
  };
}

export class GateAdapter implements ExchangeAdapter {
  readonly id   = 'gate';
  readonly name = 'Gate.io';

  normalizeSymbol(symbol: string): string { return normalizeGateSymbol(symbol); }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/spot/time`, {}, 'gate');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const path = '/api/v4/spot/accounts';
    const ts   = Math.floor(Date.now() / 1000);
    const r    = await safeFetch(`${BASE}/spot/accounts`, {
      headers: headers(creds, 'GET', path, '', '', ts),
    }, 'gate');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
    return { success: true, permissions: { read: true, trade: true, withdraw: false, futures: false } };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const path = '/api/v4/spot/accounts';
    const ts   = Math.floor(Date.now() / 1000);
    const r    = await safeFetch(`${BASE}/spot/accounts`, {
      headers: headers(creds, 'GET', path, '', '', ts),
    }, 'gate');
    if (!r.ok) throw classifyHttpFailure('gate', r.status, r.error?.message);
    // Gate returns an array on success; an object with `label` on error.
    if (!Array.isArray(r.data)) {
      check200Error('gate', r.data, 'label', 'message', [undefined]);
      // Non-array, no `label` either — payload is malformed; surface as
      // classified `unknown` rather than crashing on .filter below.
      throw classifyHttpFailure('gate', undefined, 'unexpected response shape from /spot/accounts');
    }
    return (r.data as Array<Record<string, unknown>>)
      .filter(a => parseFloat(String(a['available'] ?? '0')) + parseFloat(String(a['locked'] ?? '0')) > 0)
      .map(a => {
        const availableN = parseFloat(String(a['available'] ?? '0'));
        const holdN      = parseFloat(String(a['locked']    ?? '0'));
        const available  = Number.isFinite(availableN) ? availableN : 0;
        const hold       = Number.isFinite(holdN)      ? holdN      : 0;
        return withUsdtValue({
          asset:     String(a['currency'] ?? ''),
          available, hold,
          total:     available + hold,
        });
      });
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${BASE}/spot/currency_pairs/${sym}`, {}, 'gate');
    if (!r.ok) return stubSymbolRules(sym);
    const d = r.data as Record<string, string>;
    return {
      symbol: sym, baseCurrency: d['base'] ?? '', quoteCurrency: d['quote'] ?? 'USDT',
      minQty:      parseFloat(d['min_base_amount'] ?? '0.00001'),
      maxQty:      parseFloat(d['max_base_amount'] ?? '9000000'),
      stepSize:    parseFloat(d['amount_precision'] ? Math.pow(10, -parseInt(d['amount_precision'])).toString() : '0.00001'),
      minNotional: parseFloat(d['min_quote_amount'] ?? '1'),
      tickSize:    parseFloat(d['precision'] ? Math.pow(10, -parseInt(d['precision'])).toString() : '0.01'),
      maxLeverage: 1,
    };
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/spot/tickers?currency_pair=${sym}`, {}, 'gate');
    if (!r.ok) throw new Error(`Gate getPrice failed: ${r.error?.message}`);
    const arr = r.data as Array<Record<string, string>>;
    return parseFloat(arr[0]?.['last'] ?? '0');
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    if (order.testnet) throw new Error('Gate.io does not support testnet mode. Use DEMO or PAPER mode for simulated trading.');
    const sym  = this.normalizeSymbol(order.symbol);
    const body = JSON.stringify({
      currency_pair: sym, side: order.side,
      type: order.type, amount: String(order.quantity),
      ...(order.type === 'limit' && order.price ? { price: String(order.price) } : {}),
      ...(order.clientId ? { text: `t-${order.clientId}` } : {}),
    });
    const path = '/api/v4/spot/orders';
    const ts   = Math.floor(Date.now() / 1000);
    const r    = await safeFetch(`${BASE}/spot/orders`, {
      method: 'POST', headers: headers(creds, 'POST', path, '', body, ts), body,
    }, 'gate');
    if (!r.ok) throw new Error(`Gate.io order failed: ${r.error?.message}`);
    return parseOrder(r.data as Record<string, unknown>);
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean> {
    if (!symbol) return false;
    const sym  = this.normalizeSymbol(symbol);
    const path = `/api/v4/spot/orders/${orderId}`;
    const ts   = Math.floor(Date.now() / 1000);
    const r    = await safeFetch(`${BASE}/spot/orders/${orderId}?currency_pair=${sym}`, {
      method: 'DELETE', headers: headers(creds, 'DELETE', path, `currency_pair=${sym}`, '', ts),
    }, 'gate');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym   = symbol ? this.normalizeSymbol(symbol) : 'BTC_USDT';
    const query = `currency_pair=${sym}&limit=${limit}&status=finished`;
    const path  = '/api/v4/spot/orders';
    const ts    = Math.floor(Date.now() / 1000);
    const r     = await safeFetch(`${BASE}/spot/orders?${query}`, {
      headers: headers(creds, 'GET', path, query, '', ts),
    }, 'gate');
    if (!r.ok) return [];
    return ((r.data as Array<Record<string, unknown>>) ?? []).map(parseOrder);
  }

  async getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null> {
    if (!symbol) return null;
    const sym   = this.normalizeSymbol(symbol);
    const query = `currency_pair=${sym}`;
    const path  = `/api/v4/spot/orders/${orderId}`;
    const ts    = Math.floor(Date.now() / 1000);
    const r     = await safeFetch(`${BASE}/spot/orders/${orderId}?${query}`, {
      headers: headers(creds, 'GET', path, query, '', ts),
    }, 'gate');
    if (!r.ok) return null;
    return parseOrder(r.data as Record<string, unknown>);
  }
}
