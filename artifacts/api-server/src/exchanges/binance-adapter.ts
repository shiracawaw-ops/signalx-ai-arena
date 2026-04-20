// ─── Binance REST Adapter ─────────────────────────────────────────────────────
import { hmacSHA256, maskKey, safeFetch, stubSymbolRules, toUsdtPair } from './base-adapter.js';
import { classifyHttpFailure, check200Error, withUsdtValue, assertArray, enrichBalancesWithUsdtValue } from './exchange-error.js';
import { getOutboundIp } from '../lib/outbound-ip.js';
import { logger } from '../lib/logger.js';
import type {
  ExchangeAdapter, ExchangeCredentials, ConnectResult, Permission,
  Balance, SymbolRules, OrderRequest, OrderResult, OrderTestResult,
  ExchangeDiagnostic, SelfTestResult, DiagnosticStep,
} from './types.js';

const BASE         = 'https://api.binance.com';
const TESTNET_BASE = 'https://testnet.binance.vision';

// ── Precision-safe formatters ────────────────────────────────────────────────
// Binance is unforgiving about LOT_SIZE / PRICE_FILTER: a quantity of
// 5.6000000000001 (typical JS float noise after `Math.floor(x/step)*step`)
// will trigger -1013 even though it visually equals 5.6.  We therefore
// format every quantity & price as a STRING with the precision derived
// from stepSize/tickSize before sending it.

function decimalsFromStep(step: number): number {
  if (!step || step <= 0) return 8;
  // step = 0.001 → 3 decimals.  Use string parsing so we don't lose
  // precision via Math.log10 rounding (e.g. 0.1 → 0.999999... log).
  const s = step.toString();
  if (s.includes('e-')) return parseInt(s.split('e-')[1] ?? '8', 10);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : (s.length - dot - 1);
}

function floorToStepStr(value: number, step: number): string {
  if (!step || step <= 0) return value.toString();
  const decimals = decimalsFromStep(step);
  // Use integer arithmetic to dodge float drift.  Multiply then floor.
  const k = Math.pow(10, decimals);
  const stepK = Math.round(step * k);
  const valueK = Math.floor(value * k);
  const flooredK = Math.floor(valueK / stepK) * stepK;
  return (flooredK / k).toFixed(decimals);
}

// Symbol rules cache — exchangeInfo is stable for hours.  TTL 5 min.
const SYMBOL_RULES_TTL_MS = 5 * 60_000;
const symbolRulesCache = new Map<string, { rules: SymbolRules; expires: number }>();

// Per-symbol failure circuit breaker — after N consecutive REAL placeOrder
// failures from the exchange we stop forwarding orders for that pair for a
// cooldown window so we don't burn rate-limit headroom on broken inputs.
interface SymbolFailureGate { fails: number; lastFailTs: number; cooldownUntil: number }
const FAILURE_THRESHOLD   = 3;
const FAILURE_COOLDOWN_MS = 60_000;
const failureGate = new Map<string, SymbolFailureGate>();
function noteFailure(symKey: string) {
  const g = failureGate.get(symKey) ?? { fails: 0, lastFailTs: 0, cooldownUntil: 0 };
  g.fails++; g.lastFailTs = Date.now();
  if (g.fails >= FAILURE_THRESHOLD) g.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
  failureGate.set(symKey, g);
}
function noteSuccess(symKey: string) { failureGate.delete(symKey); }
function gateBlocked(symKey: string): { blocked: boolean; remainingMs: number } {
  const g = failureGate.get(symKey);
  if (!g || g.cooldownUntil === 0) return { blocked: false, remainingMs: 0 };
  const remaining = g.cooldownUntil - Date.now();
  if (remaining <= 0) { failureGate.delete(symKey); return { blocked: false, remainingMs: 0 }; }
  return { blocked: true, remainingMs: remaining };
}

