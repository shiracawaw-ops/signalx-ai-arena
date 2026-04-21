import { describe, it, expect } from 'vitest';
import { allocateCapital } from './capital-allocator';
import type { AssetStudy } from './asset-study';

function study(id: string, overrides: Partial<AssetStudy> = {}): AssetStudy {
  return {
    botId: id, botName: `Bot-${id}`, arenaSymbol: 'BTC',
    exchange: 'binance', exchangeSymbol: 'BTCUSDT',
    tradable: true, signal: 'BUY', signalScore: 5,
    rsi: 50, trend: 'flat',
    recentWinRate: 60, recentTrades: 10, avgPnl: 1,
    capitalFit: 'ok', estimatedQty: 1, notionalUSD: 100,
    verdict: 'ready', recommendation: '', confidence: 70,
    studiedAt: Date.now(),
    ...overrides,
  };
}

describe('allocateCapital — deployable cap invariant', () => {
  it('never deploys more than the deployable budget when minPer would force overflow', () => {
    const studies = Array.from({ length: 10 }, (_, i) => study(`b${i}`));
    const plan = allocateCapital({
      totalCapitalUSD: 100,
      studies,
      minPerBot:  10,
      reservePct: 0.10,
      capitalUsagePct: 50, // usable=50, deployable=45
    });
    const sum = plan.allocations.reduce((a, b) => a + b.amountUSD, 0);
    expect(sum).toBeLessThanOrEqual(45 + 0.01);
    expect(plan.deployedUSD).toBeLessThanOrEqual(45 + 0.01);
    // Bots that didn't fit must be in skipped, not allocated.
    expect(plan.allocations.length + plan.skipped.length).toBe(studies.length);
  });

  it('respects capitalUsagePct strictly — total deployed <= rawTotal * usage * (1-safety)', () => {
    const studies = [study('a'), study('b'), study('c')];
    const plan = allocateCapital({
      totalCapitalUSD: 1000,
      studies,
      minPerBot:  10,
      reservePct: 0.10,
      capitalUsagePct: 25, // usable=250, deployable=225
    });
    const sum = plan.allocations.reduce((a, b) => a + b.amountUSD, 0);
    expect(sum).toBeLessThanOrEqual(225 + 0.05);
  });

  it('returns no allocations when deployable < minPer for even one bot', () => {
    const studies = [study('a')];
    const plan = allocateCapital({
      totalCapitalUSD: 5,
      studies,
      minPerBot:  10,
      reservePct: 0.10,
      capitalUsagePct: 100,
    });
    expect(plan.allocations).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.deployedUSD).toBe(0);
  });

  it('legacy callers (no capitalUsagePct) keep the old 100% behaviour', () => {
    const studies = [study('a'), study('b')];
    const plan = allocateCapital({
      totalCapitalUSD: 1000,
      studies,
      minPerBot:  10,
      maxPerBot:  900,        // lift the default 35% ceiling for this test
      reservePct: 0.10,
    });
    const sum = plan.allocations.reduce((a, b) => a + b.amountUSD, 0);
    expect(sum).toBeGreaterThan(800);     // most of $900 deployable used
    expect(sum).toBeLessThanOrEqual(900 + 0.05);
  });
});
