import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';

const VALID_CREDS = {
  'x-api-key': 'test-api-key',
  'x-secret-key': 'test-secret-key',
};

const mockAdapter: Record<string, ReturnType<typeof vi.fn>> = {
  ping: vi.fn(),
  validateCredentials: vi.fn(),
  getPermissions: vi.fn(),
  getBalances: vi.fn(),
  placeOrder: vi.fn(),
  cancelOrder: vi.fn(),
  getOrderHistory: vi.fn(),
  getOrder: vi.fn(),
  getPrice: vi.fn(),
  getSymbolRules: vi.fn(),
};

beforeEach(() => {
  // Default: no native dust API on the mock adapter so the route falls
  // back to its "notSupported" path. Individual tests opt in by assigning
  // mockAdapter.sweepDust = vi.fn() before calling the endpoint.
  delete mockAdapter['sweepDust'];
});

vi.mock('../exchanges/registry.js', () => ({
  listAdapters: () => ['binance', 'okx', 'bybit'],
  isSupported: (ex: string) => ['binance', 'okx', 'bybit'].includes(ex),
  getAdapter: (ex: string) =>
    ['binance', 'okx', 'bybit'].includes(ex) ? mockAdapter : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GET /api/exchange ──────────────────────────────────────────────────────────

describe('GET /api/exchange', () => {
  it('returns list of supported exchanges', async () => {
    const res = await request(app).get('/api/exchange');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, exchanges: ['binance', 'okx', 'bybit'] });
  });
});

// ── GET /api/exchange/:exchange/ping ──────────────────────────────────────────

describe('GET /api/exchange/:exchange/ping', () => {
  it('returns latency for a supported exchange', async () => {
    mockAdapter.ping.mockResolvedValue(42);
    const res = await request(app).get('/api/exchange/binance/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, exchange: 'binance', latency: 42 });
  });

  it('returns 400 for an unsupported exchange', async () => {
    const res = await request(app).get('/api/exchange/unknown/ping');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/Unsupported exchange/);
  });

  it('returns 503 when the adapter throws a network error', async () => {
    mockAdapter.ping.mockRejectedValue(new Error('network timeout'));
    const res = await request(app).get('/api/exchange/binance/ping');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('network');
    expect(res.body.error).toBe('network timeout');
  });
});

// ── POST /api/exchange/:exchange/validate ─────────────────────────────────────

describe('POST /api/exchange/:exchange/validate', () => {
  it('returns ok:true when credentials are valid', async () => {
    mockAdapter.validateCredentials.mockResolvedValue({ success: true, permissions: ['read'] });
    const res = await request(app)
      .post('/api/exchange/binance/validate')
      .set(VALID_CREDS);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.permissions).toEqual(['read']);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app).post('/api/exchange/binance/validate');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/Missing API credentials/);
  });

  it('returns 400 for unsupported exchange', async () => {
    const res = await request(app)
      .post('/api/exchange/unknown/validate')
      .set(VALID_CREDS);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 502 when the adapter throws', async () => {
    mockAdapter.validateCredentials.mockRejectedValue(new Error('invalid key'));
    const res = await request(app)
      .post('/api/exchange/binance/validate')
      .set(VALID_CREDS);
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('invalid key');
  });
});

// ── POST /api/exchange/:exchange/balances ─────────────────────────────────────

describe('POST /api/exchange/:exchange/balances', () => {
  it('returns balances when credentials are valid', async () => {
    mockAdapter.getBalances.mockResolvedValue([{ asset: 'USDT', free: '100', locked: '0' }]);
    const res = await request(app)
      .post('/api/exchange/binance/balances')
      .set(VALID_CREDS);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.exchange).toBe('binance');
    expect(res.body.balances).toHaveLength(1);
    expect(res.body.balances[0].asset).toBe('USDT');
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app).post('/api/exchange/binance/balances');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 429 when the adapter throws a rate-limit error', async () => {
    mockAdapter.getBalances.mockRejectedValue(new Error('rate limit'));
    const res = await request(app)
      .post('/api/exchange/binance/balances')
      .set(VALID_CREDS);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limit');
    expect(res.body.error).toBe('rate limit');
  });
});