// Map Binance -1013 / generic filter errors to a human-readable filter name.
function classifyOrderRejection(msg: string | undefined): { reason: string; detail: string } {
  const m = String(msg ?? '').toUpperCase();
  if (m.includes('LOT_SIZE') || m.includes('LOT SIZE')) {
    return { reason: 'LOT_SIZE', detail: 'Quantity is below the symbol minimum, above the maximum, or not a multiple of the step size.' };
  }
  if (m.includes('MIN_NOTIONAL') || m.includes('NOTIONAL')) {
    return { reason: 'MIN_NOTIONAL', detail: 'Order value (price × quantity) is below the symbol minimum notional.' };
  }
  if (m.includes('PRICE_FILTER')) {
    return { reason: 'PRICE_FILTER', detail: 'Price is below tick / above max / not aligned to tick size.' };
  }
  if (m.includes('PERCENT_PRICE')) {
    return { reason: 'PERCENT_PRICE', detail: 'Limit price is too far from the current market price.' };
  }
  if (m.includes('MARKET_LOT_SIZE')) {
    return { reason: 'MARKET_LOT_SIZE', detail: 'Market-order quantity is below min / above max / not aligned to market step.' };
  }
  if (m.includes('INSUFFICIENT BALANCE') || m.includes('-2010') || m.includes('-2019')) {
    return { reason: 'INSUFFICIENT_BALANCE', detail: 'Free balance on the exchange is not enough for this order (after fees).' };
  }
  if (m.includes('SYMBOL') && m.includes('NOT')) {
    return { reason: 'SYMBOL_INVALID', detail: 'Symbol is not tradable on this account / market.' };
  }
  if (m.includes('-2015') || m.includes('INVALID API') || m.includes('IP, KEY OR PERMISSIONS')) {
    return { reason: 'IP_OR_PERMISSION', detail: 'API key rejected — IP whitelist mismatch, expired key, or missing trading permission.' };
  }
  if (m.includes('-1021') || m.includes('TIMESTAMP')) {
    return { reason: 'TIMESTAMP_DRIFT', detail: 'Server clock is out of sync with Binance.' };
  }
  return { reason: 'EXCHANGE_REJECTED', detail: msg ?? 'Order rejected by exchange.' };
}

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
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const params = { timestamp: Date.now() };
    const q = signedQs(params, creds.secretKey);
    const r = await safeFetch(`${base}/api/v3/account?${q}`, {
      headers: authHeaders(creds.apiKey),
    }, 'binance');

    if (!r.ok) {
      logger.warn({
        exchange: 'binance', key: maskKey(creds.apiKey), testnet: !!creds.testnet,
        httpStatus: r.status, err: r.error?.message,
      }, '[binance.validate] failure');
      return {
        success: false,
        permissions: { read: false, trade: false, withdraw: false, futures: false },
        error: r.error?.message,
      };
    }

    const d = r.data as Record<string, unknown>;
    const perms = (d['permissions'] as string[] | undefined) ?? [];

    // ── PRIMARY trading flag: Binance's `canTrade` boolean ──────────────────
    // Binance returns `permissions: ['SPOT', 'MARGIN', 'TRD_GRP_002', ...]`
    // for many users — but for accounts that have been upgraded to a margin
    // tier or whose region is in a TRD_GRP only, the literal string 'SPOT'
    // is NOT in that array even though spot trading is enabled. The truly
    // canonical signal is the top-level `canTrade: true` boolean. Falling
    // back to permissions-array string matching is only used to derive the
    // *granular* spot/margin/futures flags below.
    const canTrade    = d['canTrade']    === true;
    const canWithdraw = d['canWithdraw'] === true;
    const accountType = String(d['accountType'] ?? '');

    const hasSpotPerm    = perms.includes('SPOT');
    const hasMarginPerm  = perms.includes('MARGIN');
    const hasFuturesPerm = perms.includes('FUTURES') || perms.includes('LEVERAGED');
    const hasOptionsPerm = perms.includes('OPTIONS');

    // Spot is enabled when Binance says so explicitly OR when canTrade is
    // true and the account type is SPOT (the common case for fresh keys
    // that don't carry a permissions array at all).
    const spot = hasSpotPerm || (canTrade && (accountType === 'SPOT' || accountType === ''));

    logger.info({
      exchange: 'binance', key: maskKey(creds.apiKey), testnet: !!creds.testnet,
      canTrade, canWithdraw, accountType, perms,
      derived: { spot, margin: hasMarginPerm, futures: hasFuturesPerm },
    }, '[binance.validate] success');

    return {
      success: true,
      permissions: {
        read:        true,
        trade:       canTrade,
        withdraw:    canWithdraw,
        futures:     hasFuturesPerm,
        spot,
        margin:      hasMarginPerm,
        options:     hasOptionsPerm,
        accountType: accountType || undefined,
      },
      uid: String(d['uid'] ?? ''),
      raw: {
        canTrade, canWithdraw, canDeposit: d['canDeposit'] === true,
        accountType, permissions: perms,
        updateTime: d['updateTime'],
      },
    };
  }

  async getPermissions(creds: ExchangeCredentials): Promise<Permission> {
    const r = await this.validateCredentials(creds);
    return r.permissions;
  }

  // ── Diagnostic & Self-Test ──────────────────────────────────────────────
  // Surface every signal Binance gives us so the user can see exactly why
  // a permission check passed or failed — no guessing, no opaque "trading
  // permission missing" string. Both methods NEVER include secrets in the
  // returned `raw` payload.

  async runDiagnostic(creds: ExchangeCredentials): Promise<ExchangeDiagnostic> {
    const base    = creds.testnet ? TESTNET_BASE : BASE;
    const steps: DiagnosticStep[] = [];
    const apiKeyMasked = maskKey(creds.apiKey);

    // 1) Outbound IP — what does the world see when we call Binance from here?
    let outboundIp: string | undefined;
    {
      const t0 = Date.now();
      try {
        outboundIp = await getOutboundIp();
        steps.push({
          step: 'Detect outbound IP',
          ok: !!outboundIp,
          detail: outboundIp ? `Public IP this server reaches Binance from: ${outboundIp}` : 'Could not detect public IP (probe failed)',
          durationMs: Date.now() - t0,
        });
      } catch (e) {
        steps.push({ step: 'Detect outbound IP', ok: false, detail: (e as Error).message, durationMs: Date.now() - t0 });
      }
    }

    // 2) Public connectivity — can we reach Binance at all?
    {
      const t0 = Date.now();
      const r = await safeFetch(`${base}/api/v3/ping`, {}, 'binance');
      steps.push({
        step: 'Public connectivity (ping)',
        ok: r.ok,
        httpStatus: r.status,
        detail: r.ok ? 'Binance is reachable from this server' : `Cannot reach Binance: ${r.error?.message ?? 'unknown'}`,
        durationMs: Date.now() - t0,
      });
    }

    // 3) Server time skew — common cause of -1021 errors
    {
      const t0 = Date.now();
      const r = await safeFetch(`${base}/api/v3/time`, {}, 'binance');
      if (r.ok) {
        const skew = Math.abs(Number((r.data as Record<string, number>)['serverTime'] ?? Date.now()) - Date.now());
        steps.push({
          step: 'Server time skew',
          ok: skew < 5_000,
          detail: `Skew: ${skew}ms (threshold 5000ms)`,
          durationMs: Date.now() - t0,
        });
      } else {
        steps.push({ step: 'Server time skew', ok: false, detail: 'Could not read server time', durationMs: Date.now() - t0 });
      }
    }

    // 4) Signed account endpoint — the real auth+IP+permissions test
    let permissions: Permission = { read: false, trade: false, withdraw: false, futures: false };
    let accountType: string | undefined;
    let raw: Record<string, unknown> = {};
    {
      const t0 = Date.now();
      const q  = signedQs({ timestamp: Date.now() }, creds.secretKey);
      const r  = await safeFetch(`${base}/api/v3/account?${q}`, { headers: authHeaders(creds.apiKey) }, 'binance');
      if (r.ok) {
        const d = r.data as Record<string, unknown>;
        const perms = (d['permissions'] as string[] | undefined) ?? [];
        const canTrade    = d['canTrade']    === true;
        const canWithdraw = d['canWithdraw'] === true;
        accountType = String(d['accountType'] ?? '') || undefined;
        const hasSpotPerm   = perms.includes('SPOT');
        const hasMargin     = perms.includes('MARGIN');
        const hasFutures    = perms.includes('FUTURES') || perms.includes('LEVERAGED');
        const hasOptions    = perms.includes('OPTIONS');
        const spot = hasSpotPerm || (canTrade && (accountType === 'SPOT' || !accountType));
        permissions = {
          read: true, trade: canTrade, withdraw: canWithdraw, futures: hasFutures,
          spot, margin: hasMargin, options: hasOptions, accountType,
        };
        raw = { canTrade, canWithdraw, canDeposit: d['canDeposit'] === true, accountType, permissions: perms };
        steps.push({
          step: 'Signed account endpoint (/api/v3/account)',
          ok: true,
          httpStatus: 200,
          detail: `canTrade=${canTrade}, canWithdraw=${canWithdraw}, accountType=${accountType ?? '?'}, permissions=[${perms.join(', ') || 'empty'}]`,
          raw,
          durationMs: Date.now() - t0,
        });
      } else {
        const msg = r.error?.message ?? 'unknown';
        steps.push({
          step: 'Signed account endpoint (/api/v3/account)',
          ok: false,
          httpStatus: r.status,
          code: r.error?.code,
          detail: msg,
          durationMs: Date.now() - t0,
        });
      }
    }

    // 5) Order test — Binance's `/order/test` endpoint validates the full
    // order flow (auth + IP whitelist + spot trading permission) WITHOUT
    // placing a real order. This is the most decisive trading-permission probe.
    {
      const t0 = Date.now();
      const params: Record<string, string | number> = {
        symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
        timeInForce: 'GTC', quantity: '0.0001', price: '10000',
        timestamp: Date.now(),
      };
      const q = signedQs(params, creds.secretKey);
      const r = await safeFetch(`${base}/api/v3/order/test?${q}`, {
        method: 'POST',
        headers: authHeaders(creds.apiKey),
      }, 'binance');
      if (r.ok) {
        steps.push({
          step: 'Spot order validation (/api/v3/order/test, no fill)',
          ok: true, httpStatus: 200,
          detail: 'Spot trading permission CONFIRMED — Binance accepted a test order without placing it.',
          durationMs: Date.now() - t0,
        });
      } else {
        const msg = r.error?.message ?? 'unknown';
        const code = r.error?.code;
        steps.push({
          step: 'Spot order validation (/api/v3/order/test, no fill)',
          ok: false, httpStatus: r.status, code, detail: msg,
          durationMs: Date.now() - t0,
        });
      }
    }

    // 6) Build a recommendation based on the failures we observed
    const acctStep = steps.find(s => s.step.startsWith('Signed account'));
    const orderStep = steps.find(s => s.step.startsWith('Spot order'));
    let recommendation: string | undefined;
    if (acctStep && !acctStep.ok) {
      const msg = (acctStep.detail ?? '').toLowerCase();
      if (msg.includes('-2015') || msg.includes('invalid api') || msg.includes('not allowed') || msg.includes('whitelist')) {
        recommendation = `Binance rejected the API key with code ${acctStep.code ?? '-2015'}. Most common cause: IP whitelist mismatch. Add ${outboundIp ?? 'this server\'s public IP'} to the API key's IP whitelist on Binance, OR disable IP restriction on the key.`;
      } else if (msg.includes('-2014') || msg.includes('signature')) {
        recommendation = 'Binance rejected the request signature. Re-paste the secret key — extra spaces/newlines are the usual cause.';
      } else if (msg.includes('-1021')) {
        recommendation = 'Server time skew. Sync this machine\'s clock or use NTP.';
      }
    } else if (orderStep && !orderStep.ok) {
      const msg  = (orderStep.detail ?? '').toLowerCase();
      const code = String(orderStep.code ?? '');
      if (code === '-2015' || msg.includes('not allowed') || msg.includes('whitelist')) {
        recommendation = `Account auth works but the order test was blocked. This means: (a) Spot Trading is NOT enabled on the API key in Binance → enable it; OR (b) the IP whitelist is on but ${outboundIp ?? 'this server\'s IP'} is not added. Fix one of these on Binance API Management.`;
      } else if (code === '-1013' || msg.includes('filter') || msg.includes('notional')) {
        recommendation = 'Spot trading permission is OK — the test order failed only on a symbol filter (notional/lot size). This is NOT a permission problem.';
      } else if (msg.includes('insufficient')) {
        recommendation = 'Spot trading permission is OK — the test order surfaced "insufficient balance" which is also a non-permission outcome.';
      }
    } else if (acctStep?.ok && orderStep?.ok) {
      recommendation = 'All checks passed. Trading is fully enabled on this API key.';
    }

    return {
      exchange: 'binance', apiKeyMasked, testnet: !!creds.testnet,
      outboundIp, permissions, accountType, steps, recommendation,
      timestamp: Date.now(),
    };
  }

  async runSelfTest(creds: ExchangeCredentials): Promise<SelfTestResult> {
    const diag = await this.runDiagnostic(creds);
    const failing = diag.steps.filter(s => !s.ok);
    // Self-test passes when ping + signed account + order test all succeed.
    // Outbound IP and time-skew failures are warnings, not failures.
    const criticalSteps = diag.steps.filter(s =>
      s.step.startsWith('Public connectivity') ||
      s.step.startsWith('Signed account') ||
      s.step.startsWith('Spot order'),
    );
    const pass = criticalSteps.every(s => s.ok);
    const summary = pass
      ? `PASS — Spot trading is enabled on key ${diag.apiKeyMasked} (IP ${diag.outboundIp ?? '?'})`
      : `FAIL — ${failing.length} check${failing.length === 1 ? '' : 's'} failed. ${diag.recommendation ?? ''}`.trim();
    return {
      exchange: 'binance',
      apiKeyMasked: diag.apiKeyMasked,
      testnet: !!creds.testnet,
      pass,
      steps: diag.steps,
      summary,
      timestamp: Date.now(),
    };
  }

  async getBalances(creds: ExchangeCredentials): Promise<Balance[]> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const q = signedQs({ timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${base}/api/v3/account?${q}`, {
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    if (!r.ok) throw classifyHttpFailure('binance', r.status, r.error?.message);
    check200Error('binance', r.data, 'code', 'msg', [undefined, 0, '0', 200, '200']);
    const d   = r.data as Record<string, unknown>;
    const raw = assertArray('binance', d['balances'] ?? [], '/api/v3/account#balances') as Array<Record<string, string>>;
    const balances = raw
      .filter(b => parseFloat(b['free'] ?? '0') + parseFloat(b['locked'] ?? '0') > 0)
      .map(b => {
        const availN = parseFloat(b['free'] ?? '0');
        const holdN  = parseFloat(b['locked'] ?? '0');
        const available = Number.isFinite(availN) ? availN : 0;
        const hold      = Number.isFinite(holdN) ? holdN : 0;
        return withUsdtValue({
          asset:     b['asset'] ?? '',
          available,
          hold,
          total:     available + hold,
        });
      });
    return enrichBalancesWithUsdtValue(this.id, balances, sym => this.getPrice(sym));
  }

  async getSymbolRules(creds: ExchangeCredentials, symbol: string): Promise<SymbolRules> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const sym = this.normalizeSymbol(symbol);
    const cacheKey = `${creds.testnet ? 'TN' : 'PRD'}:${sym}`;

    // Cache hit?
    const cached = symbolRulesCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return { ...cached.rules, filterSource: 'cached' };
    }

    const r = await safeFetch(`${base}/api/v3/exchangeInfo?symbol=${sym}`, {}, 'binance');
    if (!r.ok) {
      logger.warn({ exchange: 'binance', sym, err: r.error?.message }, '[binance.rules] exchangeInfo fetch failed; using stub');
      return { ...stubSymbolRules(sym), filterSource: 'stub' };
    }
    const d = r.data as Record<string, unknown>;
    const symbols = (d['symbols'] as Array<Record<string, unknown>>) ?? [];
    const info = symbols.find(s => s['symbol'] === sym);
    if (!info) {
      logger.warn({ exchange: 'binance', sym }, '[binance.rules] symbol not found in exchangeInfo; using stub');
      return { ...stubSymbolRules(sym), filterSource: 'stub' };
    }
    const filters = (info['filters'] as Array<Record<string, string>>) ?? [];
    const lotFilter  = filters.find(f => f['filterType'] === 'LOT_SIZE') ?? {};
    const mktLotFilter = filters.find(f => f['filterType'] === 'MARKET_LOT_SIZE') ?? {};
    const notional   = filters.find(f => f['filterType'] === 'NOTIONAL' || f['filterType'] === 'MIN_NOTIONAL') ?? {};
    const priceFilter = filters.find(f => f['filterType'] === 'PRICE_FILTER') ?? {};

    // For market orders, MARKET_LOT_SIZE (when present) takes precedence over
    // LOT_SIZE for min/step. We pick the STRICTER of the two so a single set
    // of rules safely covers both market & limit orders.
    const lotMinQty   = parseFloat(String(lotFilter['minQty']   ?? '0.00001'));
    const lotStep     = parseFloat(String(lotFilter['stepSize'] ?? '0.00001'));
    const mktMinQty   = mktLotFilter['minQty']   ? parseFloat(String(mktLotFilter['minQty']))   : 0;
    const mktStep     = mktLotFilter['stepSize'] ? parseFloat(String(mktLotFilter['stepSize'])) : 0;
    const stepSize    = mktStep > lotStep ? mktStep : lotStep;
    const minQty      = mktMinQty > lotMinQty ? mktMinQty : lotMinQty;
    const tickSize  = parseFloat(String(priceFilter['tickSize'] ?? '0.01'));
    const rules: SymbolRules = {
      symbol:        sym,
      baseCurrency:  String(info['baseAsset'] ?? ''),
      quoteCurrency: String(info['quoteAsset'] ?? ''),
      minQty,
      maxQty:        parseFloat(String(lotFilter['maxQty'] ?? '9000000')),
      stepSize,
      minNotional:   parseFloat(String(notional['minNotional'] ?? notional['notional'] ?? '5')),
      tickSize,
      maxLeverage:   1,
      baseAssetPrecision:   typeof info['baseAssetPrecision']  === 'number' ? info['baseAssetPrecision']  as number : decimalsFromStep(stepSize),
      quoteAssetPrecision:  typeof info['quoteAssetPrecision'] === 'number' ? info['quoteAssetPrecision'] as number : decimalsFromStep(tickSize),
      pricePrecision:       decimalsFromStep(tickSize),
      status:               String(info['status'] ?? 'TRADING'),
      isSpotTradingAllowed: info['isSpotTradingAllowed'] !== false,
      filterSource:         'live',
    };
    symbolRulesCache.set(cacheKey, { rules, expires: Date.now() + SYMBOL_RULES_TTL_MS });
    return rules;
  }

  /**
   * Build the params for a Binance /api/v3/order POST with quantity and
   * (optional) price formatted as STRINGS at the exact precision required
   * by the symbol's filters.  Pure / no I/O so the same logic powers both
   * placeOrder and the testOrder probe.
   */
  private async buildOrderParams(
    creds: ExchangeCredentials,
    order: OrderRequest,
  ): Promise<{ params: Record<string, string | number>; rules: SymbolRules; qtyStr: string; priceStr?: string }> {
    const sym   = this.normalizeSymbol(order.symbol);
    const rules = await this.getSymbolRules(creds, sym);
    const qtyStr = floorToStepStr(order.quantity, rules.stepSize);
    const params: Record<string, string | number> = {
      symbol:    sym,
      side:      order.side.toUpperCase(),
      type:      order.type.toUpperCase(),
      quantity:  qtyStr,
      timestamp: Date.now(),
    };
    let priceStr: string | undefined;
    if (order.type === 'limit' && order.price) {
      priceStr = floorToStepStr(order.price, rules.tickSize);
      params['timeInForce'] = 'GTC';
      params['price']       = priceStr;
    }
    if (order.clientId) params['newClientOrderId'] = order.clientId;
    return { params, rules, qtyStr, priceStr };
  }

  async placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult> {
    const base   = order.testnet ? TESTNET_BASE : BASE;
    const symKey = `${order.testnet ? 'TN' : 'PRD'}:${this.normalizeSymbol(order.symbol)}`;

    // Circuit breaker — block while a per-symbol cooldown is active.
    const gate = gateBlocked(symKey);
    if (gate.blocked) {
      throw new Error(
        `EXCHANGE_REJECTED: ${symKey} is in cooldown after ${FAILURE_THRESHOLD} consecutive failures (${Math.ceil(gate.remainingMs/1000)}s remaining)`,
      );
    }

    const { params, rules, qtyStr, priceStr } = await this.buildOrderParams(creds, order);

    // FAIL-CLOSED on stub rules — exchangeInfo failed and we'd be guessing
    // the symbol filters. Refuse to forward the order so a wrong stepSize
    // can't leak through and trip -1013 on the live exchange.
    if (rules.filterSource === 'stub') {
      throw new Error(`PREFLIGHT_RULES_STUB: live exchangeInfo unavailable for ${rules.symbol} — refusing to send order with synthetic filters. Retry shortly.`);
    }

    // Strict server-side preflight — refuse to even sign a request that we
    // can statically prove will be rejected by Binance filters.  This stops
    // -1013 storms before they happen.
    const qtyN     = parseFloat(qtyStr);
    let   priceN   = priceStr ? parseFloat(priceStr) : order.price ?? 0;
    // For MARKET orders the caller does NOT supply a price. Estimate one
    // from the public ticker so MIN_NOTIONAL still gets validated pre-sign.
    if (priceN <= 0 && order.type === 'market') {
      try {
        const est = await this.getPrice(rules.symbol);
        if (est > 0) priceN = est;
      } catch { /* ignore — fall through; we just won't preflight notional */ }
    }
    if (qtyN <= 0)                              throw new Error(`PREFLIGHT_LOT_SIZE: quantity rounds to 0 at stepSize ${rules.stepSize}`);
    if (qtyN < rules.minQty)                    throw new Error(`PREFLIGHT_LOT_SIZE: quantity ${qtyN} < minQty ${rules.minQty} for ${rules.symbol}`);
    if (rules.maxQty > 0 && qtyN > rules.maxQty) throw new Error(`PREFLIGHT_LOT_SIZE: quantity ${qtyN} > maxQty ${rules.maxQty} for ${rules.symbol}`);
    if (priceN > 0 && rules.minNotional > 0 && qtyN * priceN < rules.minNotional) {
      throw new Error(`PREFLIGHT_MIN_NOTIONAL: notional $${(qtyN*priceN).toFixed(4)} < minNotional $${rules.minNotional} for ${rules.symbol}`);
    }
    if (rules.status && rules.status !== 'TRADING') {
      throw new Error(`PREFLIGHT_SYMBOL_STATUS: ${rules.symbol} status=${rules.status} (not TRADING)`);
    }

    const q = signedQs(params, creds.secretKey);
    const r = await safeFetch(`${base}/api/v3/order?${q}`, {
      method: 'POST',
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    if (!r.ok) {
      const cls = classifyOrderRejection(r.error?.message);
      noteFailure(symKey);
      logger.warn({
        exchange: 'binance', sym: rules.symbol, qtyStr, priceStr,
        rules: { stepSize: rules.stepSize, minQty: rules.minQty, minNotional: rules.minNotional, tickSize: rules.tickSize, source: rules.filterSource },
        err: r.error?.message, reason: cls.reason,
      }, '[binance.order] failed');
      throw new Error(`${cls.reason}: ${cls.detail} (raw: ${r.error?.message ?? 'unknown'})`);
    }
    noteSuccess(symKey);
    return parseOrder(r.data as Record<string, unknown>);
  }

  /**
   * Hits Binance /api/v3/order/test — same auth + filter validation as a
   * real order, but the exchange returns `{}` on success WITHOUT executing.
   * Returned OrderTestResult details exactly which filter (if any) tripped
   * so the UI can show "LOT_SIZE: qty 5.6 is below minQty 6" instead of a
   * generic -1013.
   */
  async testOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderTestResult> {
    const base = order.testnet ? TESTNET_BASE : BASE;
    let rules: SymbolRules; let qtyStr = ''; let priceStr: string | undefined;
    try {
      const built = await this.buildOrderParams(creds, order);
      rules = built.rules; qtyStr = built.qtyStr; priceStr = built.priceStr;

      const echo = { symbol: rules.symbol, side: order.side.toUpperCase(), quantity: qtyStr, price: priceStr };

      // Surface stub rules — testOrder is meant to TELL the user what's
      // wrong, so we don't fail-closed here, but we mark the result so the
      // UI badge clearly shows "stub" provenance.
      if (rules.filterSource === 'stub') {
        return { ok: false, reason: 'RULES_STUB',
          detail: `Live exchangeInfo unavailable for ${rules.symbol}; cannot validate filters. Real order will be REFUSED until rules load.`,
          rules, echo };
      }

      // Local preflight first — no auth burned on obvious failures.
      const qtyN = parseFloat(qtyStr);
      let   priceN = priceStr ? parseFloat(priceStr) : order.price ?? 0;
      if (priceN <= 0 && order.type === 'market') {
        try { const est = await this.getPrice(rules.symbol); if (est > 0) priceN = est; } catch { /* ignore */ }
      }
      if (qtyN <= 0)
        return { ok: false, reason: 'LOT_SIZE', detail: `Quantity rounds to 0 at stepSize ${rules.stepSize}.`, rules, echo };
      if (qtyN < rules.minQty)
        return { ok: false, reason: 'LOT_SIZE', detail: `Quantity ${qtyN} is below minQty ${rules.minQty}.`, rules, echo };
      if (rules.maxQty > 0 && qtyN > rules.maxQty)
        return { ok: false, reason: 'LOT_SIZE', detail: `Quantity ${qtyN} is above maxQty ${rules.maxQty}.`, rules, echo };
      if (priceN > 0 && rules.minNotional > 0 && qtyN * priceN < rules.minNotional)
        return { ok: false, reason: 'MIN_NOTIONAL', detail: `Notional $${(qtyN*priceN).toFixed(4)} is below minNotional $${rules.minNotional}.`, rules, echo };
      if (rules.status && rules.status !== 'TRADING')
        return { ok: false, reason: 'SYMBOL_STATUS', detail: `Symbol status=${rules.status} (not TRADING).`, rules, echo };

      const q = signedQs(built.params, creds.secretKey);
      const r = await safeFetch(`${base}/api/v3/order/test?${q}`, {
        method: 'POST',
        headers: authHeaders(creds.apiKey),
      }, 'binance');
      if (!r.ok) {
        const cls = classifyOrderRejection(r.error?.message);
        return { ok: false, reason: cls.reason, detail: cls.detail, exchangeCode: r.error?.code, httpStatus: r.status, rules, echo, raw: r.error };
      }
      return { ok: true, rules, echo, raw: r.data };
    } catch (e) {
      const msg = (e as Error)?.message ?? 'Unknown error';
      const cls = classifyOrderRejection(msg);
      return { ok: false, reason: cls.reason, detail: cls.detail, rules: rules!, echo: { symbol: this.normalizeSymbol(order.symbol), side: order.side.toUpperCase(), quantity: qtyStr, price: priceStr } };
    }
  }

  async getPrice(symbol: string): Promise<number> {
    const sym = this.normalizeSymbol(symbol);
    const r = await safeFetch(`${BASE}/api/v3/ticker/price?symbol=${sym}`, {}, 'binance');
    if (!r.ok) throw new Error(`Binance getPrice failed: ${r.error?.message}`);
    return parseFloat(String((r.data as Record<string, string>)['price'] ?? '0'));
  }

  async cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean> {
    if (!symbol) return false;
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const sym = this.normalizeSymbol(symbol);
    const q = signedQs({ symbol: sym, orderId, timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${base}/api/v3/order?${q}`, {
      method: 'DELETE',
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    return r.ok;
  }

  async getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit = 50): Promise<OrderResult[]> {
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const sym = symbol ? this.normalizeSymbol(symbol) : 'BTCUSDT';
    const q = signedQs({ symbol: sym, limit, timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${base}/api/v3/allOrders?${q}`, {
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    if (!r.ok) return [];
    return ((r.data as unknown[]) ?? []).map(o => parseOrder(o as Record<string, unknown>));
  }

  async getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null> {
    if (!symbol) return null;
    const base = creds.testnet ? TESTNET_BASE : BASE;
    const sym = this.normalizeSymbol(symbol);
    const q = signedQs({ symbol: sym, orderId, timestamp: Date.now() }, creds.secretKey);
    const r = await safeFetch(`${base}/api/v3/order?${q}`, {
      headers: authHeaders(creds.apiKey),
    }, 'binance');
    if (!r.ok) return null;
    return parseOrder(r.data as Record<string, unknown>);
  }
}
