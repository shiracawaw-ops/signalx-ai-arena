// ─── Structured Exchange Errors ───────────────────────────────────────────────
// A small enum of failure classes that the frontend can map directly to a
// connection-state-machine state. Adapters should throw an
// ExchangeOperationError with one of these codes; the route layer surfaces
// `{ ok:false, code, error }` to the client.

export type ExchangeErrorCode =
  | 'network'        // backend or upstream unreachable, timeout, DNS, etc.
  | 'auth'           // invalid api key / signature / timestamp drift
  | 'permission'     // valid key but missing read / trade / withdraw scope
  | 'rate_limit'     // upstream 429 or exchange-specific throttle
  | 'account_type'   // wrong account type (e.g. Bybit Unified vs Spot vs Contract)
  | 'empty'          // call succeeded but returned no rows
  | 'unknown';       // anything we couldn't classify

export class ExchangeOperationError extends Error {
  readonly code: ExchangeErrorCode;
  readonly status?: number;
  constructor(code: ExchangeErrorCode, message: string, status?: number) {
    super(message);
    this.name   = 'ExchangeOperationError';
    this.code   = code;
    if (status !== undefined) this.status = status;
  }
}

// Heuristic classifier for adapter exceptions that did NOT use
// ExchangeOperationError. Used by the route layer as a last-ditch fallback so
// every error always carries a code.
export function classifyError(err: unknown): { code: ExchangeErrorCode; message: string; status?: number } {
  if (err instanceof ExchangeOperationError) {
    const result: { code: ExchangeErrorCode; message: string; status?: number } = {
      code: err.code,
      message: err.message,
    };
    if (err.status !== undefined) result.status = err.status;
    return result;
  }
  const msg = (err as Error)?.message ?? String(err);
  const lc  = msg.toLowerCase();

  if (lc.includes('timeout') || lc.includes('timed out') || lc.includes('econn') ||
      lc.includes('network') || lc.includes('fetch failed') || lc.includes('enotfound')) {
    return { code: 'network', message: msg };
  }
  if (lc.includes('rate') || lc.includes('429')) {
    return { code: 'rate_limit', message: msg, status: 429 };
  }
  if (lc.includes('signature') || lc.includes('invalid api') || lc.includes('unauthor') ||
      lc.includes('401') || lc.includes('api-key') || lc.includes('apikey')) {
    return { code: 'auth', message: msg, status: 401 };
  }
  if (lc.includes('permission') || lc.includes('not allowed') || lc.includes('forbidden') || lc.includes('403')) {
    return { code: 'permission', message: msg, status: 403 };
  }
  if (lc.includes('account type') || lc.includes('accounttype')) {
    return { code: 'account_type', message: msg };
  }
  return { code: 'unknown', message: msg };
}

// ─── Helpers for adapters ────────────────────────────────────────────────────
// Build (and throw) an ExchangeOperationError from an HTTP-style response so
// every adapter surfaces the same classified error codes that Bybit does.
export function classifyHttpFailure(
  exchange: string,
  status: number | undefined,
  rawMessage: string | undefined,
): ExchangeOperationError {
  const msg = rawMessage ?? `${exchange} balance fetch failed`;
  const lc  = msg.toLowerCase();
  const ex  = exchange.charAt(0).toUpperCase() + exchange.slice(1);

  if (status === 401 || lc.includes('signature') || lc.includes('apikey') ||
      lc.includes('api key') || lc.includes('api-key') || lc.includes('unauthor') ||
      lc.includes('invalid key')) {
    return new ExchangeOperationError('auth', `${ex} rejected the API key: ${msg}`, 401);
  }
  if (status === 403 || lc.includes('permission') || lc.includes('not allowed') ||
      lc.includes('forbidden')) {
    return new ExchangeOperationError('permission', `${ex} API key lacks permission: ${msg}`, 403);
  }
  if (status === 429 || lc.includes('rate limit') || lc.includes('too many requests')) {
    return new ExchangeOperationError('rate_limit', `${ex} rate limit hit: ${msg}`, 429);
  }
  if (status === 422 || lc.includes('account type') || lc.includes('accounttype')) {
    return new ExchangeOperationError('account_type', `${ex} wrong account type: ${msg}`, 422);
  }
  if (status === 0 ||
      lc.includes('timeout') || lc.includes('timed out') ||
      lc.includes('network') || lc.includes('econn') ||
      lc.includes('fetch failed') || lc.includes('enotfound')) {
    return new ExchangeOperationError('network', `${ex} unreachable: ${msg}`);
  }
  // Anything else (including HTTP 200 business errors with no recognised
  // keyword) falls through to `unknown` so the caller can still surface a
  // typed error without misclassifying it as a network failure.
  return new ExchangeOperationError('unknown', `${ex} balance fetch failed: ${msg}`, status);
}

// Many exchanges return HTTP 200 with an error payload in the body
// (e.g. Binance `{code, msg}`, OKX `{code:'1', msg}`, Bitget `{code:'40001'}`,
// KuCoin `{code:'400003'}`). This helper inspects a known "ok value" on a
// known field and throws a classified error otherwise.
export function check200Error(
  exchange: string,
  data: unknown,
  codeField: string,
  msgField: string,
  okValues: Array<string | number | undefined>,
): void {
  const obj = data as Record<string, unknown> | null | undefined;
  if (!obj || typeof obj !== 'object') return;
  if (!(codeField in obj)) return;
  const code = obj[codeField] as string | number | undefined;
  if (okValues.includes(code as string | number | undefined)) return;
  const rawMsg = obj[msgField];
  const msg = (typeof rawMsg === 'string' && rawMsg.length > 0)
    ? rawMsg
    : `${exchange} error code ${String(code)}`;
  throw classifyHttpFailure(exchange, undefined, msg);
}

// Asserts the value is a JS array. If it is not, the adapter response is
// malformed beyond the `check200Error` envelope and we throw a classified
// `unknown` error instead of letting `.filter` / `.map` blow up.
export function assertArray(exchange: string, value: unknown, context: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw classifyHttpFailure(exchange, undefined, `unexpected response shape from ${context}`);
}

// ─── Balance shape helper ────────────────────────────────────────────────────
// Stable-coin assets where USDT value == total. Adapters call
// `withUsdtValue` so every Balance returned across all 12 exchanges follows
// the same {asset, available, hold, total, usdtValue?} shape.
const STABLE_ASSETS = new Set([
  'USDT', 'USDC', 'USD', 'BUSD', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'PYUSD', 'USDE',
]);

export function withUsdtValue(b: {
  asset: string; available: number; hold: number; total: number;
}): { asset: string; available: number; hold: number; total: number; usdtValue?: number } {
  if (STABLE_ASSETS.has(b.asset.toUpperCase())) {
    return { ...b, usdtValue: b.total };
  }
  return { ...b };
}

