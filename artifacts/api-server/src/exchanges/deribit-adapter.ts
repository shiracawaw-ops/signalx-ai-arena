// ─── Deribit REST Adapter (v2) ─────────────────────────────────────────────────
// Deribit uses client_id/client_secret authentication via OAuth2 token
import { safeFetch, stubSymbolRules } from './base-adapter.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE         = 'https://www.deribit.com/api/v2';
const TESTNET_BASE = 'https://test.deribit.com/api/v2';

// Token cache (server-side only, per-request lifecycle is OK for proxy)
const tokenCache = new Map<string, { token: string; expires: number }>();

async function getToken(apiKey: string, secret: string, base = BASE): Promise<string> {
  const cacheKey = `${apiKey.slice(0, 8)}:${base.includes('test') ? 'test' : 'prod'}`;
  const cached   = tokenCache.get(cacheKey);
  if (cached && cached.expires > Date.now() + 30_000) return cached.token;

  const r = await safeFetch(`${base}/public/auth?client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`, {}, 'deribit');
  if (!r.ok) throw new Error(`Deribit auth failed: ${r.error?.message}`);
  const d = ((r.data as Record<string, Record<string, unknown>>)?.['result'] ?? {});
  const token   = String(d['access_token'] ?? '');
  const expires = Date.now() + (Number(d['expires_in'] ?? 900) * 1000);
  tokenCache.set(cacheKey, { token, expires });
  return token;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'filled':   return 'filled';
    case 'cancelled': return 'canceled';
    case 'rejected': return 'rejected';
    default:         return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  return {
    orderId:     String(o['order_id'] ?? ''),
    clientId:    String(o['label'] ?? ''),
    symbol:      String(o['instrument_name'] ?? ''),
    side:        String(o['direction'] ?? '') as 'buy' | 'sell',
    type:        String(o['order_type'] ?? '') as 'market' | 'limit',
    status:      mapStatus(String(o['order_state'] ?? '')),
    quantity:    parseFloat(String(o['amount'] ?? '0')),
    filledQty:   parseFloat(String(o['filled_amount'] ?? '0')),
    price:       parseFloat(String(o['price'] ?? '0')),
    avgPrice:    parseFloat(String(o['average_price'] ?? '0')),
    fee:         parseFloat(String(o['commission'] ?? '0')),
    feeCurrency: 'USD',
    timestamp:   parseInt(String(o['creation_timestamp'] ?? Date.now())),
    exchange:    'deribit',
    raw: o,
  };
}

export class DeribitAdapter implements ExchangeAdapter {
  readonly id   = 'deribit';
  readonly name = 'Deribit';

