import { describe, it, expect, beforeEach } from 'vitest';
import {
  botFleet,
  summarizeFleet,
  FLEET_MAX_BOTS,
} from './bot-fleet';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* noop */ }
  botFleet.reset();
});

describe('botFleet — config clamping', () => {
  it('caps maxBots at the platform limit (50)', () => {
    botFleet.set({ maxBots: 999 });
    expect(botFleet.get().maxBots).toBe(FLEET_MAX_BOTS);
  });

  it('floors maxBots at 1', () => {
    botFleet.set({ maxBots: 0 });
    expect(botFleet.get().maxBots).toBe(1);
  });

  it('shrinks activeRealBots when maxBots drops below it', () => {
    botFleet.set({ maxBots: 30, activeRealBots: 25 });
    botFleet.set({ maxBots: 10 });
    const c = botFleet.get();
    expect(c.maxBots).toBe(10);
    expect(c.activeRealBots).toBeLessThanOrEqual(10);
  });

  it('refuses activeRealBots > maxBots', () => {
    botFleet.set({ maxBots: 5, activeRealBots: 50 });
    expect(botFleet.get().activeRealBots).toBe(5);
  });

  it('defaults invalid remainingMode to paper', () => {
    botFleet.set({ remainingMode: 'banana' as never });
    expect(botFleet.get().remainingMode).toBe('paper');
  });
});

describe('botFleet — pickRealBots', () => {
  it('picks the first N existing bots in the supplied order', () => {
    botFleet.set({ activeRealBots: 3 });
    const bots = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
    const real = botFleet.pickRealBots(bots);
    expect(real).toEqual(['a', 'b', 'c']);
  });

  it('keeps previously-real bots stable across re-syncs', () => {
    botFleet.set({ activeRealBots: 2 });
    const round1 = ['x', 'y', 'z'].map(id => ({ id }));
    botFleet.syncRealBotIds(round1);
    expect(botFleet.get().realBotIds).toEqual(['x', 'y']);

    // Add new bots — original two should keep their slot.
    const round2 = ['x', 'y', 'z', 'q', 'r'].map(id => ({ id }));
    botFleet.syncRealBotIds(round2);
    expect(botFleet.get().realBotIds).toEqual(['x', 'y']);
  });

  it('drops stale IDs when bots disappear and backfills from the new list', () => {
    botFleet.set({ activeRealBots: 2 });
    botFleet.syncRealBotIds([{ id: 'x' }, { id: 'y' }]);
    botFleet.syncRealBotIds([{ id: 'y' }, { id: 'z' }]);
    expect(botFleet.get().realBotIds).toEqual(['y', 'z']);
  });
});

describe('summarizeFleet — validation', () => {
  it('flags a blocking error when balance is zero but real bots are active', () => {
    const cfg = { ...botFleet.get(), maxBots: 10, activeRealBots: 3 };
    const s = summarizeFleet({ cfg, totalBots: 5, realBalanceUSD: 0 });
    expect(s.blocking).toBe(true);
    expect(s.warnings.some(w => /Real balance is \$0/.test(w))).toBe(true);
  });

  it('flags a blocking error when per-bot allocation falls below minNotional', () => {
    const cfg = { ...botFleet.get(), maxBots: 50, activeRealBots: 50 };
    const s = summarizeFleet({
      cfg, totalBots: 50, realBalanceUSD: 100, minNotionalUSD: 10,
    });
    expect(s.blocking).toBe(true);
    expect(s.warnings.some(w => /below exchange minimum/.test(w))).toBe(true);
  });

  it('returns clean summary for a healthy config', () => {
    const cfg = { ...botFleet.get(), maxBots: 20, activeRealBots: 5, remainingMode: 'paper' as const };
    const s = summarizeFleet({
      cfg, totalBots: 20, realBalanceUSD: 50_000, minNotionalUSD: 10,
    });
    expect(s.blocking).toBe(false);
    expect(s.warnings).toHaveLength(0);
    expect(s.effectiveRealBots).toBe(5);
    expect(s.remainingBots).toBe(15);
    expect(s.allocationPerBot).toBeGreaterThan(10);
  });

  it('reports remainingBots according to the mode', () => {
    const cfg = { ...botFleet.get(), maxBots: 50, activeRealBots: 8, remainingMode: 'standby' as const };
    const s = summarizeFleet({
      cfg, totalBots: 50, realBalanceUSD: 10_000,
    });
    expect(s.remainingBots).toBe(42);
    expect(s.remainingMode).toBe('standby');
  });
});