// ── POST /api/exchange/:exchange/orders/history ───────────────────────────────

describe('POST /api/exchange/:exchange/orders/history', () => {
  it('returns order history', async () => {
    const fakeOrders = [{ orderId: 'abc123', symbol: 'BTCUSDT', side: 'buy' }];
    mockAdapter.getOrderHistory.mockResolvedValue(fakeOrders);
    const res = await request(app)
      .post('/api/exchange/binance/orders/history')
      .set(VALID_CREDS)
      .send({ symbol: 'BTCUSDT', limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orders).toEqual(fakeOrders);
    expect(mockAdapter.getOrderHistory).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'test-api-key' }),
      'BTCUSDT',
      10,
    );
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app).post('/api/exchange/binance/orders/history');
    expect(res.status).toBe(400);
  });
});

// ── POST /api/exchange/:exchange/order/place ──────────────────────────────────

describe('POST /api/exchange/:exchange/order/place', () => {
  const validOrder = {
    symbol: 'BTCUSDT',
    side: 'buy',
    type: 'market',
    quantity: 0.001,
  };

  it('places an order and returns result', async () => {
    const fakeResult = { orderId: 'xyz789', status: 'FILLED' };
    mockAdapter.placeOrder.mockResolvedValue(fakeResult);
    const res = await request(app)
      .post('/api/exchange/binance/order/place')
      .set(VALID_CREDS)
      .send(validOrder);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.order).toEqual(fakeResult);
  });

  it('returns 400 when order fields are missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/order/place')
      .set(VALID_CREDS)
      .send({ symbol: 'BTCUSDT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing order fields/);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/order/place')
      .send(validOrder);
    expect(res.status).toBe(400);
  });

  it('propagates testnet flag into order', async () => {
    mockAdapter.placeOrder.mockResolvedValue({ orderId: 't1' });
    await request(app)
      .post('/api/exchange/binance/order/place')
      .set({ ...VALID_CREDS, 'x-testnet': '1' })
      .send(validOrder);
    expect(mockAdapter.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ testnet: true }),
      expect.objectContaining({ testnet: true }),
    );
  });
});

// ── POST /api/exchange/:exchange/order/cancel ─────────────────────────────────