  normalizeSymbol(symbol: string): string {
    // Deribit uses perpetual contracts like BTC-PERPETUAL, ETH-PERPETUAL
    const base = symbol.replace(/USDT$|USD$|-PERP$/i, '');
    return `${base}-PERPETUAL`;
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/public/test`, {}, 'deribit');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    try {
      const base  = creds.testnet ? TESTNET_BASE : BASE;
      const token = await getToken(creds.apiKey, creds.secretKey, base);
      const r     = await safeFetch(`${base}/private/get_account_summary?currency=BTC&extended=false`, {
        headers: authHeaders(token),
      }, 'deribit');
      if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
      return { success: true, permissions: { read: true, trade: true, withdraw: false, futures: true } };
    } catch (e) {
      return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: (e as Error).message };
    }
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const base    = creds.testnet ? TESTNET_BASE : BASE;
    const token   = await getToken(creds.apiKey, creds.secretKey, base);
    const currencies = ['BTC', 'ETH', 'USDC', 'USDT'];
    const results: Balance[] = [];
    for (const ccy of currencies) {
      const r = await safeFetch(`${base}/private/get_account_summary?currency=${ccy}&extended=false`, {
        headers: authHeaders(token),
      }, 'deribit');
      if (r.ok) {
        const d = (r.data as Record<string, Record<string, unknown>>)?.['result'] ?? {};
        const total = parseFloat(String(d['equity'] ?? d['balance'] ?? '0'));
        if (total > 0) {
          results.push({
            asset: ccy, available: parseFloat(String(d['available_funds'] ?? '0')),
            hold: Math.max(0, total - parseFloat(String(d['available_funds'] ?? '0'))),
            total,
          });
        }
      }
    }
    return results;
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const base = _creds.testnet ? TESTNET_BASE : BASE;
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${base}/public/get_instrument?instrument_name=${sym}`, {}, 'deribit');
    if (!r.ok) return stubSymbolRules(sym);
    const d = (r.data as Record<string, Record<string, unknown>>)?.['result'] ?? {};
    return {
      symbol: sym, baseCurrency: String(d['base_currency'] ?? ''), quoteCurrency: String(d['quote_currency'] ?? 'USD'),
      minQty:      parseFloat(String(d['min_trade_amount'] ?? '1')),
      maxQty:      parseFloat(String(d['max_trade_amount'] ?? '9000000')),
      stepSize:    parseFloat(String(d['contract_size'] ?? d['tick_size'] ?? '1')),
      minNotional: 1,
      tickSize:    parseFloat(String(d['tick_size'] ?? '0.5')),
      maxLeverage: parseFloat(String(d['leverage_data'] ?? '50')),
    };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const base  = order.testnet ? TESTNET_BASE : BASE;
    const token = await getToken(creds.apiKey, creds.secretKey, base);
    const sym   = this.normalizeSymbol(order.symbol);
    const ep    = order.side === 'buy' ? 'buy' : 'sell';
    const body  = JSON.stringify({
      instrument_name: sym,
      amount: order.quantity,
      type:   order.type,
      ...(order.type === 'limit' && order.price ? { price: order.price } : {}),
      ...(order.clientId ? { label: order.clientId } : {}),
    });
    const r = await safeFetch(`${base}/private/${ep}`, {
      method: 'POST', headers: authHeaders(token), body,
    }, 'deribit');
    if (!r.ok) throw new Error(`Deribit order failed: ${r.error?.message}`);
    const d = ((r.data as Record<string, Record<string, unknown>>)?.['result']?.['order'] ?? {}) as Record<string, unknown>;
    return parseOrder(d);
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/public/ticker?instrument_name=${sym}`, {}, 'deribit');
    if (!r.ok) throw new Error(`Deribit getPrice failed: ${r.error?.message}`);
    const result = (r.data as Record<string, Record<string, unknown>>)?.['result'] ?? {};
    return parseFloat(String(result['last_price'] ?? result['mark_price'] ?? '0'));
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string): Promise<boolean> {
    const base  = creds.testnet ? TESTNET_BASE : BASE;
    const token = await getToken(creds.apiKey, creds.secretKey, base);
    const body  = JSON.stringify({ order_id: orderId });
    const r     = await safeFetch(`${base}/private/cancel`, {
      method: 'POST', headers: authHeaders(token), body,
    }, 'deribit');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const base  = creds.testnet ? TESTNET_BASE : BASE;
    const token = await getToken(creds.apiKey, creds.secretKey, base);
    const sym   = symbol ? this.normalizeSymbol(symbol) : 'BTC-PERPETUAL';
    const r     = await safeFetch(`${base}/private/get_order_history_by_instrument?instrument_name=${sym}&count=${limit}`, {
      headers: authHeaders(token),
    }, 'deribit');
    if (!r.ok) return [];
    return (((r.data as Record<string, unknown[]>)?.['result']) ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string): Promise<OrderResult | null> {
    const base  = creds.testnet ? TESTNET_BASE : BASE;
    const token = await getToken(creds.apiKey, creds.secretKey, base);
    const r     = await safeFetch(`${base}/private/get_order_state?order_id=${orderId}`, {
      headers: authHeaders(token),
    }, 'deribit');
    if (!r.ok) return null;
    const d = (r.data as Record<string, Record<string, unknown>>)?.['result'];
    return d ? parseOrder(d) : null;
  }
}
