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
