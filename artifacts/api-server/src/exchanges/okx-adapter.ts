// ─── OKX REST Adapter ─────────────────────────────────────────────────────────
import { hmacSHA256Base64, safeFetch, stubSymbolRules } from './base-adapter.js';
import { classifyHttpFailure, check200Error, withUsdtValue, assertArray } from './exchange-error.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE = 'https://www.okx.com';
// OKX paper/simulated trading uses the same domain with x-simulated-trading: 1 header

function sign(secret: string, ts: string, method: string, path: string, body = ''): string {
  return hmacSHA256Base64(secret, ts + method + path + body);
}

function headers(creds: ExchangeCredentials, ts: string, signature: string, testnet = false) {
  return {
    'OK-ACCESS-KEY':        creds.apiKey,
    'OK-ACCESS-SIGN':       signature,
    'OK-ACCESS-TIMESTAMP':  ts,
    'OK-ACCESS-PASSPHRASE': creds.passphrase ?? '',
    'Content-Type':         'application/json',
    ...(testnet ? { 'x-simulated-trading': '1' } : {}),
  };
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'filled':   return 'filled';
    case 'canceled': return 'canceled';
    case 'partial_fill': case 'partially_filled': return 'partial';
    default: return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  return {
    orderId:     String(o['ordId'] ?? ''),
    clientId:    String(o['clOrdId'] ?? ''),
    symbol:      String(o['instId'] ?? ''),
    side:        String(o['side'] ?? '') as 'buy' | 'sell',
    type:        String(o['ordType'] ?? '').replace('_order', '') as 'market' | 'limit',
    status:      mapStatus(String(o['state'] ?? '')),
    quantity:    parseFloat(String(o['sz'] ?? '0')),
    filledQty:   parseFloat(String(o['fillSz'] ?? '0')),
    price:       parseFloat(String(o['px'] ?? '0')),
    avgPrice:    parseFloat(String(o['avgPx'] ?? '0')),
    fee:         Math.abs(parseFloat(String(o['fee'] ?? '0'))),
    feeCurrency: String(o['feeCcy'] ?? 'USDT'),
    timestamp:   parseInt(String(o['cTime'] ?? Date.now())),
    exchange:    'okx',
    raw: o,
  };
}

export class OkxAdapter implements ExchangeAdapter {
  readonly id   = 'okx';
  readonly name = 'OKX';

