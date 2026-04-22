import { describe, expect, it } from 'vitest';

import { STABLE_ASSETS, isStable, stripStableSuffix } from './stable-assets';

describe('STABLE_ASSETS', () => {
  it('contains the well-known stablecoins', () => {
    for (const sym of ['USDT', 'USDC', 'DAI', 'FDUSD', 'BUSD', 'TUSD', 'USDP', 'USDD', 'USD']) {
      expect(STABLE_ASSETS.has(sym)).toBe(true);
    }
  });

  it('isStable is case-insensitive and rejects unknown / empty inputs', () => {
    expect(isStable('usdt')).toBe(true);
    expect(isStable('Usdc')).toBe(true);
    expect(isStable('BTC')).toBe(false);
    expect(isStable('')).toBe(false);
    expect(isStable(null)).toBe(false);
    expect(isStable(undefined)).toBe(false);
  });

  it('stripStableSuffix handles every quote convention and prefers longest match', () => {
    expect(stripStableSuffix('BTCUSDT')).toBe('BTC');
    expect(stripStableSuffix('BTC-USD')).toBe('BTC');
    expect(stripStableSuffix('BTCFDUSD')).toBe('BTC');
    expect(stripStableSuffix('BTCDAI')).toBe('BTC');
    expect(stripStableSuffix('BTC_USDC')).toBe('BTC');
    expect(stripStableSuffix('ETH/FDUSD')).toBe('ETH');
    expect(stripStableSuffix('SOLDAI')).toBe('SOL');
    expect(stripStableSuffix('btcusdt')).toBe('BTC');
    // FDUSD wins over USD — longest-first ordering is required.
    expect(stripStableSuffix('XYZFDUSD')).toBe('XYZ');
    // No stable suffix => returned upper-cased unchanged.
    expect(stripStableSuffix('BTCETH')).toBe('BTCETH');
  });
});
