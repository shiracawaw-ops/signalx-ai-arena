import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeBotCap,
  checkBotAllocation,
  commitBotAllocation,
  releaseBotAllocation,
  resetBotAllocation,
  getCommittedUSD,
  getCommittedForSymbol,
  snapshotBotAllocations,
} from './bot-allocation';

describe('bot-allocation', () => {
  beforeEach(() => resetBotAllocation());

  describe('computeBotCap', () => {
    it('multiplies tradeAmountUSD × maxOpenPositions', () => {
      expect(computeBotCap({ tradeAmountUSD: 100, maxOpenPositions: 3 })).toBe(300);
    });
    it('returns Infinity when maxOpenPositions = 0 (unlimited)', () => {
      expect(computeBotCap({ tradeAmountUSD: 100, maxOpenPositions: 0 })).toBe(Infinity);
    });
    it('returns 0 for invalid tradeAmountUSD', () => {
      expect(computeBotCap({ tradeAmountUSD: 0, maxOpenPositions: 3 })).toBe(0);
      expect(computeBotCap({ tradeAmountUSD: NaN, maxOpenPositions: 3 })).toBe(0);
    });
  });

  describe('checkBotAllocation', () => {
    const cfg = { tradeAmountUSD: 100, maxOpenPositions: 3 };

    it('allows the first trade up to the cap', () => {
      const r = checkBotAllocation({ botId: 'b1', symbol: 'BTC/USDT', amountUSD: 100, config: cfg });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.capUSD).toBe(300);
        expect(r.committedUSD).toBe(0);
        expect(r.remainingUSD).toBe(300);
      }
    });

    it('rejects when committed + new amount would exceed cap', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      commitBotAllocation('b1', 'ETH/USDT', 100);
      commitBotAllocation('b1', 'SOL/USDT', 100);
      const r = checkBotAllocation({ botId: 'b1', symbol: 'XRP/USDT', amountUSD: 100, config: cfg });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.committedUSD).toBe(300);
        expect(r.remainingUSD).toBe(0);
        expect(r.reason).toMatch(/cap reached/i);
      }
    });

    it('allows refill up to remaining headroom', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      commitBotAllocation('b1', 'ETH/USDT', 100);
      const r = checkBotAllocation({ botId: 'b1', symbol: 'SOL/USDT', amountUSD: 100, config: cfg });
      expect(r.ok).toBe(true);
    });

    it('always allows when botId is missing (manual orders)', () => {
      commitBotAllocation('b1', 'BTC/USDT', 9999);
      const r = checkBotAllocation({ botId: undefined, symbol: 'XRP/USDT', amountUSD: 5000, config: cfg });
      expect(r.ok).toBe(true);
    });

    it('always allows when maxOpenPositions = 0 (unlimited cap)', () => {
      const unlim = { tradeAmountUSD: 100, maxOpenPositions: 0 };
      commitBotAllocation('b1', 'BTC/USDT', 100_000);
      const r = checkBotAllocation({ botId: 'b1', symbol: 'XRP/USDT', amountUSD: 50_000, config: unlim });
      expect(r.ok).toBe(true);
    });

    it('isolates commitments across bots', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      commitBotAllocation('b1', 'ETH/USDT', 100);
      commitBotAllocation('b1', 'SOL/USDT', 100);
      // b1 is full, but b2 has its own cap
      const r = checkBotAllocation({ botId: 'b2', symbol: 'XRP/USDT', amountUSD: 100, config: cfg });
      expect(r.ok).toBe(true);
    });
  });

  describe('commit/release lifecycle', () => {
    const cfg = { tradeAmountUSD: 100, maxOpenPositions: 3 };

    it('release frees full headroom on a closing-sell (ratio=1)', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      commitBotAllocation('b1', 'ETH/USDT', 100);
      commitBotAllocation('b1', 'SOL/USDT', 100);
      releaseBotAllocation('b1', 'BTC/USDT', 1);
      expect(getCommittedForSymbol('b1', 'BTC/USDT')).toBe(0);
      expect(getCommittedUSD('b1')).toBe(200);
      const r = checkBotAllocation({ botId: 'b1', symbol: 'XRP/USDT', amountUSD: 100, config: cfg });
      expect(r.ok).toBe(true);
    });

    it('release with ratio=0.5 frees half a position', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      releaseBotAllocation('b1', 'BTC/USDT', 0.5);
      expect(getCommittedForSymbol('b1', 'BTC/USDT')).toBeCloseTo(50, 4);
      expect(getCommittedUSD('b1')).toBeCloseTo(50, 4);
    });

    it('release on unknown symbol is a no-op', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      releaseBotAllocation('b1', 'NOPE/USDT', 1);
      expect(getCommittedUSD('b1')).toBe(100);
    });

    it('multiple commits to the same symbol stack', () => {
      commitBotAllocation('b1', 'BTC/USDT', 50);
      commitBotAllocation('b1', 'BTC/USDT', 50);
      expect(getCommittedForSymbol('b1', 'BTC/USDT')).toBe(100);
    });

    it('snapshot returns rounded per-bot positions', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      commitBotAllocation('b1', 'ETH/USDT', 50);
      commitBotAllocation('b2', 'SOL/USDT', 75);
      const snap = snapshotBotAllocations();
      expect(snap.length).toBe(2);
      const b1 = snap.find(s => s.botId === 'b1');
      expect(b1?.totalUSD).toBe(150);
      expect(b1?.positions.length).toBe(2);
    });

    it('reset wipes all commitments', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      commitBotAllocation('b2', 'ETH/USDT', 50);
      resetBotAllocation();
      expect(getCommittedUSD('b1')).toBe(0);
      expect(getCommittedUSD('b2')).toBe(0);
    });

    it('reset with botId only wipes that bot', () => {
      commitBotAllocation('b1', 'BTC/USDT', 100);
      commitBotAllocation('b2', 'ETH/USDT', 50);
      resetBotAllocation('b1');
      expect(getCommittedUSD('b1')).toBe(0);
      expect(getCommittedUSD('b2')).toBe(50);
    });
  });

  describe('integration: cap-then-release-then-refill', () => {
    it('lets a bot cycle through 3 trades when one closes', () => {
      const cfg = { tradeAmountUSD: 100, maxOpenPositions: 3 };
      commitBotAllocation('b1', 'BTC/USDT', 100);
      commitBotAllocation('b1', 'ETH/USDT', 100);
      commitBotAllocation('b1', 'SOL/USDT', 100);
      // Try a 4th — blocked
      expect(checkBotAllocation({ botId: 'b1', symbol: 'XRP/USDT', amountUSD: 100, config: cfg }).ok).toBe(false);
      // Close BTC
      releaseBotAllocation('b1', 'BTC/USDT', 1);
      // Now XRP fits
      expect(checkBotAllocation({ botId: 'b1', symbol: 'XRP/USDT', amountUSD: 100, config: cfg }).ok).toBe(true);
    });
  });
});
