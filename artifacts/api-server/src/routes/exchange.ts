// ─── Exchange Proxy Routes ─────────────────────────────────────────────────────
// All exchange API calls are proxied through here to avoid browser CORS issues.
// Credentials are passed per-request and NEVER stored server-side.
import { Router, type IRouter, type Request, type Response } from 'express';
import { getAdapter, listAdapters, isSupported } from '../exchanges/registry.js';
import { maskKey } from '../exchanges/base-adapter.js';
import type { ExchangeCredentials, OrderRequest } from '../exchanges/types.js';
import { classifyError } from '../exchanges/exchange-error.js';
import { logger } from '../lib/logger.js';

const router: IRouter = Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function extractCreds(req: Request): ExchangeCredentials | null {
  const apiKey     = String(req.headers['x-api-key']    ?? req.body?.apiKey    ?? '');
  const secretKey  = String(req.headers['x-secret-key'] ?? req.body?.secretKey ?? '');
  const passphrase = String(req.headers['x-passphrase'] ?? req.body?.passphrase ?? '');
  if (!apiKey || !secretKey) return null;
  const testnet = req.headers['x-testnet'] === '1';
  return { apiKey, secretKey, ...(passphrase ? { passphrase } : {}), ...(testnet ? { testnet } : {}) };
}

function isTestnetRequest(req: Request): boolean {
  return req.headers['x-testnet'] === '1';
}

function logAction(exchange: string, action: string, apiKey: string) {
  logger.info({ exchange, action, key: maskKey(apiKey) }, '[exchange-proxy]');
}

function badRequest(res: Response, msg: string) {
  res.status(400).json({ ok: false, error: msg });
}

// Default Retry-After hint (seconds) we surface for rate_limit responses when
// the upstream exchange did not give us a more specific value. The frontend
// uses this to schedule a single auto-retry after a brief throttle.
const DEFAULT_RATE_LIMIT_RETRY_AFTER_SEC = 30;

function serverError(res: Response, exchange: string, err: unknown) {
  const { code, message, status } = classifyError(err);
  logger.error({ exchange, code, error: message }, '[exchange-proxy] error');
  // Map error code → HTTP status so existing fetch/!res.ok checks still work.
  const httpStatus =
    status ??
    (code === 'auth'        ? 401 :
     code === 'permission'  ? 403 :
     code === 'rate_limit'  ? 429 :
     code === 'network'     ? 503 :
     code === 'account_type' ? 422 :
     502);
  if (code === 'rate_limit') {
    res.setHeader('Retry-After', String(DEFAULT_RATE_LIMIT_RETRY_AFTER_SEC));
    res.status(httpStatus).json({
      ok: false, code, error: message, exchange,
      retryAfter: DEFAULT_RATE_LIMIT_RETRY_AFTER_SEC,
    });
    return;
  }
  res.status(httpStatus).json({ ok: false, code, error: message, exchange });
}

function requireExchange(req: Request, res: Response): string | null {
  const ex = String(req.params['exchange'] ?? '').toLowerCase();
  if (!ex || !isSupported(ex)) {
    badRequest(res, `Unsupported exchange: "${ex}". Supported: ${listAdapters().join(', ')}`);
    return null;
  }
  return ex;
}

// ── routes ────────────────────────────────────────────────────────────────────

// GET /api/exchange — list supported exchanges
router.get('/exchange', (_req, res) => {
  res.json({ ok: true, exchanges: listAdapters() });
});

