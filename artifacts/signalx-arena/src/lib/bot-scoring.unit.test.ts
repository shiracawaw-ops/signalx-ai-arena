import { describe, it, expect } from 'vitest';
import { scoreOneBot, scoreAllBots } from './bot-scoring';
import type { Bot, Trade } from './storage';

function bot(id: string, balance: number, start = 1000): Bot {
  return {
    id, name: `Bot-${id}`, symbol: 'BTC', strategy: 'rsi',
    balance, startingBalance: start,
    position: 0, avgEntryPrice: 0, trades: [],
    isRunning: false, createdAt: 0, color: '#0f0',
  };
}

function trade(botId: string, pnl: number, ts = 0): Trade {
  return {
    id: `${botId}-${ts}`, botId, symbol: 'BTC', type: 'BUY',
    price: 100, quantity: 1, timestamp: ts, pnl, indicators: '',
  };
}

describe('scoreOneBot', () => {
  it('returns a 50 (break-even) ROI score for a fresh bot with no trades', () => {
    const s = scoreOneBot(bot('a', 1000), []);
    expect(s.compositeScore!).toBeGreaterThan(40);
    expect(s.compositeScore!).toBeLessThan(80);
    expect(s.recentScore).toBe(0);
    expect(s.realizedPnl).toBe(0);
  });

  it('rewards a bot that has grown its balance', () => {
    const winners: Trade[] = Array.from({ length: 10 }, (_, i) => trade('a', 5, i));
    const a = scoreOneBot(bot('a', 1500), winners);
    const b = scoreOneBot(bot('b', 800), [trade('b', -10, 0), trade('b', -10, 1)]);
    expect(a.compositeScore!).toBeGreaterThan(b.compositeScore!);
    expect(a.recentScore).toBe(100); // all winners
    expect(b.recentScore).toBe(0);   // all losers
  });

  it('penalises drawdown via the stability score', () => {
    // bot c: smooth +1 every trade
    const smooth: Trade[] = Array.from({ length: 8 }, (_, i) => trade('c', 1, i));
    // bot d: same total pnl but with a deep dip
    const choppy: Trade[] = [
      trade('d', 5, 0), trade('d', 5, 1), trade('d', 5, 2),
      trade('d', -20, 3), // big dip
      trade('d', 5, 4), trade('d', 5, 5), trade('d', 5, 6), trade('d', 8, 7),
    ];
    const c = scoreOneBot(bot('c', 1008), smooth);
    const d = scoreOneBot(bot('d', 1018), choppy);
    expect(c.stabilityScore!).toBeGreaterThan(d.stabilityScore!);
  });
});

describe('scoreAllBots', () => {
  it('returns one score row per bot, preserving id order', () => {
    const bots = [bot('a', 1100), bot('b', 900), bot('c', 1000)];
    const out = scoreAllBots(bots, []);
    expect(out.map(s => s.id)).toEqual(['a', 'b', 'c']);
  });
});
