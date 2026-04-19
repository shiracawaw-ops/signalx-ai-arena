// ─── KuCoin REST Adapter (API v2) ─────────────────────────────────────────────
import { hmacSHA256Base64, safeFetch, stubSymbolRules, toUsdtPair } from './base-adapter.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE = 'https://api.kucoin.com';

function sign(secret: string, ts: number, method: string, path: string, body = ''): string {
  return hmacSHA256Base64(secret, `${ts}${method}${path}${body}`);
}

function encryptPassphrase(secret: string, passphrase: string): string {
  return hmacSHA256Base64(secret, passphrase);
}

function headers(creds: ExchangeCredentials, ts: number, sig: string, ppSig: string) {
  return {
    'KC-API-KEY':         creds.apiKey,
    'KC-API-SIGN':        sig,
    'KC-API-TIMESTAMP':   String(ts),
    'KC-API-PASSPHRASE':  ppSig,
    'KC-API-KEY-VERSION': '2',
    'Content-Type':       'application/json',
  };
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'done':      return 'filled';
    case 'cancelled': return 'canceled';
    default:          return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  const size  = parseFloat(String(o['size'] ?? '0'));
  const deal  = parseFloat(String(o['dealSize'] ?? '0'));
  return {
    orderId:     String(o['id'] ?? ''),
    clientId:    String(o['clientOid'] ?? ''),
    symbol:      String(o['symbol'] ?? ''),
    side:        String(o['side'] ?? '') as 'buy' | 'sell',
    type:        String(o['type'] ?? '') as 'market' | 'limit',
    status:      mapStatus(String(o['isActive'] === false ? 'done' : o['cancelExist'] ? 'cancelled' : 'active')),
    quantity:    size,
    filledQty:   deal,
    price:       parseFloat(String(o['price'] ?? '0')),
    avgPrice:    deal > 0 ? parseFloat(String(o['dealFunds'] ?? '0')) / deal : 0,
    fee:         parseFloat(String(o['fee'] ?? '0')),
    feeCurrency: String(o['feeCurrency'] ?? 'USDT'),
    timestamp:   parseInt(String(o['createdAt'] ?? Date.now())),
    exchange:    'kucoin',
    raw: o,
  };
}

export class KuCoinAdapter implements ExchangeAdapter {
  readonly id   = 'kucoin';
  readonly name = 'KuCoin';

