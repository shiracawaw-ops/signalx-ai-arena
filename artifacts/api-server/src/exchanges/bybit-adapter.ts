// ─── Bybit REST Adapter (Unified v5) ─────────────────────────────────────────
import { hmacSHA256, safeFetch, stubSymbolRules, toUsdtPair } from './base-adapter.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE         = 'https://api.bybit.com';
const TESTNET_BASE = 'https://api-testnet.bybit.com';
const RECV_WIN     = 5000;

function sign(apiKey: string, secret: string, ts: number, body: string): string {
  return hmacSHA256(secret, `${ts}${apiKey}${RECV_WIN}${body}`);
}

function headers(creds: ExchangeCredentials, ts: number, sig: string) {
  return {
    'X-BAPI-API-KEY':     creds.apiKey,
    'X-BAPI-TIMESTAMP':   String(ts),
    'X-BAPI-SIGN':        sig,
    'X-BAPI-RECV-WINDOW': String(RECV_WIN),
    'Content-Type':       'application/json',
  };
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'Filled':          return 'filled';
    case 'Cancelled':       return 'canceled';
    case 'Rejected':        return 'rejected';
    case 'PartiallyFilled': return 'partial';
    default:                return 'open';
  }
}

function parseOrder(o: Record<string, unknown>): OrderResult {
  return {
    orderId:     String(o['orderId'] ?? ''),
    clientId:    String(o['orderLinkId'] ?? ''),
    symbol:      String(o['symbol'] ?? ''),
    side:        String(o['side'] ?? '').toLowerCase() as 'buy' | 'sell',
    type:        String(o['orderType'] ?? '').toLowerCase() as 'market' | 'limit',
    status:      mapStatus(String(o['orderStatus'] ?? '')),
    quantity:    parseFloat(String(o['qty'] ?? '0')),
    filledQty:   parseFloat(String(o['cumExecQty'] ?? '0')),
    price:       parseFloat(String(o['price'] ?? '0')),
    avgPrice:    parseFloat(String(o['avgPrice'] ?? '0')),
    fee:         parseFloat(String(o['cumExecFee'] ?? '0')),
    feeCurrency: String(o['feeCurrency'] ?? 'USDT'),
    timestamp:   parseInt(String(o['createdTime'] ?? Date.now())),
    exchange:    'bybit',
    raw: o,
  };
}

export class BybitAdapter implements ExchangeAdapter {
  readonly id   = 'bybit';
  readonly name = 'Bybit';

