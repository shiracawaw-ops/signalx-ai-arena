// ─── Bitfinex v2 REST Adapter ─────────────────────────────────────────────────
import { hmacSHA384Base64, safeFetch, stubSymbolRules } from './base-adapter.js';
import { classifyHttpFailure, withUsdtValue, assertArray } from './exchange-error.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE = 'https://api.bitfinex.com';

function sign(secret: string, path: string, nonce: string, body = ''): string {
  return hmacSHA384Base64(secret, `/api/v2/${path}${nonce}${body}`);
}

function headers(creds: ExchangeCredentials, path: string, nonce: string, body = '') {
  return {
    'bfx-apikey':    creds.apiKey,
    'bfx-signature': sign(creds.secretKey, path, nonce, body),
    'bfx-nonce':     nonce,
    'Content-Type':  'application/json',
  };
}

function mapStatus(s: string): OrderResult['status'] {
  if (s.includes('EXECUTED'))         return 'filled';
  if (s.includes('CANCELED'))         return 'canceled';
  if (s.includes('PARTIALLY FILLED')) return 'partial';
  return 'open';
}

function parseOrder(o: unknown[]): OrderResult {
  return {
    orderId:     String(o[0] ?? ''),
    symbol:      String(o[3] ?? ''),
    side:        (o[7] as number) > 0 ? 'buy' : 'sell',
    type:        String(o[8] ?? '').toLowerCase().includes('market') ? 'market' : 'limit',
    status:      mapStatus(String(o[13] ?? '')),
    quantity:    Math.abs(o[7] as number),
    filledQty:   Math.abs((o[7] as number) - (o[6] as number)),
    price:       o[16] as number ?? 0,
    avgPrice:    o[17] as number ?? 0,
    fee:         0,
    feeCurrency: 'USD',
    timestamp:   o[5] as number ?? Date.now(),
    exchange:    'bitfinex',
    raw: o,
  };
}

export class BitfinexAdapter implements ExchangeAdapter {
  readonly id   = 'bitfinex';
  readonly name = 'Bitfinex';

  normalizeSymbol(symbol: string): string {
    const base = symbol.replace(/USDT?$/, '');
    return `t${base}UST`; // Bitfinex uses "tBTCUST" for BTC/USDT
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/v2/platform/status`, {}, 'bitfinex');
    return Date.now() - t;
  }

  private async auth(creds: ExchangeCredentials, endpoint: string, body = '{}'): Promise<{ ok: boolean; data: unknown; error?: string }> {
    const nonce = (Date.now() * 1000).toString();
    const path  = `auth/r/${endpoint}`;
    const r     = await safeFetch(`${BASE}/v2/${path}`, {
      method: 'POST',
      headers: headers(creds, path, nonce, body),
      body,
    }, 'bitfinex');
    return { ok: r.ok, data: r.data, error: r.error?.message };
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const r = await this.auth(creds, 'permissions');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error };
    const d = r.data as Record<string, string[]>;
    return {
      success: true,
      permissions: {
        read:     (d['read']?.length ?? 0) > 0,
        trade:    d['write']?.includes('orders') ?? false,
        withdraw: false,
        futures:  false,
      },
    };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const r = await this.auth(creds, 'wallets');
    if (!r.ok) throw classifyHttpFailure('bitfinex', undefined, r.error);
    // Bitfinex signals errors with a 200 + body of the form
    // ['error', code, message]. Detect and classify.
    if (Array.isArray(r.data) && r.data[0] === 'error') {
      const arr = r.data as unknown[];
      throw classifyHttpFailure('bitfinex', undefined, String(arr[2] ?? `error code ${String(arr[1])}`));
    }
    return (assertArray('bitfinex', r.data ?? [], 'auth/r/wallets') as unknown[][])
      .filter(w => Array.isArray(w) && w[0] === 'exchange' && parseFloat(String(w[2] ?? '0')) > 0)
      .map(w => {
        const totalN = parseFloat(String(w[2] ?? '0'));
        const availN = parseFloat(String(w[4] ?? w[2] ?? '0'));
        const total     = Number.isFinite(totalN) ? totalN : 0;
        const available = Number.isFinite(availN) ? availN : 0;
        const hold      = Math.max(0, total - available);
        return withUsdtValue({
          asset:     String(w[1] ?? '').replace('UST', 'USDT'),
          available, hold, total,
        });
      });
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    return stubSymbolRules(this.normalizeSymbol(symbol));
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`https://api-pub.bitfinex.com/v2/ticker/${sym}`, {}, 'bitfinex');
    if (!r.ok) throw new Error(`Bitfinex getPrice failed: ${r.error?.message}`);
    const arr = r.data as number[];
    return arr[6] ?? 0;
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    if (order.testnet) throw new Error('Bitfinex does not support testnet mode. Use DEMO or PAPER mode for simulated trading.');
    const sym  = this.normalizeSymbol(order.symbol);
    const qty  = order.side === 'sell' ? -order.quantity : order.quantity;
    const body = JSON.stringify({
      type:   order.type === 'limit' ? 'EXCHANGE LIMIT' : 'EXCHANGE MARKET',
      symbol: sym, amount: String(qty),
      ...(order.type === 'limit' && order.price ? { price: String(order.price) } : {}),
      ...(order.clientId ? { cid: parseInt(order.clientId) } : {}),
    });
    const nonce = (Date.now() * 1000).toString();
    const path  = 'auth/w/order/submit';
    const r     = await safeFetch(`${BASE}/v2/${path}`, {
      method: 'POST', headers: headers(creds, path, nonce, body), body,
    }, 'bitfinex');
    if (!r.ok) throw new Error(`Bitfinex order failed: ${r.error}`);
    const d = (r.data as unknown[][])?.[4]?.[0] as unknown[];
    return { orderId: String(d?.[0] ?? ''), symbol: sym, side: order.side, type: order.type, status: 'open', quantity: order.quantity, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USD', timestamp: Date.now(), exchange: 'bitfinex', raw: d };
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string): Promise<boolean> {
    const body  = JSON.stringify({ id: parseInt(orderId) });
    const nonce = (Date.now() * 1000).toString();
    const path  = 'auth/w/order/cancel';
    const r     = await safeFetch(`${BASE}/v2/${path}`, {
      method: 'POST', headers: headers(creds, path, nonce, body), body,
    }, 'bitfinex');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym  = symbol ? this.normalizeSymbol(symbol) : '';
    const path = `orders${sym ? `/${sym}` : ''}/hist`;
    const body = JSON.stringify({ limit });
    const r    = await this.auth(creds, path, body);
    if (!r.ok) return [];
    return ((r.data as unknown[][]) ?? []).map(parseOrder);
  }

  async getOrder(creds: ExchangeCredentials, orderId: string): Promise<OrderResult | null> {
    const r = await this.auth(creds, `orders/hist?id=${orderId}`);
    if (!r.ok) return null;
    const d = (r.data as unknown[][])?.[0];
    return d ? parseOrder(d) : null;
  }
}