  normalizeSymbol(symbol: string): string {
    if (symbol.includes('-')) return symbol; // already OKX format
    const base = symbol.replace(/USDT$/, '');
    return `${base}-USDT`;
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/api/v5/public/time`, {}, 'okx');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const ts   = new Date().toISOString();
    const path = '/api/v5/account/config';
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r = await safeFetch(`${BASE}${path}`, {
      headers: headers(creds, ts, sig, !!creds.testnet),
    }, 'okx');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
    const d = (r.data as Record<string, unknown[]>)?.['data']?.[0] as Record<string, unknown> ?? {};
    const perm = String(d['perm'] ?? '');
    return {
      success: true,
      permissions: {
        read:     true,
        trade:    perm.includes('trade'),
        withdraw: perm.includes('withdraw'),
        futures:  perm.includes('futures'),
      },
      uid: String(d['uid'] ?? ''),
    };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    const r = await this.validateCredentials(creds);
    return r.permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const ts   = new Date().toISOString();
    const path = '/api/v5/account/balance';
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig, !!creds.testnet) }, 'okx');
    if (!r.ok) throw classifyHttpFailure('okx', r.status, r.error?.message);
    check200Error('okx', r.data, 'code', 'msg', ['0', 0]);
    const dataArr = assertArray('okx', (r.data as Record<string, unknown>)?.['data'] ?? [], '/api/v5/account/balance#data');
    const details = ((dataArr[0] as Record<string, unknown[]>)?.['details'] ?? []) as unknown[];
    return (assertArray('okx', details, '/api/v5/account/balance#details') as Array<Record<string, unknown>>)
      .filter(d => parseFloat(String(d['cashBal'] ?? '0')) > 0)
      .map(d => {
        const availN = parseFloat(String(d['availBal']  ?? '0'));
        const holdN  = parseFloat(String(d['frozenBal'] ?? '0'));
        const totalN = parseFloat(String(d['cashBal']   ?? '0'));
        return withUsdtValue({
          asset:     String(d['ccy'] ?? ''),
          available: Number.isFinite(availN) ? availN : 0,
          hold:      Number.isFinite(holdN)  ? holdN  : 0,
          total:     Number.isFinite(totalN) ? totalN : 0,
        });
      });
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${BASE}/api/v5/public/instruments?instType=SPOT&instId=${sym}`, {}, 'okx');
    if (!r.ok) return stubSymbolRules(sym);
    const info = ((r.data as Record<string, unknown[]>)?.['data']?.[0] ?? {}) as Record<string, string>;
    return {
      symbol:        sym,
      baseCurrency:  info['baseCcy'] ?? '',
      quoteCurrency: info['quoteCcy'] ?? 'USDT',
      minQty:        parseFloat(info['minSz'] ?? '0.00001'),
      maxQty:        parseFloat(info['maxMktSz'] ?? '9000000'),
      stepSize:      parseFloat(info['lotSz'] ?? '0.00001'),
      minNotional:   1,
      tickSize:      parseFloat(info['tickSz'] ?? '0.01'),
      maxLeverage:   1,
    };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const sym  = this.normalizeSymbol(order.symbol);
    const body = JSON.stringify({
      instId:  sym, tdMode: 'cash',
      side:    order.side, ordType: order.type === 'limit' ? 'limit' : 'market',
      sz:      String(order.quantity),
      ...(order.type === 'limit' && order.price ? { px: String(order.price) } : {}),
      ...(order.clientId ? { clOrdId: order.clientId } : {}),
    });
    const ts   = new Date().toISOString();
    const path = '/api/v5/trade/order';
    const sig  = sign(creds.secretKey, ts, 'POST', path, body);
    const r = await safeFetch(`${BASE}${path}`, { method: 'POST', headers: headers(creds, ts, sig, !!order.testnet), body }, 'okx');
    if (!r.ok) throw new Error(`OKX order failed: ${r.error?.message}`);
    const d   = ((r.data as Record<string, unknown[]>)?.['data']?.[0] ?? {}) as Record<string, unknown>;
    return { orderId: String(d['ordId'] ?? ''), clientId: String(d['clOrdId'] ?? ''), symbol: sym, side: order.side, type: order.type, status: 'open', quantity: order.quantity, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USDT', timestamp: Date.now(), exchange: 'okx', raw: d };
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/api/v5/market/ticker?instId=${sym}`, {}, 'okx');
    if (!r.ok) throw new Error(`OKX getPrice failed: ${r.error?.message}`);
    const item = ((r.data as Record<string, unknown[]>)?.['data']?.[0] ?? {}) as Record<string, string>;
    return parseFloat(item['last'] ?? '0');
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean> {
    if (!symbol) return false;
    const sym  = this.normalizeSymbol(symbol);
    const body = JSON.stringify({ instId: sym, ordId: orderId });
    const ts   = new Date().toISOString();
    const path = '/api/v5/trade/cancel-order';
    const sig  = sign(creds.secretKey, ts, 'POST', path, body);
    const r = await safeFetch(`${BASE}${path}`, { method: 'POST', headers: headers(creds, ts, sig, !!creds.testnet), body }, 'okx');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym  = symbol ? this.normalizeSymbol(symbol) : '';
    const path = `/api/v5/trade/orders-history?instType=SPOT${sym ? `&instId=${sym}` : ''}&limit=${limit}`;
    const ts   = new Date().toISOString();
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig, !!creds.testnet) }, 'okx');
    if (!r.ok) return [];
    return ((r.data as Record<string, unknown[]>)?.['data'] ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null> {
    if (!symbol) return null;
    const sym  = this.normalizeSymbol(symbol);
    const path = `/api/v5/trade/order?instId=${sym}&ordId=${orderId}`;
    const ts   = new Date().toISOString();
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig, !!creds.testnet) }, 'okx');
    if (!r.ok) return null;
    const d = (r.data as Record<string, unknown[]>)?.['data']?.[0];
    return d ? parseOrder(d as Record<string, unknown>) : null;
  }
}
