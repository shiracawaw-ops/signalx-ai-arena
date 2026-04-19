// ─── Bybit REST Adapter (Unified v5) ─────────────────────────────────────────
import { hmacSHA256, safeFetch, stubSymbolRules, toUsdtPair } from './base-adapter.js';
import { ExchangeOperationError, withUsdtValue } from './exchange-error.js';
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
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const ts  = Date.now();
    const sig = sign(creds.apiKey, creds.secretKey, ts, '');
    const r   = await safeFetch(`${base}/v5/user/query-api`, {
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
    // Bybit accounts may be Unified, Spot-only, or Contract-only depending on
    // whether the user migrated to Unified Margin. Try each in order and
    // merge the non-empty results so we don't show an empty balance pane to
    // a user whose funds happen to live in Spot or Contract.
    const base       = creds.testnet ? TESTNET_BASE : BASE;
    const accountTypes = ['UNIFIED', 'SPOT', 'CONTRACT'] as const;

    const merged: Map<string, Balance> = new Map();
    let lastError: { code: 'auth' | 'rate_limit' | 'permission' | 'network' | 'account_type' | 'unknown'; message: string; status?: number } | null = null;

    for (const accountType of accountTypes) {
      const ts  = Date.now();
      const qs  = `accountType=${accountType}`;
      const sig = sign(creds.apiKey, creds.secretKey, ts, qs);
      const r   = await safeFetch(`${base}/v5/account/wallet-balance?${qs}`, {
        headers: headers(creds, ts, sig),
      }, 'bybit');

      if (!r.ok) {
        const status = r.status;
        const msg    = r.error?.message ?? `Bybit balance fetch failed (${accountType})`;
        const lc     = msg.toLowerCase();
        // Wrong-account-type response — keep trying other types.
        if (status === 422 || lc.includes('accounttype') || lc.includes('account type')) {
          lastError = { code: 'account_type', message: msg, status };
          continue;
        }
        if (status === 401 || lc.includes('signature') || lc.includes('apikey') || lc.includes('api key') || lc.includes('invalid')) {
          throw new ExchangeOperationError('auth', `Bybit rejected the API key: ${msg}`, 401);
        }
        if (status === 403 || lc.includes('permission') || lc.includes('not allowed')) {
          throw new ExchangeOperationError('permission', `Bybit API key lacks permission: ${msg}`, 403);
        }
        if (status === 429 || lc.includes('rate')) {
          throw new ExchangeOperationError('rate_limit', `Bybit rate limit hit: ${msg}`, 429);
        }
        if (status === 0 || lc.includes('timeout') || lc.includes('network')) {
          throw new ExchangeOperationError('network', `Bybit unreachable: ${msg}`);
        }
        // Other classes of failure — remember and keep trying remaining types.
        lastError = { code: 'unknown', message: msg, status };
        continue;
      }

      // Bybit v5 also signals errors via retCode != 0 on a 200 response.
      const retCode = (r.data as Record<string, unknown>)?.['retCode'];
      const retMsg  = String((r.data as Record<string, unknown>)?.['retMsg'] ?? '');
      if (typeof retCode === 'number' && retCode !== 0) {
        const lcMsg = retMsg.toLowerCase();
        if (lcMsg.includes('accounttype') || lcMsg.includes('account type')) {
          lastError = { code: 'account_type', message: retMsg };
          continue;
        }
        if (retCode === 10003 || retCode === 10004 || lcMsg.includes('signature') || lcMsg.includes('api key')) {
          throw new ExchangeOperationError('auth', `Bybit auth error (retCode ${retCode}): ${retMsg}`, 401);
        }
        if (retCode === 10005 || lcMsg.includes('permission')) {
          throw new ExchangeOperationError('permission', `Bybit permission denied (retCode ${retCode}): ${retMsg}`, 403);
        }
        if (retCode === 10006 || lcMsg.includes('rate limit')) {
          throw new ExchangeOperationError('rate_limit', `Bybit rate limit (retCode ${retCode}): ${retMsg}`, 429);
        }
        lastError = { code: 'unknown', message: `retCode ${retCode}: ${retMsg}` };
        continue;
      }

      const rawList = (r.data as Record<string, Record<string, unknown>>)?.['result']?.['list'];
      const list    = Array.isArray(rawList) ? rawList : [];
      const first   = (list[0] ?? {}) as Record<string, unknown>;
      const coinsRaw = first['coin'];
      const coins    = Array.isArray(coinsRaw) ? coinsRaw as Array<Record<string, unknown>> : [];

      for (const c of coins) {
        const asset = String(c['coin'] ?? '');
        if (!asset) continue;
        const total     = parseFloat(String(c['walletBalance'] ?? '0'));
        if (!Number.isFinite(total) || total <= 0) continue;
        const available = parseFloat(String(c['availableToWithdraw'] ?? c['free'] ?? '0'));
        const hold      = parseFloat(String(c['locked'] ?? '0'));
        // Merge across account types — sum same-asset balances.
        const prev = merged.get(asset);
        if (prev) {
          merged.set(asset, {
            asset,
            available: prev.available + (Number.isFinite(available) ? available : 0),
            hold:      prev.hold      + (Number.isFinite(hold)      ? hold      : 0),
            total:     prev.total     + total,
          });
        } else {
          merged.set(asset, {
            asset,
            available: Number.isFinite(available) ? available : 0,
            hold:      Number.isFinite(hold)      ? hold      : 0,
            total,
          });
        }
      }
    }

    if (merged.size === 0 && lastError && lastError.code !== 'account_type') {
      // All account types failed for the same non-account-type reason.
      throw new ExchangeOperationError(lastError.code, lastError.message, lastError.status);
    }

    return [...merged.values()].map(withUsdtValue);
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const base = _creds.testnet ? TESTNET_BASE : BASE;
    const sym = this.normalizeSymbol(symbol);
    const r   = await safeFetch(`${base}/v5/market/instruments-info?category=spot&symbol=${sym}`, {}, 'bybit');
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
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const body = JSON.stringify({ category: 'spot', symbol: this.normalizeSymbol(symbol), orderId });
    const ts   = Date.now();
    const sig  = sign(creds.apiKey, creds.secretKey, ts, body);
    const r    = await safeFetch(`${base}/v5/order/cancel`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'bybit');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const sym = symbol ? this.normalizeSymbol(symbol) : '';
    const qs  = `category=spot${sym ? `&symbol=${sym}` : ''}&limit=${limit}`;
    const ts  = Date.now();
    const sig = sign(creds.apiKey, creds.secretKey, ts, qs);
    const r   = await safeFetch(`${base}/v5/order/history?${qs}`, { headers: headers(creds, ts, sig) }, 'bybit');
    if (!r.ok) return [];
    return (((r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list']) ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null> {
    if (!symbol) return null;
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const sym = this.normalizeSymbol(symbol);
    const qs  = `category=spot&symbol=${sym}&orderId=${orderId}`;
    const ts  = Date.now();
    const sig = sign(creds.apiKey, creds.secretKey, ts, qs);
    const r   = await safeFetch(`${base}/v5/order/history?${qs}`, { headers: headers(creds, ts, sig) }, 'bybit');
    if (!r.ok) return null;
    const list = (r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list'] ?? [];
    const o    = list[0];
    return o ? parseOrder(o as Record<string, unknown>) : null;
  }
}
