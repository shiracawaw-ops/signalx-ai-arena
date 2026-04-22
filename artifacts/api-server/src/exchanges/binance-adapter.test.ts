import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BinanceAdapter } from './binance-adapter.js';
import { _resetUsdtPriceCacheForTests } from './exchange-error.js';

beforeEach(() => {
  _resetUsdtPriceCacheForTests();
  vi.restoreAllMocks();
});

function mockJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BinanceAdapter.getBalances', () => {
  it('fills in usdtValue for non-stable coins via getPrice and leaves stable coins as total', async () => {
    const adapter = new BinanceAdapter();

    vi.spyOn(adapter, 'getPrice').mockImplementation(async (symbol: string) => {
      if (symbol === 'BTC') return 50_000;
      throw new Error(`unexpected symbol ${symbol}`);
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        balances: [
          { asset: 'USDT', free: '250',  locked: '0' },
          { asset: 'BTC',  free: '0.5',  locked: '0' },
        ],
      }),
    );

    const balances = await adapter.getBalances({
      apiKey: 'k', secretKey: 's', testnet: false,
    });

    const usdt = balances.find(b => b.asset === 'USDT');
    const btc  = balances.find(b => b.asset === 'BTC');
    expect(usdt?.usdtValue).toBe(250);
    expect(btc?.usdtValue).toBe(25_000);
  });

  it('leaves usdtValue undefined when the price lookup fails', async () => {
    const adapter = new BinanceAdapter();

    vi.spyOn(adapter, 'getPrice').mockRejectedValue(new Error('symbol not found'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        balances: [{ asset: 'FOO', free: '10', locked: '0' }],
      }),
    );

    const balances = await adapter.getBalances({
      apiKey: 'k', secretKey: 's', testnet: false,
    });

    const foo = balances.find(b => b.asset === 'FOO');
    expect(foo?.total).toBe(10);
    expect(foo?.usdtValue).toBeUndefined();
  });
});

describe('BinanceAdapter.sweepDust', () => {
  const creds = { apiKey: 'k', secretKey: 's', testnet: false };

  it('returns testnet-unsupported failures without hitting the network', async () => {
    const adapter = new BinanceAdapter();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await adapter.sweepDust({ ...creds, testnet: true }, ['SHIB', 'DOGE']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.swept).toEqual([]);
    expect(out.failed).toEqual([
      { asset: 'SHIB', reason: 'TESTNET_UNSUPPORTED' },
      { asset: 'DOGE', reason: 'TESTNET_UNSUPPORTED' },
    ]);
  });

  it('parses transferResult and reports swept assets, fee, and total received BNB', async () => {
    const adapter = new BinanceAdapter();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        totalServiceCharge: '0.0001',
        totalTransfered: '0.0123',
        transferResult: [
          { fromAsset: 'SHIB', amount: '1000000', transferedAmount: '0.01', serviceChargeAmount: '0.0001', tranId: 1 },
        ],
      }),
    );
    const out = await adapter.sweepDust(creds, ['shib', 'BNB']);
    expect(out.swept).toEqual(['SHIB']);
    expect(out.failed).toEqual([
      { asset: 'BNB', reason: expect.stringMatching(/Not eligible|threshold/i) },
    ]);
    expect(out.totalReceived).toBeCloseTo(0.0123);
    expect(out.receivedAsset).toBe('BNB');
    expect(out.note).toMatch(/service charge/i);
  });

  it('maps a top-level API error to per-asset failures', async () => {
    const adapter = new BinanceAdapter();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: -2014, msg: 'API-key format invalid.' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      }),
    );
    const out = await adapter.sweepDust(creds, ['SHIB']);
    expect(out.swept).toEqual([]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].asset).toBe('SHIB');
    expect(out.failed[0].reason).toMatch(/API-key|invalid/i);
    expect(out.receivedAsset).toBe('BNB');
  });

  it('signs the request and sends one repeated asset param per coin', async () => {
    const adapter = new BinanceAdapter();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({ totalServiceCharge: '0', totalTransfered: '0', transferResult: [] }),
    );
    await adapter.sweepDust(creds, ['shib', 'SHIB', '  doge  ', '']);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = String(init.body);
    // Dedup + uppercased + trimmed; empties dropped
    expect(body.match(/asset=SHIB/g)?.length).toBe(1);
    expect(body.match(/asset=DOGE/g)?.length).toBe(1);
    expect(body).toMatch(/timestamp=\d+/);
    expect(body).toMatch(/&signature=[a-f0-9]{64}$/);
    expect((init.headers as Record<string, string>)['X-MBX-APIKEY']).toBe('k');
    expect((init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/x-www-form-urlencoded');
  });
});