  normalizeSymbol(symbol: string): string { return toUsdtPair(symbol); }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/v5/market/time`, {}, 'bybit');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const ts  = Date.now();
    const sig = sign(creds.apiKey, creds.secretKey, ts, '');
    const r   = await safeFetch(`${BASE}/v5/user/query-api`, {
      headers: headers(creds, ts, sig),
    }, 'bybit');
    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };
    const d    = (r.data as Record<string, Record<string, unknown>>)?.['result'] ?? {};
    const perms = (d['permissions'] as Record<string, string[]>) ?? {};
    return {
      success: true,
      permissions: {
        read:     true,
        trade:    !!(perms['Spot']?.length || perms['Trade']?.length),
        withdraw: !!(perms['Withdraw']?.length),
        futures:  !!(perms['Derivatives']?.length || perms['ContractTrade']?.length),
      },
    };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    return (await this.validateCredentials(creds)).permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const ts   = Date.now();
    const body = ''; // GET request, no body
    const sig  = sign(creds.apiKey, creds.secretKey, ts, 'accountType=UNIFIED');
    const r    = await safeFetch(`${BASE}/v5/account/wallet-balance?accountType=UNIFIED`, {
      headers: headers(creds, ts, sig),
    }, 'bybit');
    if (!r.ok) throw new Error(r.error?.message);
    const coins = ((r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list']?.[0] as Record<string, unknown[]>)?.['coin'] ?? [];
    return (coins as Array<Record<string, unknown>>)
      .filter(c => parseFloat(String(c['walletBalance'] ?? '0')) > 0)
      .map(c => ({
        asset:     String(c['coin'] ?? ''),
        available: parseFloat(String(c['availableToWithdraw'] ?? '0')),
        hold:      parseFloat(String(c['locked'] ?? '0')),
        total:     parseFloat(String(c['walletBalance'] ?? '0')),
      }));
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${BASE}/v5/market/instruments-info?category=spot&symbol=${sym}`, {}, 'bybit');
    if (!r.ok) return stubSymbolRules(sym);
    const info = ((r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list']?.[0] ?? {}) as Record<string, Record<string, string>>;
    const lot  = info['lotSizeFilter'] ?? {};
    const price = info['priceFilter'] ?? {};
    return {
      symbol, baseCurrency: String(info['baseCoin'] ?? ''), quoteCurrency: String(info['quoteCoin'] ?? 'USDT'),
      minQty:      parseFloat(lot['minOrderQty'] ?? '0.00001'),
      maxQty:      parseFloat(lot['maxOrderQty'] ?? '9000000'),
      stepSize:    parseFloat(lot['basePrecision'] ?? '0.00001'),
      minNotional: parseFloat(lot['minOrderAmt'] ?? '1'),
      tickSize:    parseFloat(price['tickSize'] ?? '0.01'),
      maxLeverage: 1,
    };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const base = order.testnet ? TESTNET_BASE : BASE;
    const sym  = this.normalizeSymbol(order.symbol);
    const body = JSON.stringify({
      category: 'spot', symbol: sym,
      side:      order.side.charAt(0).toUpperCase() + order.side.slice(1),
      orderType: order.type === 'limit' ? 'Limit' : 'Market',
      qty:       String(order.quantity),
      ...(order.type === 'limit' && order.price ? { price: String(order.price) } : {}),
      ...(order.clientId ? { orderLinkId: order.clientId } : {}),
    });
    const ts  = Date.now();
    const sig = sign(creds.apiKey, creds.secretKey, ts, body);
    const r   = await safeFetch(`${base}/v5/order/create`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'bybit');
    if (!r.ok) throw new Error(`Bybit order failed: ${r.error?.message}`);
    const d = (r.data as Record<string, Record<string, unknown>>)?.['result'] ?? {};
    return { orderId: String(d['orderId'] ?? ''), clientId: String(d['orderLinkId'] ?? ''), symbol: sym, side: order.side, type: order.type, status: 'open', quantity: order.quantity, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USDT', timestamp: Date.now(), exchange: 'bybit', raw: d };
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/v5/market/tickers?category=spot&symbol=${sym}`, {}, 'bybit');
    if (!r.ok) throw new Error(`Bybit getPrice failed: ${r.error?.message}`);
    const list = (r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list'] ?? [];
    const item = (list[0] ?? {}) as Record<string, string>;
    return parseFloat(item['lastPrice'] ?? '0');
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean> {
    if (!symbol) return false;
    const body = JSON.stringify({ category: 'spot', symbol: this.normalizeSymbol(symbol), orderId });
    const ts   = Date.now();
    const sig  = sign(creds.apiKey, creds.secretKey, ts, body);
    const r    = await safeFetch(`${BASE}/v5/order/cancel`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'bybit');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym = symbol ? this.normalizeSymbol(symbol) : '';
    const qs  = `category=spot${sym ? `&symbol=${sym}` : ''}&limit=${limit}`;
    const ts  = Date.now();
    const sig = sign(creds.apiKey, creds.secretKey, ts, qs);
    const r   = await safeFetch(`${BASE}/v5/order/history?${qs}`, { headers: headers(creds, ts, sig) }, 'bybit');
    if (!r.ok) return [];
    return (((r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list']) ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null> {
    if (!symbol) return null;
    const sym = this.normalizeSymbol(symbol);
    const qs  = `category=spot&symbol=${sym}&orderId=${orderId}`;
    const ts  = Date.now();
    const sig = sign(creds.apiKey, creds.secretKey, ts, qs);
    const r   = await safeFetch(`${BASE}/v5/order/history?${qs}`, { headers: headers(creds, ts, sig) }, 'bybit');
    if (!r.ok) return null;
    const list = (r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list'] ?? [];
    const o    = list[0];
    return o ? parseOrder(o as Record<string, unknown>) : null;
  }
}
