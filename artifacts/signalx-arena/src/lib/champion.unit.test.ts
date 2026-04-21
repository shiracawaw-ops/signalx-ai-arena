import { describe, it, expect } from 'vitest';
import { rankBotsByRealPerformance, findChampion, cloneStrategyTo } from './champion.js';
import type { Bot } from './storage.js';

describe('rankBotsByRealPerformance', () => {
  it('excludes bots with too few trades', () => {
    const ranked = rankBotsByRealPerformance({
      a: { realizedPnlUSD: 100, feesPaidUSD: 1, trades: 1, wins: 1, losses: 0 },
    });
    expect(ranked).toHaveLength(0);
  });

  it('excludes bots with non-positive net', () => {
    const ranked = rankBotsByRealPerformance({
      a: { realizedPnlUSD: 5, feesPaidUSD: 10, trades: 5, wins: 1, losses: 4 },
      b: { realizedPnlUSD: 20, feesPaidUSD: 2,  trades: 5, wins: 4, losses: 1 },
    });
    expect(ranked.map(s => s.botId)).toEqual(['b']);
  });

  it('orders by score (net × winBias × (1-rejectRate))', () => {
    const ranked = rankBotsByRealPerformance(
      {
        small: { realizedPnlUSD: 12, feesPaidUSD: 2, trades: 5, wins: 3, losses: 2 },
        big:   { realizedPnlUSD: 60, feesPaidUSD: 5, trades: 10, wins: 7, losses: 3 },
      },
      { small: 0, big: 0.1 },
    );
    expect(ranked[0].botId).toBe('big');
    expect(ranked[1].botId).toBe('small');
  });
});

describe('findChampion', () => {
  it('returns null when no qualifying bot', () => {
    expect(findChampion({})).toBeNull();
  });

  it('returns champion + runners-up', () => {
    const r = findChampion({
      a: { realizedPnlUSD: 50, feesPaidUSD: 1, trades: 5, wins: 4, losses: 1 },
      b: { realizedPnlUSD: 20, feesPaidUSD: 1, trades: 5, wins: 3, losses: 2 },
    })!;
    expect(r.champion.botId).toBe('a');
    expect(r.runnersUp[0].botId).toBe('b');
  });
});

describe('cloneStrategyTo', () => {
  const champ: Bot = {
    id: 'champ', name: 'Champion', symbol: 'BTCUSDT', strategy: 'multi-signal',
    balance: 100, startingBalance: 100, position: 0, avgEntryPrice: 0,
    trades: [], isRunning: true, createdAt: 0, color: '#fff',
  };

  it('returns empty patch when cloning to self', () => {
    expect(cloneStrategyTo(champ, champ)).toEqual({});
  });

  it('copies only strategy, never balance / symbol', () => {
    const tgt: Bot = { ...champ, id: 'tgt', symbol: 'ETHUSDT', strategy: 'sma-cross', balance: 50 };
    const patch = cloneStrategyTo(champ, tgt);
    expect(patch).toEqual({ strategy: 'multi-signal' });
    expect(patch.symbol).toBeUndefined();
    expect(patch.balance).toBeUndefined();
  });
});
