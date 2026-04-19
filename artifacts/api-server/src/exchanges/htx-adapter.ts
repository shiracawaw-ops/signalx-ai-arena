// ─── HTX (Huobi) REST Adapter ─────────────────────────────────────────────────
import { hmacSHA256Base64, safeFetch, stubSymbolRules } from './base-adapter.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE     = 'https://api.huobi.pro';
const HOST     = 'api.huobi.pro';

function isoTimestamp(): string {
  return new Date().toISOString().replace(/\..+/, '');
}

function signParams(secret: string, method: string, host: string, path: string, params: Record<string, string>): string {
  const sortedQs = Object.entries(params).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const str = `${method}\n${host}\n${path}\n${sortedQs}`;
  return hmacSHA256Base64(secret, str);
}

function authQs(creds: ExchangeCredentials, method: string, path: string, extra?: Record<string, string>): string {
  const ts = isoTimestamp();
  const params: Record<string, string> = {
    AccessKeyId:      creds.apiKey,
    SignatureMethod:  'HmacSHA256',
    SignatureVersion: '2',
    Timestamp:        ts,
    ...extra,
  };
  const sig = signParams(creds.secretKey, method, HOST, path, params);
  const qs  = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${qs}&Signature=${encodeURIComponent(sig)}`;
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'filled':                           return 'filled';
    case 'canceled': case 'partial-canceled': return 'canceled';
    case 'partial-filled':                   return 'partial';
    default:                                 return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  return {
    orderId:     String(o['id'] ?? ''),
    clientId:    String(o['client-order-id'] ?? ''),
    symbol:      String(o['symbol'] ?? ''),
    side:        String(o['type'] ?? '').includes('buy') ? 'buy' : 'sell',
    type:        String(o['type'] ?? '').includes('market') ? 'market' : 'limit',
    status:      mapStatus(String(o['state'] ?? '')),
    quantity:    parseFloat(String(o['amount'] ?? '0')),
    filledQty:   parseFloat(String(o['field-amount'] ?? '0')),
    price:       parseFloat(String(o['price'] ?? '0')),
    avgPrice:    parseFloat(String(o['field-cash-amount'] && o['field-amount']
      ? (parseFloat(String(o['field-cash-amount'])) / parseFloat(String(o['field-amount']))).toString()
      : '0')),
    fee:         parseFloat(String(o['field-fees'] ?? '0')),
    feeCurrency: 'USDT',
    timestamp:   parseInt(String(o['created-at'] ?? Date.now())),
    exchange:    'htx',
    raw: o,
  };
}

export class HtxAdapter implements ExchangeAdapter {
  readonly id   = 'htx';
  readonly name = 'HTX (Huobi)';

  private accountId: string | null = null;

  normalizeSymbol(symbol: string): string {
    return symbol.toLowerCase().replace(/[-_]/g, '').replace(/usdt$/, 'usdt');
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/v1/common/timestamp`, {}, 'htx');
    return Date.now() - t;
  }

  private async getAccountId(creds: ExchangeCredentials): Promise<string> {
    if (this.accountId) return this.accountId;
    const path = '/v1/account/accounts';
    const q    = authQs(creds, 'GET', path);
    const r    = await safeFetch(`${BASE}${path}?${q}`, {}, 'htx');
    if (!r.ok) throw new Error('Cannot get HTX account ID');
    const list = (r.data as Record<string, Array<Record<string, unknown>>>)?.['data'] ?? [];
    const spot = list.find(a => a['type'] === 'spot' && a['state'] === 'working');
    this.accountId = String(spot?.['id'] ?? list[0]?.['id'] ?? '');
    return this.accountId;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const path = '/v1/account/accounts';
    const q    = authQs(creds, 'GET', path);
    const r    = await safeFetch(`${BASE}${path}?${q}`, {}, 'htx');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
    return { success: true, permissions: { read: true, trade: true, withdraw: false, futures: false } };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const acctId = await this.getAccountId(creds);
    const path   = `/v1/account/accounts/${acctId}/balance`;
    const q      = authQs(creds, 'GET', path);
    const r      = await safeFetch(`${BASE}${path}?${q}`, {}, 'htx');
    if (!r.ok) throw new Error(r.error?.message);
    const list = ((r.data as Record<string, Record<string, unknown[]>>)?.['data']?.['list'] ?? []) as Array<Record<string, string>>;
    const map  = new Map<string, { available: number; hold: number }>();
    for (const item of list) {
      const cur = item['currency'] ?? '';
      const bal = parseFloat(item['balance'] ?? '0');
      if (!map.has(cur)) map.set(cur, { available: 0, hold: 0 });
      const entry = map.get(cur)!;
      if (item['type'] === 'trade') entry.available = bal;
      else entry.hold = bal;
    }
    return [...map.entries()]
      .filter(([, v]) => v.available + v.hold > 0)
      .map(([asset, v]) => ({ asset: asset.toUpperCase(), ...v, total: v.available + v.hold }));
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${BASE}/v1/common/symbols`, {}, 'htx');
    if (!r.ok) return stubSymbolRules(sym);
    const list = (r.data as Record<string, Array<Record<string, unknown>>>)?.['data'] ?? [];
    const info = list.find(s => s['symbol'] === sym);
    if (!info) return stubSymbolRules(sym);
    return {
      symbol: sym, baseCurrency: String(info['base-currency'] ?? ''), quoteCurrency: String(info['quote-currency'] ?? 'usdt'),
      minQty:      parseFloat(String(info['min-order-amt'] ?? '0.00001')),
      maxQty:      parseFloat(String(info['max-order-amt'] ?? '9000000')),
      stepSize:    Math.pow(10, -(info['amount-precision'] as number ?? 5)),
      minNotional: parseFloat(String(info['min-order-value'] ?? '1')),
      tickSize:    Math.pow(10, -(info['price-precision'] as number ?? 2)),
      maxLeverage: 1,
    };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const acctId = await this.getAccountId(creds);
    const sym    = this.normalizeSymbol(order.symbol);
    const side   = `${order.side}-${order.type}`;
    const path   = '/v1/order/orders/place';
    const q      = authQs(creds, 'POST', path);
    const body   = JSON.stringify({
      'account-id': acctId, symbol: sym, type: side,
      amount:        String(order.quantity),
      ...(order.type === 'limit' && order.price ? { price: String(order.price) } : {}),
      ...(order.clientId ? { 'client-order-id': order.clientId } : {}),
      source: 'spot-api',
    });
    const r = await safeFetch(`${BASE}${path}?${q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }, 'htx');
    if (!r.ok) throw new Error(`HTX order failed: ${r.error?.message}`);
    const d = r.data as Record<string, unknown>;
    return { orderId: String(d['data'] ?? ''), symbol: sym, side: order.side, type: order.type, status: 'open', quantity: order.quantity, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USDT', timestamp: Date.now(), exchange: 'htx', raw: d };
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string): Promise<boolean> {
    const path = `/v1/order/orders/${orderId}/submitcancel`;
    const q    = authQs(creds, 'POST', path);
    const r    = await safeFetch(`${BASE}${path}?${q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, 'htx');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym  = symbol ? this.normalizeSymbol(symbol) : 'btcusdt';
    const path = '/v1/order/orders';
    const q    = authQs(creds, 'GET', path, { symbol: sym, states: 'filled,canceled', size: String(limit) });
    const r    = await safeFetch(`${BASE}${path}?${q}`, {}, 'htx');
    if (!r.ok) return [];
    return ((r.data as Record<string, unknown[]>)?.['data'] ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string): Promise<OrderResult | null> {
    const path = `/v1/order/orders/${orderId}`;
    const q    = authQs(creds, 'GET', path);
    const r    = await safeFetch(`${BASE}${path}?${q}`, {}, 'htx');
    if (!r.ok) return null;
    const d = (r.data as Record<string, Record<string, unknown>>)?.['data'];
    return d ? parseOrder(d) : null;
  }
}