// GET /api/exchange/:exchange/ping — latency check (no auth needed)
router.get('/exchange/:exchange/ping', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const adapter = getAdapter(ex)!;
  try {
    const latency = await adapter.ping();
    res.json({ ok: true, exchange: ex, latency });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/validate — validate credentials + get permissions
router.post('/exchange/:exchange/validate', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials (x-api-key, x-secret-key headers)');
  logAction(ex, 'validate', creds.apiKey);
  const adapter = getAdapter(ex)!;
  try {
    const result = await adapter.validateCredentials(creds);
    if (!result.success) {
      // Adapter returned a non-throw failure — classify so the frontend
      // gets a stable code (auth / permission / network / rate_limit / …)
      // instead of a generic "balance_error".
      const { code, message } = classifyError(result.error ?? 'Validation failed');
      const httpStatus =
        code === 'auth'         ? 401 :
        code === 'permission'   ? 403 :
        code === 'rate_limit'   ? 429 :
        code === 'network'      ? 503 :
        code === 'account_type' ? 422 : 401;
      if (code === 'rate_limit') {
        res.setHeader('Retry-After', String(DEFAULT_RATE_LIMIT_RETRY_AFTER_SEC));
        return res.status(httpStatus).json({
          ok: false, exchange: ex, code, error: message,
          retryAfter: DEFAULT_RATE_LIMIT_RETRY_AFTER_SEC, ...result,
        });
      }
      return res.status(httpStatus).json({ ok: false, exchange: ex, code, error: message, ...result });
    }
    res.json({ ok: true, exchange: ex, ...result });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/permissions — get API key permissions
router.post('/exchange/:exchange/permissions', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  logAction(ex, 'permissions', creds.apiKey);
  const adapter = getAdapter(ex)!;
  try {
    const perms = await adapter.getPermissions(creds);
    res.json({ ok: true, exchange: ex, permissions: perms });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/balances — fetch real balances
router.post('/exchange/:exchange/balances', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  logAction(ex, 'balances', creds.apiKey);
  const adapter = getAdapter(ex)!;
  try {
    const balances = await adapter.getBalances(creds);
    res.json({ ok: true, exchange: ex, balances });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/order/place — place a new order
router.post('/exchange/:exchange/order/place', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  const order   = req.body as OrderRequest;
  if (!order?.symbol || !order?.side || !order?.type || !order?.quantity) {
    return badRequest(res, 'Missing order fields: symbol, side, type, quantity');
  }
  // Propagate testnet flag from header into the order object
  const testnet = isTestnetRequest(req);
  const finalOrder: OrderRequest = { ...order, testnet };
  logAction(ex, `placeOrder(${order.side} ${order.quantity} ${order.symbol}${testnet ? ' [testnet]' : ''})`, creds.apiKey);
  const adapter = getAdapter(ex)!;
  try {
    const result = await adapter.placeOrder(creds, finalOrder);
    res.json({ ok: true, exchange: ex, order: result });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/order/test — validate an order WITHOUT placing it
// Returns the same shape as OrderTestResult: ok, reason, detail, exchangeCode,
// rules, echo (the formatted symbol/side/qty/price actually sent).  Adapters
// that implement testOrder() use the exchange's native test endpoint
// (e.g. Binance /api/v3/order/test); others fall back to a synthetic local
// check that still applies the symbol filters.
router.post('/exchange/:exchange/order/test', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  const order = req.body as OrderRequest;
  if (!order?.symbol || !order?.side || !order?.type || order?.quantity === undefined) {
    return badRequest(res, 'Missing required order fields (symbol, side, type, quantity)');
  }
  const testnet = isTestnetRequest(req);
  const finalOrder: OrderRequest = { ...order, testnet };
  logAction(ex, `testOrder(${order.side} ${order.quantity} ${order.symbol}${testnet ? ' [testnet]' : ''})`, creds.apiKey);
  const adapter = getAdapter(ex)!;
  try {
    if (typeof adapter.testOrder === 'function') {
      const result = await adapter.testOrder(creds, finalOrder);
      return res.json({ ok: true, exchange: ex, test: result });
    }
    // Fallback synthetic check: fetch rules and validate locally.
    const rules = await adapter.getSymbolRules(creds, order.symbol);
    const qty   = Number(order.quantity);
    const price = Number(order.price ?? 0);
    if (qty <= 0)  return res.json({ ok: true, exchange: ex, test: { ok: false, reason: 'LOT_SIZE',  detail: `Quantity ${qty} is invalid.`, rules } });
    if (qty < rules.minQty)
      return res.json({ ok: true, exchange: ex, test: { ok: false, reason: 'LOT_SIZE',  detail: `Quantity ${qty} below minQty ${rules.minQty}.`, rules } });
    if (price > 0 && rules.minNotional > 0 && qty * price < rules.minNotional)
      return res.json({ ok: true, exchange: ex, test: { ok: false, reason: 'MIN_NOTIONAL', detail: `Notional $${(qty*price).toFixed(2)} below minNotional $${rules.minNotional}.`, rules } });
    return res.json({ ok: true, exchange: ex, test: { ok: true, rules, detail: 'Local preflight passed (exchange-side native test not implemented for this adapter).' } });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/order/cancel — cancel an order
router.post('/exchange/:exchange/order/cancel', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  const { orderId, symbol } = req.body as { orderId: string; symbol?: string };
  if (!orderId) return badRequest(res, 'Missing orderId');
  logAction(ex, `cancelOrder(${orderId})`, creds.apiKey);
  const adapter = getAdapter(ex)!;
  try {
    const ok = await adapter.cancelOrder(creds, orderId, symbol);
    res.json({ ok, exchange: ex });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/orders/history — get order history
router.post('/exchange/:exchange/orders/history', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  const { symbol, limit = 50 } = req.body as { symbol?: string; limit?: number };
  logAction(ex, `orderHistory(${symbol ?? 'all'})`, creds.apiKey);
  const adapter = getAdapter(ex)!;
  try {
    const orders = await adapter.getOrderHistory(creds, symbol, limit);
    res.json({ ok: true, exchange: ex, orders });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/order/get — get single order
router.post('/exchange/:exchange/order/get', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  const { orderId, symbol } = req.body as { orderId: string; symbol?: string };
  if (!orderId) return badRequest(res, 'Missing orderId');
  const adapter = getAdapter(ex)!;
  try {
    const order = await adapter.getOrder(creds, orderId, symbol);
    res.json({ ok: true, exchange: ex, order });
  } catch (e) { serverError(res, ex, e); }
});

// GET /api/exchange/:exchange/price/:symbol — public ticker price (no auth required)
router.get('/exchange/:exchange/price/:symbol', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const symbol  = String(req.params['symbol'] ?? '');
  if (!symbol) return badRequest(res, 'Missing symbol');
  const adapter = getAdapter(ex)!;
  try {
    const price = await adapter.getPrice(symbol);
    res.json({ ok: true, exchange: ex, symbol, price });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/diagnostic — run a full transparent permission/IP check
// Currently only the Binance adapter implements this richly; for other adapters
// we synthesize a best-effort report from validateCredentials so the UI panel
// works uniformly for every exchange.
router.post('/exchange/:exchange/diagnostic', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  logAction(ex, 'diagnostic', creds.apiKey);
  const adapter = getAdapter(ex)!;
  const adapterAny = adapter as unknown as {
    runDiagnostic?: (c: typeof creds) => Promise<unknown>;
  };
  try {
    if (typeof adapterAny.runDiagnostic === 'function') {
      const diag = await adapterAny.runDiagnostic(creds);
      return res.json({ ok: true, exchange: ex, diagnostic: diag });
    }
    // Best-effort fallback for adapters without a dedicated diagnostic.
    const r = await adapter.validateCredentials(creds);
    return res.json({
      ok: true, exchange: ex,
      diagnostic: {
        exchange: ex, apiKeyMasked: maskKey(creds.apiKey), testnet: !!creds.testnet,
        permissions: r.permissions,
        steps: [{
          step: 'Credential validation', ok: r.success,
          detail: r.success ? 'Credentials accepted' : (r.error ?? 'Validation failed'),
        }],
        recommendation: r.success ? undefined : 'Re-check API key, secret, and IP whitelist on the exchange.',
        timestamp: Date.now(),
      },
    });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/self-test — run ping + signed account + test order
router.post('/exchange/:exchange/self-test', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  logAction(ex, 'self-test', creds.apiKey);
  const adapter = getAdapter(ex)!;
  const adapterAny = adapter as unknown as {
    runSelfTest?: (c: typeof creds) => Promise<unknown>;
  };
  try {
    if (typeof adapterAny.runSelfTest === 'function') {
      const result = await adapterAny.runSelfTest(creds);
      return res.json({ ok: true, exchange: ex, selfTest: result });
    }
    return res.status(501).json({
      ok: false, exchange: ex,
      error: `Self-test is not yet implemented for ${ex}. Use the standard validate + balance flow instead.`,
    });
  } catch (e) { serverError(res, ex, e); }
});

// POST /api/exchange/:exchange/symbol/rules — get symbol trading rules
router.post('/exchange/:exchange/symbol/rules', async (req, res) => {
  const ex      = requireExchange(req, res); if (!ex) return;
  const creds   = extractCreds(req);
  if (!creds) return badRequest(res, 'Missing API credentials');
  const { symbol } = req.body as { symbol: string };
  if (!symbol) return badRequest(res, 'Missing symbol');
  const adapter = getAdapter(ex)!;
  try {
    const rules = await adapter.getSymbolRules(creds, symbol);
    res.json({ ok: true, exchange: ex, rules });
  } catch (e) { serverError(res, ex, e); }
});

export default router;
