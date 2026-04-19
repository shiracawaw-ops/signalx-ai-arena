import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enrichBalancesWithUsdtValue,
  withUsdtValue,
  _resetUsdtPriceCacheForTests,
} from './exchange-error.js';

beforeEach(() => {
  _resetUsdtPriceCacheForTests();
});

describe('withUsdtValue', () => {
  it('sets usdtValue = total for stable coins', () => {
    const out = withUsdtValue({ asset: 'USDT', available: 100, hold: 0, total: 100 });
    expect(out.usdtValue).toBe(100);
  });

  it('treats stable-coin asset symbols case-insensitively', () => {
    const out = withUsdtValue({ asset: 'usdc', available: 50, hold: 0, total: 50 });
    expect(out.usdtValue).toBe(50);
  });

  it('leaves usdtValue undefined for non-stable coins', () => {
    const out = withUsdtValue({ asset: 'BTC', available: 1, hold: 0, total: 1 });
    expect(out.usdtValue).toBeUndefined();
  });
});

describe('enrichBalancesWithUsdtValue', () => {
  it('passes stable-coin balances through unchanged (uses pre-set usdtValue)', async () => {
    const getPrice = vi.fn();
    const out = await enrichBalancesWithUsdtValue(
      'binance',
      [withUsdtValue({ asset: 'USDT', available: 100, hold: 0, total: 100 })],
      getPrice,
    );
    expect(out[0]?.usdtValue).toBe(100);
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('multiplies total * price for non-stable coins', async () => {
    const getPrice = vi.fn().mockResolvedValue(60_000);
    const out = await enrichBalancesWithUsdtValue(
      'binance',
      [{ asset: 'BTC', total: 0.5, available: 0.5, hold: 0 } as { asset: string; total: number; usdtValue?: number }],
      getPrice,
    );
    expect(out[0]?.usdtValue).toBe(30_000);
    expect(getPrice).toHaveBeenCalledExactlyOnceWith('BTC');
  });

  it('leaves usdtValue undefined when getPrice rejects', async () => {
    const getPrice = vi.fn().mockRejectedValue(new Error('symbol not found'));
    const out = await enrichBalancesWithUsdtValue(
      'binance',
      [{ asset: 'FOO', total: 10 } as { asset: string; total: number; usdtValue?: number }],
      getPrice,
    );
    expect(out[0]?.usdtValue).toBeUndefined();
  });

  it('leaves usdtValue undefined when getPrice returns 0 or non-finite', async () => {
    const getPrice = vi.fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(Number.NaN);
    const out = await enrichBalancesWithUsdtValue(
      'binance',
      [
        { asset: 'AAA', total: 10 },
        { asset: 'BBB', total: 10 },
      ] as Array<{ asset: string; total: number; usdtValue?: number }>,
      getPrice,
    );
    expect(out[0]?.usdtValue).toBeUndefined();
    expect(out[1]?.usdtValue).toBeUndefined();
  });

  it('skips lookup for zero/negative totals', async () => {
    const getPrice = vi.fn();
    const out = await enrichBalancesWithUsdtValue(
      'binance',
      [{ asset: 'BTC', total: 0 } as { asset: string; total: number; usdtValue?: number }],
      getPrice,
    );
    expect(out[0]?.usdtValue).toBeUndefined();
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('reuses the cached price within the TTL window on subsequent calls', async () => {
    const getPrice = vi.fn().mockResolvedValue(2_000);
    const balances = [{ asset: 'ETH', total: 1 } as { asset: string; total: number; usdtValue?: number }];

    const first  = await enrichBalancesWithUsdtValue('binance', balances, getPrice);
    const second = await enrichBalancesWithUsdtValue('binance', balances, getPrice);

    expect(first[0]?.usdtValue).toBe(2_000);
    expect(second[0]?.usdtValue).toBe(2_000);
    expect(getPrice).toHaveBeenCalledTimes(1);
  });

  it('keeps the cache scoped per exchange (same asset on a different exchange triggers a new lookup)', async () => {
    const getPrice = vi.fn().mockResolvedValue(2_000);
    const balances = [{ asset: 'ETH', total: 1 } as { asset: string; total: number; usdtValue?: number }];

    await enrichBalancesWithUsdtValue('binance', balances, getPrice);
    await enrichBalancesWithUsdtValue('okx',     balances, getPrice);

    expect(getPrice).toHaveBeenCalledTimes(2);
  });
});
