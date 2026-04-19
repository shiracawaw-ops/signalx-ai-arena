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
