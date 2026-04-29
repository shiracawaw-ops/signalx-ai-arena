import { beforeEach, describe, expect, it } from 'vitest';
import { realProfitStore, netRealized } from './real-profit-store';

describe('real-profit-store', () => {
  beforeEach(() => {
    realProfitStore.reset();
  });

  it('computes net realized from real fills and fees only', () => {
    realProfitStore.recordRealBuy({
      exchange: 'bybit',
      baseAsset: 'BTC',
      qty: 1,
      price: 100,
      feeUSD: 0.2,
      botId: 'b1',
    });
    realProfitStore.recordRealSell({
      exchange: 'bybit',
      baseAsset: 'BTC',
      qty: 1,
      price: 102,
      feeUSD: 0.2,
      botId: 'b1',
      botName: 'Bot 1',
    });
    const snap = realProfitStore.snapshot();
    // gross realized = +2.0, total fees = 0.4
    expect(snap.realizedPnlUSD).toBeCloseTo(2, 8);
    expect(snap.feesPaidUSD).toBeCloseTo(0.4, 8);
    expect(netRealized(snap)).toBeCloseTo(1.6, 8);
  });
});
