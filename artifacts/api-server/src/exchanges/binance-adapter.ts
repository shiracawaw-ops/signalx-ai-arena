// ─── Binance REST Adapter ─────────────────────────────────────────────────────
import { hmacSHA256, safeFetch, stubBalance, stubPermission, stubOrder, stubSymbolRules, toUsdtPair, maskKey } from './base-adapter.js';
import type { ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission, Balance, SymbolRules, OrderRequest, OrderResult } from './types.js';

const BASE         = 'https://api.binance.com';
const TESTNET_BASE = 'https://testnet.binance.vision';

function sign(secret: string, query: string): string {
  return hmacSHA256(secret, query);
}

function authHeaders(apiKey: string) {
  return { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/json' };
}

function qs(params: Record<string, string | number | boolean>): string {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function signedQs(params: Record<string, string | number | boolean>, secret: string): string {
  const q = qs(params);
  return `${q}&signature=${sign(secret, q)}`;
}

function parseOrder(o: Record<string, unknown>, exchange = 'binance'): OrderResult {
  return {
    orderId:     String(o['orderId'] ?? ''),
    clientId:    String(o['clientOrderId'] ?? ''),
    symbol:      String(o['symbol'] ?? ''),
    side:        String(o['side'] ?? '').toLowerCase() as 'buy' | 'sell',
    type:        String(o['type'] ?? '').toLowerCase() as 'market' | 'limit',
    status:      mapStatus(String(o['status'] ?? '')),
    quantity:    parseFloat(String(o['origQty'] ?? '0')),
    filledQty:   parseFloat(String(o['executedQty'] ?? '0')),
    price:       parseFloat(String(o['price'] ?? '0')),
    avgPrice:    parseFloat(String(o['avgPrice'] ?? o['price'] ?? '0')),
    fee:         0,
    feeCurrency: 'USDT',
    timestamp:   Number(o['time'] ?? o['transactTime'] ?? Date.now()),
    exchange,
    raw: o,
  };
}

function mapStatus(s: string): OrderResult['status'] {
  switch (s) {
    case 'FILLED':            return 'filled';
    case 'CANCELED':          return 'canceled';
    case 'REJECTED':          return 'rejected';
    case 'PARTIALLY_FILLED':  return 'partial';
    default:                  return 'open';
  }
}

export class BinanceAdapter implements ExchangeAdapter {
  readonly id   = 'binance';
  readonly name = 'Binance';

  normalizeSymbol(symbol: string): string {
    return toUsdtPair(symbol);
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await safeFetch(`${BASE}/api/v3/ping`, {}, 'binance');
    return Date.now() - t;
  }

  async validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult> {
    const params = { timestamp: Date.now() };
    const q = signedQs(params, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/account?${q}`, {
      headers: authHeaders(creds.apiKey),
    }, 'binance');

    if (!r.ok) return { success: false, permissions: { read: false, trade: false, withdraw: false, futures: false }, error: r.error?.message };

    const d = r.data as Record<string, unknown>;
    const perms = (d['permissions'] as string[] | undefined) ?? [];
    return {
      success: true,
      permissions: {
        read:     true,
        trade:    perms.includes('SPOT') || perms.includes('TRADE'),
        withdraw: false,
        futures:  perms.includes('FUTURES') || perms.includes('LEVERAGED'),
      },
      uid: String(d['uid'] ?? ''),
    };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    const r = await this.validateCredentials(creds);
    return r.permissions;
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const q = signedQs({ timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/account?${q}`, {
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    if (!r.ok) throw new Error(r.error?.message ?? 'Balance fetch failed');
    const d   = r.data as Record<string, unknown>;
    const raw = (d['balances'] as Array<Record<string, string>>) ?? [];
    return raw
      .filter(b => parseFloat(b['free'] ?? '0') + parseFloat(b['locked'] ?? '0') > 0)
      .map(b => ({
        asset:     b['asset'] ?? '',
        available: parseFloat(b['free'] ?? '0'),
        hold:      parseFloat(b['locked'] ?? '0'),
        total:     parseFloat(b['free'] ?? '0') + parseFloat(b['locked'] ?? '0'),
      }));
  }

  async getSymbolRules(creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/api/v3/exchangeInfo?symbol=${sym}`, {}, 'binance');
    if (!r.ok) return stubSymbolRules(sym);
    const d = r.data as Record<string, unknown>;
    const symbols = (d['symbols'] as Array<Record<string, unknown>>) ?? [];
    const info = symbols.find(s => s['symbol'] === sym);
    if (!info) return stubSymbolRules(sym);
    const filters = (info['filters'] as Array<Record<string, string>>) ?? [];
    const lotFilter  = filters.find(f => f['filterType'] === 'LOT_SIZE') ?? {};
    const notional   = filters.find(f => f['filterType'] === 'MIN_NOTIONAL' || f['filterType'] === 'NOTIONAL') ?? {};
    const priceFilter = filters.find(f => f['filterType'] === 'PRICE_FILTER') ?? {};
    return {
      symbol:        sym,
      baseCurrency:  String(info['baseAsset'] ?? ''),
      quoteCurrency: String(info['quoteAsset'] ?? ''),
      minQty:        parseFloat(String(lotFilter['minQty'] ?? '0.00001')),
      maxQty:        parseFloat(String(lotFilter['maxQty'] ?? '9000000')),
      stepSize:      parseFloat(String(lotFilter['stepSize'] ?? '0.00001')),
      minNotional:   parseFloat(String(notional['minNotional'] ?? notional['notional'] ?? '1')),
      tickSize:      parseFloat(String(priceFilter['tickSize'] ?? '0.01')),
      maxLeverage:   1,
    };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const base = order.testnet ? TESTNET_BASE : BASE;
    const sym = this.normalizeSymbol(order.symbol);
    const params: Record<string, string | number> = {
      symbol:    sym,
      side:      order.side.toUpperCase(),
      type:      order.type.toUpperCase(),
      quantity:  order.quantity,
      timestamp: Date.now(),
    };
    if (order.type === 'limit' && order.price) {
      params['timeInForce'] = 'GTC';
      params['price']       = order.price;
    }
    if (order.clientId) params['newClientOrderId'] = order.clientId;

    const q = signedQs(params, creds.secretKey);
    const r = await safeFetch(`${base}/api/v3/order?${q}`, {
      method: 'POST',
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    if (!r.ok) throw new Error(`Binance order failed: ${r.error?.message}`);
    return parseOrder(r.data as Record<string, unknown>);
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/api/v3/ticker/price?symbol=${sym}`, {}, 'binance');
    if (!r.ok) throw new Error(`Binance getPrice failed: ${r.error?.message}`);
    return parseFloat(String((r.data as Record<string, string>)['price'] ?? '0'));
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean> {
    if (!symbol) return false;
    const sym = this.normalizeSymbol(symbol);
    const q = signedQs({ symbol: sym, orderId, timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/order?${q}`, {
      method: 'DELETE',
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const sym = symbol ? this.normalizeSymbol(symbol) : 'BTCUSDT';
    const q = signedQs({ symbol: sym, limit, timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/allOrders?${q}`, {
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    if (!r.ok) return [];
    return ((r.data as unknown[]) ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null> {
    if (!symbol) return null;
    const sym = this.normalizeSymbol(symbol);
    const q = signedQs({ symbol: sym, orderId, timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${BASE}/api/v3/order?${q}`, {
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    if (!r.ok) return null;
    return parseOrder(r.data as Record<string, unknown>);
  }
}
