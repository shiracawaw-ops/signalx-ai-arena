// ─── Bitget REST Adapter (v2) ─────────────────────────────────────────────────
import { hmacSHA256Base64, safeFetch, stubSymbolRules, toUsdtPair } from './base-adapter.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE = 'https://api.bitget.com';

function sign(secret: string, ts: string, method: string, path: string, body = ''): string {
  return hmacSHA256Base64(secret, ts + method.toUpperCase() + path + body);
}

function headers(creds: ExchangeCredentials, ts: string, sig: string) {
  return {
    'ACCESS-KEY':        creds.apiKey,
    'ACCESS-SIGN':       sig,
    'ACCESS-TIMESTAMP':  ts,
    'ACCESS-PASSPHRASE': creds.passphrase ?? '',
    'Content-Type':      'application/json',
    'locale':            'en-US',
  };
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'full_fill':    return 'filled';
    case 'cancelled':    return 'canceled';
    case 'partial_fill': return 'partial';
    default:             return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  return {
    orderId:     String(o['orderId'] ?? ''),
    clientId:    String(o['clientOid'] ?? ''),
    symbol:      String(o['symbol'] ?? ''),
    side:        String(o['side'] ?? '') as 'buy' | 'sell',
    type:        String(o['orderType'] ?? '') as 'market' | 'limit',
    status:      mapStatus(String(o['status'] ?? '')),
    quantity:    parseFloat(String(o['size'] ?? '0')),
    filledQty:   parseFloat(String(o['baseVolume'] ?? '0')),
    price:       parseFloat(String(o['price'] ?? '0')),
    avgPrice:    parseFloat(String(o['priceAvg'] ?? '0')),
    fee:         parseFloat(String(o['feeDetail'] ?? '0')),
    feeCurrency: 'USDT',
    timestamp:   parseInt(String(o['cTime'] ?? Date.now())),
    exchange:    'bitget',
    raw: o,
  };
}

export class BitgetAdapter implements ExchangeAdapter {
  readonly id   = 'bitget';
  readonly name = 'Bitget';

  normalizeSymbol(symbol: string): string { return toUsdtPair(symbol); }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/api/v2/public/time`, {}, 'bitget');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const ts  = Date.now().toString();
    const sig = sign(creds.secretKey, ts, 'GET', '/api/v2/spot/account/info');
    const r   = await safeFetch(`${BASE}/api/v2/spot/account/info`, {
      headers: headers(creds, ts, sig),
    }, 'bitget');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
    return { success: true, permissions: { read: true, trade: true, withdraw: false, futures: false } };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const ts   = Date.now().toString();
    const path = '/api/v2/spot/account/assets';
    const sig  = sign(creds.secretKey, ts, 'GET', path);
    const r    = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig) }, 'bitget');
    if (!r.ok) throw new Error(r.error?.message);
    const list = ((r.data as Record<string, unknown[]>)?.['data'] ?? []) as Array<Record<string, unknown>>;
    return list
      .filter(a => parseFloat(String(a['available'] ?? '0')) + parseFloat(String(a['frozen'] ?? '0')) > 0)
      .map(a => ({
        asset:     String(a['coin'] ?? ''),
        available: parseFloat(String(a['available'] ?? '0')),
        hold:      parseFloat(String(a['frozen'] ?? '0')),
        total:     parseFloat(String(a['available'] ?? '0')) + parseFloat(String(a['frozen'] ?? '0')),
      }));
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${BASE}/api/v2/spot/public/symbols?symbol=${sym}`, {}, 'bitget');
    if (!r.ok) return stubSymbolRules(sym);
    const d = ((r.data as Record<string, unknown[]>)?.['data']?.[0] ?? {}) as Record<string, string>;
    return {
      symbol: sym, baseCurrency: d['baseCoin'] ?? '', quoteCurrency: d['quoteCoin'] ?? 'USDT',
      minQty:      parseFloat(d['minTradeAmount'] ?? '0.00001'),
      maxQty:      parseFloat(d['maxTradeAmount'] ?? '9000000'),
      stepSize:    parseFloat(d['quantityPrecision'] ? Math.pow(10, -parseInt(d['quantityPrecision'])).toString() : '0.00001'),
      minNotional: parseFloat(d['minTradeUSDT'] ?? '1'),
      tickSize:    parseFloat(d['pricePrecision'] ? Math.pow(10, -parseInt(d['pricePrecision'])).toString() : '0.01'),
      maxLeverage: 1,
    };
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/api/v2/spot/market/tickers?symbol=${sym}`, {}, 'bitget');
    if (!r.ok) throw new Error(`Bitget getPrice failed: ${r.error?.message}`);
    const item = ((r.data as Record<string, unknown[]>)?.['data']?.[0] ?? {}) as Record<string, string>;
    return parseFloat(item['lastPr'] ?? item['close'] ?? '0');
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    if (order.testnet) throw new Error('Bitget does not support testnet mode. Use DEMO or PAPER mode for simulated trading.');
    const sym  = this.normalizeSymbol(order.symbol);
    const body = JSON.stringify({
      symbol:    sym,
      side:      order.side,
      orderType: order.type,
      size:      String(order.quantity),
      ...(order.type === 'limit' && order.price ? { price: String(order.price) } : {}),
      ...(order.clientId ? { clientOid: order.clientId } : {}),
      force:     'gtc',
    });
    const ts   = Date.now().toString();
    const path = '/api/v2/spot/trade/place-order';
    const sig  = sign(creds.secretKey, ts, 'POST', path, body);
    const r    = await safeFetch(`${BASE}${path}`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'bitget');
    if (!r.ok) throw new Error(`Bitget order failed: ${r.error?.message}`);
    const d = ((r.data as Record<string, Record<string, unknown>>)?.['data'] ?? {});
    return { orderId: String(d['orderId'] ?? ''), symbol: sym, side: order.side, type: order.type, status: 'open', quantity: order.quantity, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USDT', timestamp: Date.now(), exchange: 'bitget', raw: d };
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean> {
    if (!symbol) return false;
    const body = JSON.stringify({ symbol: this.normalizeSymbol(symbol), orderId });
    const ts   = Date.now().toString();
    const path = '/api/v2/spot/trade/cancel-order';
    const sig  = sign(creds.secretKey, ts, 'POST', path, body);
    const r    = await safeFetch(`${BASE}${path}`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'bitget');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym   = symbol ? this.normalizeSymbol(symbol) : '';
    const path  = `/api/v2/spot/trade/history-orders?${sym ? `symbol=${sym}&` : ''}limit=${limit}`;
    const ts    = Date.now().toString();
    const sig   = sign(creds.secretKey, ts, 'GET', path.split('?')[0]);
    const r     = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig) }, 'bitget');
    if (!r.ok) return [];
    return (((r.data as Record<string, unknown[]>)?.['data']) ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string): Promise<OrderResult | null> {
    const path = `/api/v2/spot/trade/orderInfo?orderId=${orderId}`;
    const ts   = Date.now().toString();
    const sig  = sign(creds.secretKey, ts, 'GET', '/api/v2/spot/trade/orderInfo');
    const r    = await safeFetch(`${BASE}${path}`, { headers: headers(creds, ts, sig) }, 'bitget');
    if (!r.ok) return null;
    const d = (r.data as Record<string, unknown[]>)?.['data']?.[0];
    return d ? parseOrder(d as Record<string, unknown>) : null;
  }
}