  normalizeSymbol(symbol: string): string {
    if (symbol.includes('-')) return symbol;
    const base = symbol.replace(/USDT$/, '');
    return `${base}-USDT`;
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/api/v1/timestamp`, {}, 'kucoin');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const ts    = Date.now();
    const path  = '/api/v1/sub/user';
    const sig   = sign(creds.secretKey, ts, 'GET', path);
    const ppSig = encryptPassphrase(creds.secretKey, creds.passphrase ?? '');
    const r = await safeFetch(`${BASE}${path}`, {
      headers: headers(creds, ts, sig, ppSig),
    }, 'kucoin');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
    return { success: true, permissions: { read: true, trade: true, withdraw: false, futures: false } };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    // Fetch ALL account types (main + trade + margin) so we never miss funds
    const path  = '/api/v1/accounts';
    const ts    = Date.now();
    const sig   = sign(creds.secretKey, ts, 'GET', path);
    const ppSig = encryptPassphrase(creds.secretKey, creds.passphrase ?? '');
    const r = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig, ppSig) }, 'kucoin');
    if (!r.ok) throw new Error(r.error?.message ?? 'KuCoin balance fetch failed');
    const list = ((r.data as Record<string, unknown[]>)?.['data'] ?? []) as Array<Record<string, unknown>>;

    // Merge duplicate currency entries (same currency may appear in main + trade accounts)
    const merged = new Map<string, Balance>();
    for (const a of list) {
      const asset     = String(a['currency'] ?? '').toUpperCase();
      const available = parseFloat(String(a['available'] ?? '0'));
      const hold      = parseFloat(String(a['holds']     ?? '0'));
      const total     = parseFloat(String(a['balance']   ?? '0'));
      if (!asset || total <= 0) continue;
      const prev = merged.get(asset);
      if (prev) {
        merged.set(asset, {
          asset,
          available: prev.available + available,
          hold:      prev.hold      + hold,
          total:     prev.total     + total,
        });
      } else {
        merged.set(asset, { asset, available, hold, total });
      }
    }
    return Array.from(merged.values());
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${BASE}/api/v2/symbols/${sym}`, {}, 'kucoin');
    if (!r.ok) return stubSymbolRules(sym);
    const d = (r.data as Record<string, Record<string, unknown>>)?.['data'] ?? {};
    return {
      symbol:        sym,
      baseCurrency:  String(d['baseCurrency'] ?? ''),
      quoteCurrency: String(d['quoteCurrency'] ?? 'USDT'),
      minQty:        parseFloat(String(d['baseMinSize'] ?? '0.00001')),
      maxQty:        parseFloat(String(d['baseMaxSize'] ?? '9000000')),
      stepSize:      parseFloat(String(d['baseIncrement'] ?? '0.00001')),
      minNotional:   parseFloat(String(d['quoteMinSize'] ?? '1')),
      tickSize:      parseFloat(String(d['priceIncrement'] ?? '0.01')),
      maxLeverage:   1,
    };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const sym    = this.normalizeSymbol(order.symbol);
    const body   = JSON.stringify({
      clientOid: order.clientId ?? `sx_${Date.now()}`,
      side:      order.side,
      symbol:    sym,
      type:      order.type,
      size:      String(order.quantity),
      ...(order.type === 'limit' && order.price ? { price: String(order.price) } : {}),
    });
    const ts    = Date.now();
    const path  = '/api/v1/orders';
    const sig   = sign(creds.secretKey, ts, 'POST', path, body);
    const ppSig = encryptPassphrase(creds.secretKey, creds.passphrase ?? '');
    const r = await safeFetch(`${BASE}${path}`, { method: 'POST', headers: headers(creds, ts, sig, ppSig), body }, 'kucoin');
    if (!r.ok) throw new Error(`KuCoin order failed: ${r.error?.message}`);
    const d = (r.data as Record<string, Record<string, unknown>>)?.['data'] ?? {};
    return { orderId: String(d['orderId'] ?? ''), symbol: sym, side: order.side, type: order.type, status: 'open', quantity: order.quantity, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USDT', timestamp: Date.now(), exchange: 'kucoin', raw: d };
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string): Promise<boolean> {
    const ts    = Date.now();
    const path  = `/api/v1/orders/${orderId}`;
    const sig   = sign(creds.secretKey, ts, 'DELETE', path);
    const ppSig = encryptPassphrase(creds.secretKey, creds.passphrase ?? '');
    const r = await safeFetch(`${BASE}${path}`, { method: 'DELETE', headers: headers(creds, ts, sig, ppSig) }, 'kucoin');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym   = symbol ? this.normalizeSymbol(symbol) : '';
    const path  = `/api/v1/orders?status=done${sym ? `&symbol=${sym}` : ''}&pageSize=${limit}`;
    const ts    = Date.now();
    const sig   = sign(creds.secretKey, ts, 'GET', path);
    const ppSig = encryptPassphrase(creds.secretKey, creds.passphrase ?? '');
    const r = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig, ppSig) }, 'kucoin');
    if (!r.ok) return [];
    const items = ((r.data as Record<string, Record<string, unknown[]>>)?.['data']?.['items'] ?? []);
    return (items as Array<Record<string, unknown>>).map(parseOrder);
  }

  async getOrder(creds: ExchangeCredentials, orderId: string): Promise<OrderResult | null> {
    const ts    = Date.now();
    const path  = `/api/v1/orders/${orderId}`;
    const sig   = sign(creds.secretKey, ts, 'GET', path);
    const ppSig = encryptPassphrase(creds.secretKey, creds.passphrase ?? '');
    const r = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig, ppSig) }, 'kucoin');
    if (!r.ok) return null;
    const d = (r.data as Record<string, Record<string, unknown>>)?.['data'];
    return d ? parseOrder(d) : null;
  }
}