describe('POST /api/exchange/:exchange/order/cancel', () => {
  it('cancels an order successfully', async () => {
    mockAdapter.cancelOrder.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/exchange/binance/order/cancel')
      .set(VALID_CREDS)
      .send({ orderId: 'abc123', symbol: 'BTCUSDT' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.exchange).toBe('binance');
  });

  it('returns 400 when orderId is missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/order/cancel')
      .set(VALID_CREDS)
      .send({ symbol: 'BTCUSDT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing orderId/);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/order/cancel')
      .send({ orderId: 'abc123' });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/exchange/:exchange/permissions ──────────────────────────────────

describe('POST /api/exchange/:exchange/permissions', () => {
  it('returns permissions for valid credentials', async () => {
    mockAdapter.getPermissions.mockResolvedValue(['read', 'trade']);
    const res = await request(app)
      .post('/api/exchange/binance/permissions')
      .set(VALID_CREDS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, exchange: 'binance', permissions: ['read', 'trade'] });
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app).post('/api/exchange/binance/permissions');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 403 when the adapter throws a permission error', async () => {
    mockAdapter.getPermissions.mockRejectedValue(new Error('forbidden'));
    const res = await request(app)
      .post('/api/exchange/binance/permissions')
      .set(VALID_CREDS);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission');
    expect(res.body.error).toBe('forbidden');
  });
});

// ── POST /api/exchange/:exchange/order/get ────────────────────────────────────

describe('POST /api/exchange/:exchange/order/get', () => {
  it('returns a single order by id', async () => {
    const fakeOrder = { orderId: 'abc123', status: 'FILLED', symbol: 'BTCUSDT' };
    mockAdapter.getOrder.mockResolvedValue(fakeOrder);
    const res = await request(app)
      .post('/api/exchange/binance/order/get')
      .set(VALID_CREDS)
      .send({ orderId: 'abc123', symbol: 'BTCUSDT' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, exchange: 'binance', order: fakeOrder });
  });

  it('returns 400 when orderId is missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/order/get')
      .set(VALID_CREDS)
      .send({ symbol: 'BTCUSDT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing orderId/);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/order/get')
      .send({ orderId: 'abc123' });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/exchange/:exchange/symbol/rules ─────────────────────────────────

describe('POST /api/exchange/:exchange/symbol/rules', () => {
  it('returns trading rules for a symbol', async () => {
    const fakeRules = { minQty: 0.001, tickSize: 0.01, stepSize: 0.001 };
    mockAdapter.getSymbolRules.mockResolvedValue(fakeRules);
    const res = await request(app)
      .post('/api/exchange/binance/symbol/rules')
      .set(VALID_CREDS)
      .send({ symbol: 'BTCUSDT' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, exchange: 'binance', rules: fakeRules });
  });

  it('returns 400 when symbol is missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/symbol/rules')
      .set(VALID_CREDS)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing symbol/);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/symbol/rules')
      .send({ symbol: 'BTCUSDT' });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/exchange/:exchange/dust/sweep ──────────────────────────────────

describe('POST /api/exchange/:exchange/dust/sweep', () => {
  it('returns notSupported with helpUrl when adapter has no dust API', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/dust/sweep')
      .set(VALID_CREDS)
      .send({ assets: ['BNB', 'SHIB'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.notSupported).toBe(true);
    expect(typeof res.body.helpUrl).toBe('string');
    expect(res.body.message).toMatch(/dust/i);
  });

  it('proxies the sweep result when the adapter implements sweepDust', async () => {
    mockAdapter['sweepDust'] = vi.fn().mockResolvedValue({
      exchange: 'binance', swept: ['SHIB'], failed: [{ asset: 'BNB', reason: 'Above threshold' }],
      totalReceived: 0.0001, receivedAsset: 'BNB',
    });
    const res = await request(app)
      .post('/api/exchange/binance/dust/sweep')
      .set(VALID_CREDS)
      .send({ assets: ['BNB', 'SHIB'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sweep.swept).toEqual(['SHIB']);
    expect(res.body.sweep.failed[0]).toEqual({ asset: 'BNB', reason: 'Above threshold' });
    expect(mockAdapter['sweepDust']).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'test-api-key' }),
      ['BNB', 'SHIB'],
    );
  });

  it('returns 400 when assets array is missing or empty', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/dust/sweep')
      .set(VALID_CREDS)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app)
      .post('/api/exchange/binance/dust/sweep')
      .send({ assets: ['BNB'] });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ── GET /api/exchange/:exchange/price/:symbol ─────────────────────────────────

describe('GET /api/exchange/:exchange/price/:symbol', () => {
  it('returns price for a symbol', async () => {
    mockAdapter.getPrice.mockResolvedValue(67000.5);
    const res = await request(app).get('/api/exchange/binance/price/BTCUSDT');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, exchange: 'binance', symbol: 'BTCUSDT', price: 67000.5 });
  });

  it('returns 400 for unsupported exchange', async () => {
    const res = await request(app).get('/api/exchange/unknown/price/BTCUSDT');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 502 when adapter throws', async () => {
    mockAdapter.getPrice.mockRejectedValue(new Error('symbol not found'));
    const res = await request(app).get('/api/exchange/binance/price/INVALID');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('symbol not found');
  });
});
