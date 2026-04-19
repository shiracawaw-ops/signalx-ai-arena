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
