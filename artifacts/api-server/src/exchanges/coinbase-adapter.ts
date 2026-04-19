// ─── Coinbase Advanced Trade Adapter ─────────────────────────────────────────
import { hmacSHA256, safeFetch, stubSymbolRules } from './base-adapter.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE         = 'https://api.coinbase.com';
const TESTNET_BASE = 'https://api-sandbox.coinbase.com';

function sign(secret: string, ts: string, method: string, path: string, body = ''): string {
  return hmacSHA256(secret, ts + method + path + body);
}

function headers(creds: ExchangeCredentials, ts: string, sig: string) {
  return {
    'CB-ACCESS-KEY':        creds.apiKey,
    'CB-ACCESS-SIGN':       sig,
    'CB-ACCESS-TIMESTAMP':  ts,
    'CB-ACCESS-PASSPHRASE': creds.passphrase ?? '',
    'Content-Type':         'application/json',
  };
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'FILLED':           return 'filled';
    case 'CANCELLED':        return 'canceled';
    case 'FAILED':           return 'rejected';
    case 'OPEN': case 'PENDING': return 'open';
    default:                 return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  const conf = (o['order_configuration'] as Record<string, Record<string, string>> | undefined) ?? {};
  const mktOrd = conf['market_market_ioc'] ?? conf['limit_limit_gtc'] ?? conf['limit_limit_gtd'] ?? {};
  return {
    orderId:     String(o['order_id'] ?? ''),
    clientId:    String(o['client_order_id'] ?? ''),
    symbol:      String(o['product_id'] ?? ''),
    side:        String(o['side'] ?? '').toLowerCase() as 'buy' | 'sell',
    type:        Object.keys(conf)[0]?.includes('market') ? 'market' : 'limit',
    status:      mapStatus(String(o['status'] ?? '')),
    quantity:    parseFloat(mktOrd['base_size'] ?? '0'),
    filledQty:   parseFloat(String(o['filled_size'] ?? '0')),
    price:       parseFloat(mktOrd['limit_price'] ?? '0'),
    avgPrice:    parseFloat(String(o['average_filled_price'] ?? '0')),
    fee:         parseFloat(String(o['total_fees'] ?? '0')),
    feeCurrency: 'USD',
    timestamp:   new Date(String(o['created_time'] ?? '')).getTime() || Date.now(),
    exchange:    'coinbase',
    raw: o,
  };
}

export class CoinbaseAdapter implements ExchangeAdapter {
  readonly id   = 'coinbase';
  readonly name = 'Coinbase Advanced';

