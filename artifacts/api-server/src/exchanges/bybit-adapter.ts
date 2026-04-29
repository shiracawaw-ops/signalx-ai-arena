// ─── Bybit REST Adapter (Unified v5) ─────────────────────────────────────────
import { hmacSHA256, safeFetch, stubSymbolRules, toUsdtPair } from './base-adapter.js';
import { ExchangeOperationError, withUsdtValue, enrichBalancesWithUsdtValue } from './exchange-error.js';
import type {
  ExchangeAdapter,
  ExchangeCredentials,
  ConnectResult,
  Permission,
  Balance,
  BalanceScope,
  BalanceSummary,
  SymbolRules,
  OrderRequest,
  OrderResult,
  DustSweepResult,
  CandleSnapshot,
  MarketSnapshot,
} from './types.js';

const BASE         = 'https://api.bybit.com';
const TESTNET_BASE = 'https://api-testnet.bybit.com';
const RECV_WIN     = 5000;

// Symbol-rules cache — parity with binance-adapter (5 min TTL).
const BYBIT_RULES_TTL_MS = 5 * 60 * 1000;
const bybitRulesCache = new Map<string, { rules: SymbolRules; ts: number }>();
export function _resetBybitRulesCache(): void { bybitRulesCache.clear(); }

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
    return (await this.getBalanceBreakdown(creds)).balances;
  }

  async getBalanceBreakdown(creds: ExchangeCredentials): Promise<{ balances: Balance[]; summary: BalanceSummary }> {
    // Bybit accounts may be Unified, Spot-only, or Contract-only depending on
    // whether the user migrated to Unified Margin. Try each in order, capture
    // per-scope subtotals AND the exchange-reported `totalEquity` so the UI
    // can show the same number the user sees inside the Bybit app.
    const base       = creds.testnet ? TESTNET_BASE : BASE;
    const accountTypes = ['UNIFIED', 'SPOT', 'CONTRACT'] as const;

    const merged: Map<string, Balance> = new Map();
    const scopes:  BalanceScope[] = [];
    const notes:   string[] = [];
    const exchangeReported = { totalEquityUSD: 0, totalWalletUSD: 0, totalAvailableUSD: 0 };
    let   anyExchangeReported = false;
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

      // ── Successful response — capture scope-level + per-coin numbers ─────
      const rawList = (r.data as Record<string, Record<string, unknown>>)?.['result']?.['list'];
      const list    = Array.isArray(rawList) ? rawList : [];
      const first   = (list[0] ?? {}) as Record<string, unknown>;
      const coinsRaw = first['coin'];
      const coins    = Array.isArray(coinsRaw) ? coinsRaw as Array<Record<string, unknown>> : [];

      const pickNum = (...vals: unknown[]): number => {
        for (const v of vals) {
          const s = String(v ?? '').trim();
          if (!s) continue;
          const n = parseFloat(s);
          if (Number.isFinite(n)) return n;
        }
        return 0;
      };
      const pickPos = (...vals: unknown[]): number => {
        const n = pickNum(...vals);
        return n > 0 ? n : 0;
      };

      // Exchange-reported scope totals (Unified shows the same number the
      // user sees inside the Bybit app under "Total Equity").
      const scopeTotalEquityUSD    = pickNum(first['totalEquity'],          first['accountTotalEquity']);
      const scopeWalletBalanceUSD  = pickNum(first['totalWalletBalance']);
      const scopeAvailableUSD      = pickNum(first['totalAvailableBalance'], first['totalMarginBalance']);
      const scopeLockedUSD         = pickPos(first['totalInitialMargin'],   first['totalMaintenanceMargin']);
      if (scopeTotalEquityUSD > 0) {
        anyExchangeReported = true;
        exchangeReported.totalEquityUSD    += scopeTotalEquityUSD;
        exchangeReported.totalWalletUSD    += scopeWalletBalanceUSD;
        exchangeReported.totalAvailableUSD += scopeAvailableUSD;
      }

      let scopeCoinCount = 0;
      for (const c of coins) {
        const asset = String(c['coin'] ?? '');
        if (!asset) continue;

        // Use `equity` (includes UPL/collateral value) when it exceeds raw
        // walletBalance — this captures Unified-account collateral that's
        // currently backing positions.
        const wallet  = pickPos(c['walletBalance']);
        const equity  = pickPos(c['equity']);
        const total   = Math.max(wallet, equity);
        if (total <= 0) continue;

        const hold      = pickPos(c['locked'], c['totalOrderIM'], c['totalPositionIM']);
        const available = pickPos(c['availableToWithdraw'], c['free'],
                                  total - hold > 0 ? total - hold : 0,
                                  total);

        // Bybit gives us an authoritative USD valuation per coin. Use it
        // verbatim — this is how `163.61 USD` is computed on the exchange
        // side and avoids the price-lookup hole that drops USDC etc.
        const usdValue = pickPos(c['usdValue']);

        const prev = merged.get(asset);
        if (prev) {
          const newUsd = (prev.usdtValue ?? 0) + usdValue;
          merged.set(asset, {
            asset,
            available: prev.available + available,
            hold:      prev.hold      + hold,
            total:     prev.total     + total,
            ...(usdValue > 0 || prev.usdtValue !== undefined ? { usdtValue: newUsd } : {}),
            scope:     prev.scope ? `${prev.scope}+${accountType}` : accountType,
          });
        } else {
          merged.set(asset, {
            asset, available, hold, total,
            ...(usdValue > 0 ? { usdtValue: usdValue } : {}),
            scope: accountType,
          });
        }
        scopeCoinCount += 1;
      }

      scopes.push({
        accountType,
        fetched: true,
        ...(scopeTotalEquityUSD   > 0 ? { totalEquityUSD:   scopeTotalEquityUSD }   : {}),
        ...(scopeWalletBalanceUSD > 0 ? { walletBalanceUSD: scopeWalletBalanceUSD } : {}),
        ...(scopeAvailableUSD     > 0 ? { availableUSD:     scopeAvailableUSD }     : {}),
        ...(scopeLockedUSD        > 0 ? { lockedUSD:        scopeLockedUSD }        : {}),
        coinCount: scopeCoinCount,
      });
    }

    // Record account-types that errored out so the UI can surface them too.
    for (const at of accountTypes) {
      if (!scopes.find(s => s.accountType === at)) {
        scopes.push({
          accountType: at,
          fetched: false,
          error: lastError?.message ?? 'Account type not active for this user',
        });
      }
    }

    // ── Funding wallet (FUND) ────────────────────────────────────────────
    // Fresh deposits on Bybit land in the **Funding** account first; users
    // must explicitly transfer to UNIFIED/SPOT/CONTRACT before they appear
    // in the wallet-balance endpoint. We surface FUND coins here so a user
    // who just deposited sees their balance immediately.
    let fundingUSD = 0;
    let fundingCoinCount = 0;
    let fundingFetched = false;
    let fundingError: string | undefined;
    try {
      const ts2 = Date.now();
      const qs2 = `accountType=FUND`;
      const sig2 = sign(creds.apiKey, creds.secretKey, ts2, qs2);
      const rf  = await safeFetch(
        `${base}/v5/asset/transfer/query-account-coins-balance?${qs2}`,
        { headers: headers(creds, ts2, sig2) },
        'bybit',
      );
      if (rf.ok) {
        const retCode = (rf.data as Record<string, unknown>)?.['retCode'];
        const retMsg  = String((rf.data as Record<string, unknown>)?.['retMsg'] ?? '');
        if (typeof retCode === 'number' && retCode === 0) {
          fundingFetched = true;
          const fundList = (rf.data as Record<string, Record<string, unknown>>)?.['result']?.['balance'];
          const fundCoins = Array.isArray(fundList) ? fundList as Array<Record<string, unknown>> : [];
          for (const c of fundCoins) {
            const asset = String(c['coin'] ?? '');
            if (!asset) continue;
            const wallet   = parseFloat(String(c['walletBalance']    ?? '0'));
            const transfer = parseFloat(String(c['transferBalance']  ?? '0'));
            const total    = Number.isFinite(wallet) && wallet > 0 ? wallet : transfer;
            if (!Number.isFinite(total) || total <= 0) continue;
            const available = Number.isFinite(transfer) && transfer > 0 ? transfer : total;
            // FUND endpoint doesn't return usdValue; estimate via the public
            // ticker so the breakdown doesn't show "—" for fresh deposits.
            let usd = 0;
            try { usd = total * (await this.getPrice(asset)); } catch { /* best-effort */ }
            if (Number.isFinite(usd) && usd > 0) fundingUSD += usd;

            const prev = merged.get(asset);
            if (prev) {
              merged.set(asset, {
                asset,
                available: prev.available + available,
                hold:      prev.hold,
                total:     prev.total + total,
                ...(usd > 0 || prev.usdtValue !== undefined ? { usdtValue: (prev.usdtValue ?? 0) + usd } : {}),
                scope:     prev.scope ? `${prev.scope}+FUND` : 'FUND',
              });
            } else {
              merged.set(asset, {
                asset, available, hold: 0, total,
                ...(usd > 0 ? { usdtValue: usd } : {}),
                scope: 'FUND',
              });
            }
            fundingCoinCount += 1;
          }
        } else {
          fundingError = `retCode ${retCode}: ${retMsg}`;
        }
      } else {
        fundingError = rf.error?.message ?? 'Funding wallet fetch failed';
      }
    } catch (e) {
      fundingError = (e as Error).message;
    }
    scopes.push({
      accountType: 'FUND',
      fetched: fundingFetched,
      ...(fundingUSD > 0     ? { walletBalanceUSD: fundingUSD, availableUSD: fundingUSD, totalEquityUSD: fundingUSD } : {}),
      ...(fundingError       ? { error: fundingError } : {}),
      coinCount: fundingCoinCount,
      ...(fundingFetched && fundingUSD > 0
        ? { note: 'Funds in the Funding wallet are NOT tradable from the app — transfer them to your Unified/Spot account inside Bybit first.' }
        : {}),
    });
    if (fundingUSD > 0) {
      notes.push(`$${fundingUSD.toFixed(2)} sits in your Bybit Funding wallet. Transfer it to Unified/Spot inside Bybit to use it for trading.`);
    }
    if (!fundingFetched && fundingError) {
      notes.push(`Funding wallet check failed: ${fundingError}. If you expect a Funding balance, your API key likely needs the "Wallet" (Asset) read permission.`);
    }

    // ── Bybit Earn / Savings / Staking / Copy Trading ────────────────────
    // Funds parked in Earn products do NOT appear in wallet-balance — Bybit
    // exposes them via /v5/asset/exchange/query-coin-list and the Earn
    // position endpoints. Probe a few common categories so the user sees
    // why their on-app total differs from what's tradable.
    const externalBreakdown: Array<{ source: string; usd: number; coinCount: number; note?: string }> = [];
    let externalUSD = 0;
    type EarnProbe = { label: string; category: string; note: string };
    const earnProbes: EarnProbe[] = [
      { label: 'Earn · Flexible Savings', category: 'FlexibleSaving',
        note: 'Funds in Flexible Savings — redeem inside Bybit before they can be traded.' },
      { label: 'Earn · On-Chain Earn',    category: 'OnChain',
        note: 'On-Chain Earn principal — redeem inside Bybit to free for trading.' },
      { label: 'Earn · Fixed-term',       category: 'FixedTerm',
        note: 'Fixed-term Earn — locked until maturity.' },
    ];
    for (const probe of earnProbes) {
      try {
        const ts3 = Date.now();
        const qs3 = `category=${probe.category}`;
        const sig3 = sign(creds.apiKey, creds.secretKey, ts3, qs3);
        const re = await safeFetch(
          `${base}/v5/earn/position?${qs3}`,
          { headers: headers(creds, ts3, sig3) },
          'bybit',
        );
        if (!re.ok) continue;
        const retCode = (re.data as Record<string, unknown>)?.['retCode'];
        if (typeof retCode === 'number' && retCode !== 0) continue;
        const arr = (re.data as Record<string, Record<string, unknown>>)?.['result']?.['list'];
        const positions = Array.isArray(arr) ? arr as Array<Record<string, unknown>> : [];
        let usd = 0;
        let coinCount = 0;
        for (const p of positions) {
          const asset = String(p['coin'] ?? '');
          if (!asset) continue;
          const amt = parseFloat(String(p['amount'] ?? p['principalAmount'] ?? p['stakedAmount'] ?? '0'));
          if (!Number.isFinite(amt) || amt <= 0) continue;
          let px = 0;
          try { px = await this.getPrice(asset); } catch { /* best-effort */ }
          if (Number.isFinite(px) && px > 0) usd += amt * px;
          coinCount += 1;
        }
        if (usd > 0 || coinCount > 0) {
          externalBreakdown.push({ source: probe.label, usd, coinCount, note: probe.note });
          externalUSD += usd;
        }
      } catch { /* probe failed silently — Earn product simply not used */ }
    }
    if (externalUSD > 0) {
      notes.push(
        `$${externalUSD.toFixed(2)} is parked in Bybit Earn products (Savings/Staking/etc.) — ` +
        `redeem them inside Bybit first to make them tradable from this app.`,
      );
    }

    if (merged.size === 0 && lastError && lastError.code !== 'account_type') {
      // All account types failed for the same non-account-type reason.
      throw new ExchangeOperationError(lastError.code, lastError.message, lastError.status);
    }

    // For any coin that ended up without a usdtValue (e.g. CONTRACT/SPOT
    // where the API doesn't return usdValue), backfill via the public
    // ticker so the displayed total matches the exchange.
    let balances = [...merged.values()].map(b =>
      b.usdtValue !== undefined ? b : withUsdtValue(b),
    );
    balances = await enrichBalancesWithUsdtValue(this.id, balances, sym => this.getPrice(sym));

    // Compute aggregate summary numbers from the per-coin breakdown.
    const tradingUSD = balances
      .filter(b => b.scope && b.scope !== 'FUND')
      .reduce((s, b) => s + (b.usdtValue ?? 0), 0);
    const summedTotalUSD = balances.reduce((s, b) => s + (b.usdtValue ?? 0), 0);
    const summedAvailableUSD = balances
      .reduce((s, b) => {
        const ratio = b.total > 0 ? b.available / b.total : 0;
        return s + ratio * (b.usdtValue ?? 0);
      }, 0);
    const summedLockedUSD = Math.max(0, summedTotalUSD - summedAvailableUSD);

    // Prefer Bybit's own totalEquity (matches the in-app number) when
    // available — fall back to our per-coin sum. Always add Funding + Earn
    // since those are NOT included in Bybit's wallet-balance totalEquity.
    const totalEquityUSD = (anyExchangeReported && exchangeReported.totalEquityUSD > 0
      ? exchangeReported.totalEquityUSD
      : summedTotalUSD) + fundingUSD + externalUSD;

    if (anyExchangeReported && Math.abs(exchangeReported.totalEquityUSD - tradingUSD) > 0.5) {
      notes.push(
        `Bybit-reported total equity (trading accounts): $${exchangeReported.totalEquityUSD.toFixed(2)} · ` +
        `app per-coin sum: $${tradingUSD.toFixed(2)}. ` +
        `Differences usually mean unrealised PnL or assets without an active USDT pair.`,
      );
    }

    const summary: BalanceSummary = {
      totalEquityUSD,
      totalWalletUSD:    (anyExchangeReported ? exchangeReported.totalWalletUSD : summedTotalUSD) + fundingUSD,
      totalAvailableUSD: (anyExchangeReported && exchangeReported.totalAvailableUSD > 0
                          ? exchangeReported.totalAvailableUSD
                          : summedAvailableUSD),
      totalLockedUSD:    summedLockedUSD,
      fundingUSD,
      tradingUSD,
      ...(externalUSD > 0 ? { externalUSD } : {}),
      ...(externalBreakdown.length > 0 ? { externalBreakdown } : {}),
      scopes,
      notes,
      ...(anyExchangeReported ? { exchangeReported } : {}),
    };

    return { balances, summary };
  }

  async getSymbolRules(_creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const base = _creds.testnet ? TESTNET_BASE : BASE;
    const sym  = this.normalizeSymbol(symbol);

    // 5-minute TTL cache to match the Binance adapter — instrument info
    // changes rarely and every uncached call adds 200-400ms to the order
    // path. Cache key includes testnet flag so prod and sandbox don't mix.
    const cacheKey = `${_creds.testnet ? 't' : 'p'}:${sym}`;
    const now = Date.now();
    const hit = bybitRulesCache.get(cacheKey);
    if (hit && now - hit.ts < BYBIT_RULES_TTL_MS) return hit.rules;

    const r = await safeFetch(`${base}/v5/market/instruments-info?category=spot&symbol=${sym}`, {}, 'bybit');
    if (!r.ok) return stubSymbolRules(sym);
    const info = ((r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list']?.[0] ?? {}) as Record<string, Record<string, string> | string>;
    const lot   = (info['lotSizeFilter']  as Record<string, string>) ?? {};
    const price = (info['priceFilter']    as Record<string, string>) ?? {};
    // Bybit instrument states: "Trading", "PreLaunch", "Settling", "Delivering",
    // "Closed". Anything other than "Trading" must block submission.
    const status     = String(info['status'] ?? 'Trading');
    const innovation = String(info['innovation'] ?? '0');
    const rules: SymbolRules = {
      symbol, baseCurrency: String(info['baseCoin'] ?? ''), quoteCurrency: String(info['quoteCoin'] ?? 'USDT'),
      minQty:      parseFloat(lot['minOrderQty'] ?? '0.00001'),
      maxQty:      parseFloat(lot['maxOrderQty'] ?? '9000000'),
      stepSize:    parseFloat(lot['basePrecision'] ?? '0.00001'),
      minNotional: parseFloat(lot['minOrderAmt'] ?? '1'),
      tickSize:    parseFloat(price['tickSize'] ?? '0.01'),
      maxLeverage: 1,
      status,
      isSpotTradingAllowed: status === 'Trading',
      filterSource: 'bybit:instruments-info',
      // Innovation zone tokens often have stricter listing rules; surface it
      // so the client can decide whether to allow them by policy.
      isInnovation: innovation === '1',
    };
    bybitRulesCache.set(cacheKey, { rules, ts: now });
    return rules;
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const base = order.testnet ? TESTNET_BASE : BASE;
    const sym  = this.normalizeSymbol(order.symbol);

    // ── Local preflight (parity with binance-adapter) ────────────────────────
    // Validate qty / status against cached instrument-info BEFORE we burn a
    // signed network call. Catches: trading=halted, qty < minQty, qty > maxQty,
    // qty * price < minNotional. We still let the live-price bumper below
    // adjust qty for market BUYs (so this just ensures we have *some* viable
    // qty to start from).
    const rules = await this.getSymbolRules(creds, order.symbol);
    if (rules.status && rules.status !== 'Trading') {
      throw new ExchangeOperationError(
        'unknown', `Symbol ${sym} is not currently tradable on Bybit (status=${rules.status}).`, 422,
      );
    }
    if (rules.minQty > 0 && order.quantity < rules.minQty) {
      throw new ExchangeOperationError(
        'unknown', `Order qty ${order.quantity} < minOrderQty ${rules.minQty} for ${sym}.`, 422,
      );
    }
    if (rules.maxQty > 0 && order.quantity > rules.maxQty) {
      throw new ExchangeOperationError(
        'unknown', `Order qty ${order.quantity} > maxOrderQty ${rules.maxQty} for ${sym}.`, 422,
      );
    }

    // Bybit Spot quirk: for Market orders, `qty` defaults to QUOTE currency
    // (USDT) for BUY and BASE currency (BTC) for SELL. We always pass BASE
    // currency in `order.quantity`, so force `marketUnit: 'baseCoin'` to make
    // Bybit interpret qty as BTC for both sides. Without this, a BUY of
    // 0.000133 BTC gets read as 0.000133 USDT and Bybit rejects it
    // (retCode=170140 "Order value exceeded lower limit").
    //
    // Anti-170140 hardening for market BUYs: between signal time and order
    // submit, the spot price can drift up by 0.5–2%. Once we step-round qty
    // DOWN, qty × livePrice can fall under minOrderAmt and Bybit rejects.
    // Refetch the live price right before submit and, if needed, bump qty
    // up to the next valid step that satisfies minOrderAmt × 1.02.
    let qty = order.quantity;
    if (order.type === 'market' && order.side === 'buy') {
      try {
        const livePrice = await this.getPrice(order.symbol);
        if (livePrice > 0 && rules.minNotional > 0) {
          const step    = rules.stepSize > 0 ? rules.stepSize : 0.00001;
          const target  = (rules.minNotional * 1.02) / livePrice;
          if (qty * livePrice < rules.minNotional * 1.02) {
            const bumped = Math.ceil(target / step) * step;
            // Round to step decimal places to avoid float garbage like 0.0001000000001
            const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
            qty = parseFloat(bumped.toFixed(decimals));
            console.log(`[bybit] BUY ${sym}: bumped qty ${order.quantity} → ${qty} to clear minOrderAmt $${rules.minNotional} @ live $${livePrice}`);
          }
        }
      } catch (e) {
        console.warn(`[bybit] live-price preflight failed for ${sym}: ${(e as Error).message}`);
      }
    }

    const body = JSON.stringify({
      category: 'spot', symbol: sym,
      side:      order.side.charAt(0).toUpperCase() + order.side.slice(1),
      orderType: order.type === 'limit' ? 'Limit' : 'Market',
      qty:       String(qty),
      ...(order.type === 'market' ? { marketUnit: 'baseCoin' } : {}),
      ...(order.type === 'limit' && order.price ? { price: String(order.price) } : {}),
      ...(order.clientId ? { orderLinkId: order.clientId } : {}),
    });
    const ts  = Date.now();
    const sig = sign(creds.apiKey, creds.secretKey, ts, body);
    const r   = await safeFetch(`${base}/v5/order/create`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'bybit');
    if (!r.ok) throw new Error(`Bybit order failed: ${r.error?.message}`);
    // Bybit returns HTTP 200 even when the business call fails (e.g.
    // insufficient balance, invalid qty). The real status lives in retCode.
    const payload = (r.data as Record<string, unknown>) ?? {};
    const retCode = Number(payload['retCode'] ?? -1);
    const retMsg  = String(payload['retMsg'] ?? 'unknown error');
    if (retCode !== 0) {
      throw new Error(`Bybit order rejected (retCode=${retCode}): ${retMsg}`);
    }
    const d = (payload['result'] as Record<string, unknown>) ?? {};
    const orderId = String(d['orderId'] ?? '');
    if (!orderId) {
      throw new Error(`Bybit order returned empty orderId: ${retMsg}`);
    }
    return { orderId, clientId: String(d['orderLinkId'] ?? ''), symbol: sym, side: order.side, type: order.type, status: 'open', quantity: qty, filledQty: 0, price: order.price ?? 0, avgPrice: 0, fee: 0, feeCurrency: 'USDT', timestamp: Date.now(), exchange: 'bybit', raw: d };
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/v5/market/tickers?category=spot&symbol=${sym}`, {}, 'bybit');
    if (!r.ok) throw new Error(`Bybit getPrice failed: ${r.error?.message}`);
    const list = (r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list'] ?? [];
    const item = (list[0] ?? {}) as Record<string, string>;
    return parseFloat(item['lastPrice'] ?? '0');
  }

  async getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
    const sym = this.normalizeSymbol(symbol);
    const [price, one, three, five] = await Promise.all([
      this.getPrice(sym),
      this.fetchCandles(sym, '1', 120),
      this.fetchCandles(sym, '3', 120),
      this.fetchCandles(sym, '5', 120),
    ]);
    const spreadPct = estimateSpreadPct(one, price);
    return {
      symbol: sym,
      price,
      timestamp: Date.now(),
      spreadPct,
      candles: {
        '1m': one,
        '3m': three,
        '5m': five,
      },
    };
  }

  private async fetchCandles(symbol: string, interval: '1' | '3' | '5', limit: number): Promise<CandleSnapshot[]> {
    const capped = Math.max(10, Math.min(200, Math.floor(limit)));
    const r = await safeFetch(
      `${BASE}/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${capped}`,
      {},
      'bybit',
    );
    if (!r.ok) return [];
    const list = ((r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list'] ?? []) as Array<Array<string>>;
    const out: CandleSnapshot[] = [];
    for (const row of list) {
      const ts = Number(row[0] ?? 0);
      const open = Number(row[1] ?? 0);
      const high = Number(row[2] ?? 0);
      const low = Number(row[3] ?? 0);
      const close = Number(row[4] ?? 0);
      const volume = Number(row[5] ?? 0);
      if (!(ts > 0 && open > 0 && high > 0 && low > 0 && close > 0)) continue;
      out.push({ ts, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    }
    // Bybit returns newest-first; scalper logic expects oldest-first.
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean> {
    if (!symbol) return false;
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const body = JSON.stringify({ category: 'spot', symbol: this.normalizeSymbol(symbol), orderId });
    const ts   = Date.now();
    const sig  = sign(creds.apiKey, creds.secretKey, ts, body);
    const r    = await safeFetch(`${base}/v5/order/cancel`, { method: 'POST', headers: headers(creds, ts, sig), body }, 'bybit');
    if (!r.ok) return false;
    const retCode = Number((r.data as Record<string, unknown>)?.['retCode'] ?? -1);
    return retCode === 0;
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

  /**
   * Convert tiny "dust" leftovers into USDT via Bybit's native Coin Exchange
   * (quote-apply + convert-execute) endpoints. Bybit doesn't expose a single
   * batch dust call like Binance, so we iterate per-asset:
   *   1. POST /v5/asset/exchange/quote-apply  → returns a quoteTxId
   *   2. POST /v5/asset/exchange/convert-execute  → finalises the conversion
   * Per-asset failures (ineligible coin, below min, expired quote) come back
   * with the venue's own retMsg so the user sees an actionable reason.
   */
  async sweepDust(creds: ExchangeCredentials, assets: string[]): Promise<DustSweepResult> {
    if (creds.testnet) {
      return {
        exchange: 'bybit', swept: [],
        failed: assets.map(a => ({ asset: String(a ?? '').toUpperCase(), reason: 'TESTNET_UNSUPPORTED' })),
        note: 'Bybit testnet does not expose the Coin Exchange convert endpoints. Switch to Real mode to sweep dust on the live account.',
      };
    }
    const cleaned = Array.from(new Set(
      assets.map(a => String(a ?? '').trim().toUpperCase()).filter(Boolean),
    ));
    if (cleaned.length === 0) {
      return { exchange: 'bybit', swept: [], failed: [], note: 'No assets supplied' };
    }

    // Bybit Coin Exchange operates on a single wallet per call, so we need
    // per-scope amounts (not the merged total). The merged getBalanceBreakdown
    // sums UNIFIED+FUND for the same coin, which would cause false "insufficient
    // balance" rejections when we ask one wallet to convert the combined amount.
    // Build a per-(asset, accountType) map by querying each wallet directly.
    const slicesByAsset = new Map<string, Array<{ accountType: string; available: number }>>();
    const addSlice = (asset: string, accountType: string, available: number) => {
      if (!asset || !(available > 0)) return;
      const key = asset.toUpperCase();
      const arr = slicesByAsset.get(key) ?? [];
      arr.push({ accountType, available });
      slicesByAsset.set(key, arr);
    };

    // ── UNIFIED / SPOT (wallet-balance) ────────────────────────────────────
    const walletProbes: Array<{ accountType: string; convertType: string }> = [
      { accountType: 'UNIFIED', convertType: 'eb_convert_uta' },
      { accountType: 'SPOT',    convertType: 'eb_convert_spot' },
    ];
    for (const probe of walletProbes) {
      const ts  = Date.now();
      const qs  = `accountType=${probe.accountType}`;
      const sig = sign(creds.apiKey, creds.secretKey, ts, qs);
      const r   = await safeFetch(`${BASE}/v5/account/wallet-balance?${qs}`, {
        headers: headers(creds, ts, sig),
      }, 'bybit');
      if (!r.ok) continue;
      const retCode = Number((r.data as Record<string, unknown>)?.['retCode'] ?? -1);
      if (retCode !== 0) continue;
      const list  = (r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['list'] ?? [];
      const first = (list[0] ?? {}) as Record<string, unknown>;
      const coins = Array.isArray(first['coin']) ? first['coin'] as Array<Record<string, unknown>> : [];
      for (const c of coins) {
        const asset = String(c['coin'] ?? '');
        const available = parseFloat(String(c['availableToWithdraw'] ?? c['free'] ?? c['walletBalance'] ?? '0'));
        if (Number.isFinite(available) && available > 0) addSlice(asset, probe.convertType, available);
      }
    }

    // ── FUND (transfer balance) ────────────────────────────────────────────
    {
      const ts  = Date.now();
      const qs  = `accountType=FUND`;
      const sig = sign(creds.apiKey, creds.secretKey, ts, qs);
      const r   = await safeFetch(
        `${BASE}/v5/asset/transfer/query-account-coins-balance?${qs}`,
        { headers: headers(creds, ts, sig) }, 'bybit',
      );
      if (r.ok) {
        const retCode = Number((r.data as Record<string, unknown>)?.['retCode'] ?? -1);
        if (retCode === 0) {
          const arr = (r.data as Record<string, Record<string, unknown[]>>)?.['result']?.['balance'] ?? [];
          for (const c of arr) {
            const c2 = c as Record<string, unknown>;
            const asset = String(c2['coin'] ?? '');
            const transfer = parseFloat(String(c2['transferBalance'] ?? '0'));
            const wallet   = parseFloat(String(c2['walletBalance']   ?? '0'));
            const available = Number.isFinite(transfer) && transfer > 0 ? transfer : wallet;
            if (Number.isFinite(available) && available > 0) addSlice(asset, 'eb_convert_funding', available);
          }
        }
      }
    }

    const swept:  string[] = [];
    const failed: Array<{ asset: string; reason: string }> = [];
    const pending: Array<{ asset: string; reason: string; quoteTxId?: string }> = [];
    let totalReceived = 0;
    const rawDetails: Array<Record<string, unknown>> = [];

    // Coin Exchange settlement is asynchronous: convert-execute returns 200
    // long before the USDT balance lands. Poll convert-result-query until the
    // venue reports SUCCESS / FAILURE, or until this short budget elapses
    // (settlements normally complete in <2s; we cap at ~6s so the HTTP
    // request doesn't stall the UI for sweeps that genuinely got stuck).
    const POLL_TIMEOUT_MS  = 6000;
    const POLL_INTERVAL_MS = 500;
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const pollConvertResult = async (
      quoteTxId: string,
      accountType: string,
    ): Promise<{ status: 'success' | 'failure' | 'pending'; reason?: string; toAmount?: number; raw?: unknown }> => {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let lastRaw: unknown = undefined;
      let lastReason = 'still pending after polling timeout';
      while (Date.now() < deadline) {
        const tsP  = Date.now();
        const qsP  = `quoteTxId=${encodeURIComponent(quoteTxId)}&accountType=${encodeURIComponent(accountType)}`;
        const sigP = sign(creds.apiKey, creds.secretKey, tsP, qsP);
        const rP   = await safeFetch(
          `${BASE}/v5/asset/exchange/convert-result-query?${qsP}`,
          { headers: headers(creds, tsP, sigP) }, 'bybit',
        );
        if (!rP.ok) {
          lastReason = rP.error?.message ?? 'convert-result-query failed';
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const pData    = (rP.data as Record<string, unknown>) ?? {};
        const pRetCode = Number(pData['retCode'] ?? -1);
        const pRetMsg  = String(pData['retMsg'] ?? '');
        if (pRetCode !== 0) {
          lastReason = `convert-result-query retCode ${pRetCode}: ${pRetMsg}`;
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const pResult = (pData['result'] as Record<string, unknown>) ?? {};
        lastRaw = pResult;
        const status = String(pResult['exchangeStatus'] ?? pResult['status'] ?? '').toLowerCase();
        if (status === 'success') {
          const toAmt = parseFloat(String(pResult['toAmount'] ?? '0'));
          return { status: 'success', toAmount: Number.isFinite(toAmt) ? toAmt : 0, raw: pResult };
        }
        if (status === 'failure' || status === 'failed') {
          return { status: 'failure', reason: `Bybit reported FAILURE for quoteTxId ${quoteTxId}`, raw: pResult };
        }
        // PENDING / PROCESSING / INIT — keep polling
        await sleep(POLL_INTERVAL_MS);
      }
      return { status: 'pending', reason: lastReason, raw: lastRaw };
    };

    for (const asset of cleaned) {
      if (asset === 'USDT') {
        failed.push({ asset, reason: 'Already USDT — no conversion needed' });
        continue;
      }
      const slices = slicesByAsset.get(asset) ?? [];
      if (slices.length === 0) {
        failed.push({ asset, reason: 'No available balance to convert in any Bybit wallet' });
        continue;
      }

      let lastReason  = 'Conversion failed';
      let anySucceeded = false;
      let anyPending   = false;
      let anyHardFailure = false;
      let assetReceived = 0;

      // Convert each wallet slice independently — Coin Exchange operates on
      // one wallet per call, so UNIFIED + FUND for the same coin are two
      // separate quote-apply/convert-execute round-trips.
      for (const slice of slices) {
        // ── Step 1: quote-apply ────────────────────────────────────────────
        const quoteBody = JSON.stringify({
          fromCoin:     asset,
          fromCoinType: 'crypto',
          toCoin:       'USDT',
          toCoinType:   'crypto',
          requestCoin:  asset,
          requestAmount: String(slice.available),
          accountType:   slice.accountType,
        });
        const tsQ  = Date.now();
        const sigQ = sign(creds.apiKey, creds.secretKey, tsQ, quoteBody);
        const rQ   = await safeFetch(`${BASE}/v5/asset/exchange/quote-apply`, {
          method: 'POST', headers: headers(creds, tsQ, sigQ), body: quoteBody,
        }, 'bybit');

        if (!rQ.ok) {
          lastReason = `[${slice.accountType}] ${rQ.error?.message ?? 'Quote request failed'}`;
          anyHardFailure = true;
          continue;
        }
        const qData    = (rQ.data as Record<string, unknown>) ?? {};
        const qRetCode = Number(qData['retCode'] ?? -1);
        const qRetMsg  = String(qData['retMsg'] ?? '');
        if (qRetCode !== 0) {
          lastReason = `[${slice.accountType}] quote-apply retCode ${qRetCode}: ${qRetMsg}`;
          anyHardFailure = true;
          continue;
        }
        const qResult   = (qData['result'] as Record<string, unknown>) ?? {};
        const quoteTxId = String(qResult['quoteTxId'] ?? '');
        const toAmount  = parseFloat(String(qResult['toAmount'] ?? '0')) || 0;
        if (!quoteTxId) {
          lastReason = `[${slice.accountType}] quote-apply returned no quoteTxId (retMsg: ${qRetMsg || 'n/a'})`;
          anyHardFailure = true;
          continue;
        }

        // ── Step 2: convert-execute ────────────────────────────────────────
        const execBody = JSON.stringify({ quoteTxId });
        const tsE  = Date.now();
        const sigE = sign(creds.apiKey, creds.secretKey, tsE, execBody);
        const rE   = await safeFetch(`${BASE}/v5/asset/exchange/convert-execute`, {
          method: 'POST', headers: headers(creds, tsE, sigE), body: execBody,
        }, 'bybit');

        if (!rE.ok) {
          lastReason = `[${slice.accountType}] ${rE.error?.message ?? 'Convert execute failed'}`;
          anyHardFailure = true;
          continue;
        }
        const eData    = (rE.data as Record<string, unknown>) ?? {};
        const eRetCode = Number(eData['retCode'] ?? -1);
        const eRetMsg  = String(eData['retMsg'] ?? '');
        if (eRetCode !== 0) {
          lastReason = `[${slice.accountType}] convert-execute retCode ${eRetCode}: ${eRetMsg}`;
          anyHardFailure = true;
          continue;
        }

        // ── Step 3: poll convert-result-query until SUCCESS / FAILURE / timeout ─
        // Settlement outcome is tracked PER SLICE so a partially-settled asset
        // (e.g. UNIFIED settled, FUND still pending) shows up in BOTH `swept`
        // and `pending` — the user sees "1 conversion landed, 1 still
        // settling" instead of a misleading all-clear.
        const settled = await pollConvertResult(quoteTxId, slice.accountType);
        if (settled.status === 'success') {
          anySucceeded = true;
          // Prefer the settled toAmount when the venue reports it; fall back
          // to the quote estimate so we still credit something to the toast.
          const credited = settled.toAmount && settled.toAmount > 0 ? settled.toAmount : toAmount;
          assetReceived += credited;
          rawDetails.push({ asset, accountType: slice.accountType, quoteTxId, toAmount: credited, exec: eData['result'], settled: settled.raw });
        } else if (settled.status === 'failure') {
          lastReason = `[${slice.accountType}] ${settled.reason ?? 'Bybit reported FAILURE'}`;
          anyHardFailure = true;
          rawDetails.push({ asset, accountType: slice.accountType, quoteTxId, exec: eData['result'], settled: settled.raw });
        } else {
          // Still pending after timeout — record this slice so the UI can
          // show "still settling" even if a sibling slice already settled.
          anyPending = true;
          pending.push({
            asset,
            reason: `[${slice.accountType}] ${settled.reason ?? 'still settling on Bybit'}`,
            quoteTxId,
          });
          rawDetails.push({ asset, accountType: slice.accountType, quoteTxId, exec: eData['result'], settled: settled.raw, pending: true });
        }
      }

      // Asset-level rollup: `swept` and `pending` are independent — an asset
      // with mixed outcomes appears in both. `failed` only fires when no
      // slice settled and none is still pending (i.e. every slice hit a hard
      // failure, so there's no chance the funds will land later).
      if (anySucceeded) {
        swept.push(asset);
        totalReceived += assetReceived;
      }
      if (!anySucceeded && !anyPending && anyHardFailure) {
        failed.push({ asset, reason: lastReason });
      }
    }

    const noteParts: string[] = [];
    if (swept.length > 0) {
      noteParts.push('Converted via Bybit Coin Exchange — funds land in the same wallet the source asset was held in.');
    }
    if (pending.length > 0) {
      noteParts.push(
        `${pending.length} conversion${pending.length === 1 ? '' : 's'} accepted but still settling on Bybit — ` +
        `the USDT will appear in your wallet shortly.`,
      );
    }

    return {
      exchange:      'bybit',
      swept,
      failed,
      ...(pending.length > 0 ? { pending } : {}),
      ...(totalReceived > 0 ? { totalReceived } : {}),
      receivedAsset: 'USDT',
      ...(noteParts.length > 0 ? { note: noteParts.join(' ') } : {}),
      raw: rawDetails,
    };
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

function estimateSpreadPct(candles: CandleSnapshot[], price: number): number {
  if (!(price > 0) || candles.length === 0) return 0;
  const last = candles[candles.length - 1]!;
  // Spot ticker endpoint doesn't expose bid/ask in this adapter path.
  // Use latest candle micro-range as a conservative spread proxy.
  const proxy = Math.max(0, (last.high - last.low) / price);
  return proxy * 100;
}
