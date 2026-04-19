// ─── Kraken REST Adapter ──────────────────────────────────────────────────────
import { hmacSHA512Base64, sha256, safeFetch, stubSymbolRules } from './base-adapter.js';
import { createHmac } from 'node:crypto';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE = 'https://api.kraken.com';

function nonce(): string { return Date.now().toString(); }

function sign(secret: string, path: string, body: string, nonce: string): string {
  const secretBuf = Buffer.from(secret, 'base64');
  const message   = path + sha256(nonce + body);
  return createHmac('sha512', secretBuf).update(message).digest('base64');
}

function encodeBody(params: Record<string, string | number>): string {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function mapStatus(o: Record<string, unknown>): OrderResult['status'] {
  const s = String(o['status'] ?? '');
  switch (s) {
    case 'closed': return 'filled';
    case 'canceled': return 'canceled';
    case 'expired': return 'canceled';
    default: return 'open';
  }
}

function parseOrder(id: string, o: Record<string, unknown>): OrderResult {
  const desc = o['descr'] as Record<string, unknown> ?? {};
  return {
    orderId:     id,
    symbol:      String(desc['pair'] ?? ''),
    side:        String(desc['type'] ?? '') as 'buy' | 'sell',
    type:        String(desc['ordertype'] ?? '') as 'market' | 'limit',
    status:      mapStatus(o),
    quantity:    parseFloat(String(o['vol'] ?? '0')),
    filledQty:   parseFloat(String(o['vol_exec'] ?? '0')),
    price:       parseFloat(String(desc['price'] ?? '0')),
    avgPrice:    parseFloat(String(o['price'] ?? '0')),
    fee:         parseFloat(String(o['fee'] ?? '0')),
    feeCurrency: 'USD',
    timestamp:   Math.round(parseFloat(String(o['opentm'] ?? Date.now() / 1000)) * 1000),
    exchange:    'kraken',
    raw: o,
  };
}

export class KrakenAdapter implements ExchangeAdapter {
  readonly id   = 'kraken';
  readonly name = 'Kraken';

  normalizeSymbol(symbol: string): string {
    // Kraken uses XXBTZUSD for BTC/USD, XETHZUSD for ETH, etc.
    const map: Record<string, string> = {
      'BTC': 'XXBTZUSDT', 'ETH': 'XETHZUSDT', 'XRP': 'XXRPZUSDT',
      'SOL': 'SOLUSDT',   'ADA': 'ADAUSDT',    'DOGE': 'XDGZUSDT',
    };
    const base = symbol.replace(/USDT$/, '');
    return map[base] ?? `${base}USDT`;
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/0/public/Time`, {}, 'kraken');
    return Date.now() - t;
  }

  private async privatePost(creds: ExchangeCredentials, endpoint: string, params: Record<string, string | number>): Promise<{ ok: boolean; data: unknown; error?: unknown }> {
    const n    = nonce();
    const body = encodeBody({ nonce: n, ...params });
    const path = `/0/private/${endpoint}`;
    const sig  = sign(creds.secretKey, path, body, n);
    const r    = await safeFetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'API-Key':  creds.apiKey,
        'API-Sign': sig,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }, 'kraken');
    if (!r.ok) return { ok: false, data: null, error: r.error?.message };
    const d = r.data as Record<string, unknown>;
    const errs = d['error'] as string[] | undefined;
    if (errs?.length) return { ok: false, data: null, error: errs.join(', ') };
    return { ok: true, data: d['result'] };
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const r = await this.privatePost(creds, 'Balance', {});
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: String(r.error) };
    return { success: true, permissions: { read: true, trade: true, withdraw: false, futures: false } };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const r = await this.privatePost(creds, 'Balance', {});
    if (!r.ok) throw new Error(String(r.error));
    return Object.entries(r.data as Record<string, string>)
      .filter(([, v]) => parseFloat(v) > 0)
      .map(([k, v]) => {
        const asset = k.replace(/^X|Z$|Z(?=USD)/g, '').replace('XBT', 'BTC');
        return { asset, available: parseFloat(v), hold: 0, total: parseFloat(v) };
      });
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    return stubSymbolRules(this.normalizeSymbol(symbol));
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const r = await this.privatePost(creds, 'AddOrder', {
      pair:      this.normalizeSymbol(order.symbol),
      type:      order.side,
      ordertype: order.type,
      volume:    order.quantity,
      ...(order.type === 'limit' && order.price ? { price: order.price } : {}),
      ...(order.clientId ? { userref: order.clientId } : {}),
    });
    if (!r.ok) throw new Error(`Kraken order failed: ${r.error}`);
    const d = r.data as Record<string, unknown>;
    const txids = (d['txid'] as string[]) ?? [];
    return { orderId: txids[0] ?? '', symbol: this.normalizeSymbol(order.symbol), side: order.side, type: order.type, status: 'open', quantity: order.quantity, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USD', timestamp: Date.now(), exchange: 'kraken', raw: d };
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string): Promise<boolean> {
    const r = await this.privatePost(creds, 'CancelOrder', { txid: orderId });
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, _symbol?: string, _limit = 50): Promise<OrderResult[]> {
    const r = await this.privatePost(creds, 'ClosedOrders', { trades: 'true' });
    if (!r.ok) return [];
    const d = (r.data as Record<string, Record<string, Record<string, unknown>>>)?.['closed'] ?? {};
    return Object.entries(d).map(([id, o]) => parseOrder(id, o));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string): Promise<OrderResult | null> {
    const r = await this.privatePost(creds, 'QueryOrders', { txid: orderId });
    if (!r.ok) return null;
    const d   = r.data as Record<string, Record<string, unknown>>;
    const o   = d[orderId];
    return o ? parseOrder(orderId, o) : null;
  }
}