  normalizeSymbol(symbol: string): string {
    const base = symbol.replace(/[-/]?(USDT|USD)$/i, '');
    return `${base}-USD`;
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/api/v3/brokerage/products/BTC-USD`, {}, 'coinbase');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const ts   = String(Math.floor(Date.now() / 1000));
    const path = '/api/v3/brokerage/accounts?limit=5';
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r    = await safeFetch(`${base}${path}`, { headers: headers(creds, ts, sig) }, 'coinbase');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
    return { success: true, permissions: { read: true, trade: true, withdraw: false, futures: false } };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const ts   = String(Math.floor(Date.now() / 1000));
    const path = '/api/v3/brokerage/accounts';
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r    = await safeFetch(`${base}${path}`, { headers: headers(creds, ts, sig) }, 'coinbase');
    if (!r.ok) throw new Error(r.error?.message);
    const accounts = ((r.data as Record<string, unknown[]>)?.['accounts'] ?? []) as Array<Record<string, unknown>>;
    return accounts
      .filter(a => parseFloat(String((a['available_balance'] as Record<string, string>)?.['value'] ?? '0')) > 0)
      .map(a => {
        const avail = a['available_balance'] as Record<string, string> ?? {};
        const hold  = a['hold'] as Record<string, string> ?? {};
        return {
          asset:     String(a['currency'] ?? ''),
          available: parseFloat(avail['value'] ?? '0'),
          hold:      parseFloat(hold['value'] ?? '0'),
          total:     parseFloat(avail['value'] ?? '0') + parseFloat(hold['value'] ?? '0'),
        };
      });
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const base = _creds.testnet ? TESTNET_BASE : BASE;
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${base}/api/v3/brokerage/products/${sym}`, {}, 'coinbase');
    if (!r.ok) return stubSymbolRules(sym);
    const d = r.data as Record<string, string>;
    return {
      symbol: sym, baseCurrency: d['base_currency_id'] ?? '', quoteCurrency: d['quote_currency_id'] ?? 'USD',
      minQty:      parseFloat(d['base_min_size'] ?? '0.00001'),
      maxQty:      parseFloat(d['base_max_size'] ?? '9000000'),
      stepSize:    parseFloat(d['base_increment'] ?? '0.00001'),
      minNotional: parseFloat(d['quote_min_size'] ?? '1'),
      tickSize:    parseFloat(d['quote_increment'] ?? '0.01'),
      maxLeverage: 1,
    };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const base = order.testnet ? TESTNET_BASE : BASE;
    const sym  = this.normalizeSymbol(order.symbol);
    const conf = order.type === 'market'
      ? { market_market_ioc: { base_size: String(order.quantity) } }
      : { limit_limit_gtc:   { base_size: String(order.quantity), limit_price: String(order.price), post_only: false } };
    const body = JSON.stringify({ client_order_id: order.clientId ?? `sx_${Date.now()}`, product_id: sym, side: order.side.toUpperCase(), order_configuration: conf });
    const ts   = String(Math.floor(Date.now() / 1000));
    const path = '/api/v3/brokerage/orders';
    const sig  = sign(creds.secretKey, ts, 'POST', path, body);
    const r    = await safeFetch(`${base}${path}`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'coinbase');
    if (!r.ok) throw new Error(`Coinbase order failed: ${r.error?.message}`);
    const d = (r.data as Record<string, Record<string, unknown>>)?.['success_response'] ?? {};
    return { orderId: String(d['order_id'] ?? ''), symbol: sym, side: order.side, type: order.type, status: 'open', quantity: order.quantity, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USD', timestamp: Date.now(), exchange: 'coinbase', raw: d };
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/api/v3/brokerage/products/${sym}`, {}, 'coinbase');
    if (!r.ok) throw new Error(`Coinbase getPrice failed: ${r.error?.message}`);
    const d = r.data as Record<string, string>;
    return parseFloat(d['price'] ?? d['quote_min_size'] ?? '0');
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string): Promise<boolean> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const body = JSON.stringify({ order_ids: [orderId] });
    const ts   = String(Math.floor(Date.now() / 1000));
    const path = '/api/v3/brokerage/orders/batch_cancel';
    const sig  = sign(creds.secretKey, ts, 'POST', path, body);
    const r    = await safeFetch(`${base}${path}`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'coinbase');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const sym  = symbol ? this.normalizeSymbol(symbol) : '';
    const path = `/api/v3/brokerage/orders/historical/batch?limit=${limit}${sym ? `&product_id=${sym}` : ''}`;
    const ts   = String(Math.floor(Date.now() / 1000));
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r    = await safeFetch(`${base}${path}`, { headers: headers(creds, ts, sig) }, 'coinbase');
    if (!r.ok) return [];
    return ((r.data as Record<string, unknown[]>)?.['orders'] ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string): Promise<OrderResult | null> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const path = `/api/v3/brokerage/orders/historical/${orderId}`;
    const ts   = String(Math.floor(Date.now() / 1000));
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r    = await safeFetch(`${base}${path}`, { headers: headers(creds, ts, sig) }, 'coinbase');
    if (!r.ok) return null;
    const d = (r.data as Record<string, Record<string, unknown>>)?.['order'];
    return d ? parseOrder(d) : null;
  }
}
