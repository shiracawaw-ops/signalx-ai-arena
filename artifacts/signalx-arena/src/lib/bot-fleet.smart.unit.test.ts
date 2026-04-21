import { describe, it, expect, beforeEach } from 'vitest';
import {
  botFleet,
  summarizeFleet,
  CAPITAL_USAGE_OPTIONS,
  type BotScore,
} from './bot-fleet';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* noop */ }
  botFleet.reset();
});

describe('FleetConfig — capital usage %', () => {
  it('defaults to a conservative usage and a smart assignment mode', () => {
    const c = botFleet.get();
    expect(CAPITAL_USAGE_OPTIONS).toContain(c.capitalUsagePct);
    expect(c.capitalUsagePct).toBeLessThanOrEqual(50);
    expect(c.assignmentMode).toBe('auto_best');
  });

  it('rejects invalid capitalUsagePct values and snaps back to default', () => {
    botFleet.set({ capitalUsagePct: 33 as 25 });
    expect(CAPITAL_USAGE_OPTIONS).toContain(botFleet.get().capitalUsagePct);
  });

  it('rejects unknown assignment modes', () => {
    botFleet.set({ assignmentMode: 'bogus' as never });
    expect(['manual', 'auto_best', 'auto_recent', 'auto_lowest_rejection', 'auto_highest_stability'])
      .toContain(botFleet.get().assignmentMode);
  });
});

describe('summarizeFleet — capital usage gate', () => {
  it('exposes usable / reserved capital split based on capitalUsagePct', () => {
    botFleet.set({ maxBots: 10, activeRealBots: 4, capitalUsagePct: 25 });
    const s = summarizeFleet({
      cfg: botFleet.get(), totalBots: 10, realBalanceUSD: 1000,
    });
    expect(s.totalBalanceUSD).toBe(1000);
    expect(s.usableCapitalUSD).toBe(250);    // 25% of 1000
    expect(s.reservedCapitalUSD).toBe(750);  // remaining 75%
    // deployable = usable * (1 - 10% safety) = 225
    expect(s.deployableUSD).toBeCloseTo(225, 2);
  });

  it('shrinks per-bot allocation when usage is dropped from 100% to 25%', () => {
    botFleet.set({ maxBots: 5, activeRealBots: 5, capitalUsagePct: 100 });
    const high = summarizeFleet({
      cfg: botFleet.get(), totalBots: 5, realBalanceUSD: 10_000, minNotionalUSD: 10,
    }).allocationPerBot;

    botFleet.set({ capitalUsagePct: 25 });
    const low = summarizeFleet({
      cfg: botFleet.get(), totalBots: 5, realBalanceUSD: 10_000, minNotionalUSD: 10,
    }).allocationPerBot;

    expect(low).toBeLessThan(high);
    expect(low).toBeCloseTo(high / 4, 1);
  });

  it('blocks trading when usage % cap drives per-bot below minNotional', () => {
    botFleet.set({ maxBots: 50, activeRealBots: 50, capitalUsagePct: 10 });
    const s = summarizeFleet({
      cfg: botFleet.get(), totalBots: 50, realBalanceUSD: 2000, minNotionalUSD: 10,
    });
    expect(s.blocking).toBe(true);
    expect(s.warnings.some(w => /below exchange minimum/.test(w))).toBe(true);
  });
});

describe('pickRealBotsScored — assignment modes', () => {
  const scores: BotScore[] = [
    { id: 'a', compositeScore: 30, recentScore: 90, rejectionRate: 0.50, stabilityScore: 20 },
    { id: 'b', compositeScore: 80, recentScore: 30, rejectionRate: 0.05, stabilityScore: 95 },
    { id: 'c', compositeScore: 60, recentScore: 60, rejectionRate: 0.10, stabilityScore: 70 },
    { id: 'd', compositeScore: 10, recentScore: 10, rejectionRate: 0.80, stabilityScore: 10 },
  ];

  it('auto_best ranks by composite score', () => {
    botFleet.set({ activeRealBots: 2, assignmentMode: 'auto_best' });
    expect(botFleet.pickRealBotsScored(scores)).toEqual(['b', 'c']);
  });

  it('auto_recent ranks by recent performance', () => {
    botFleet.set({ activeRealBots: 2, assignmentMode: 'auto_recent' });
    expect(botFleet.pickRealBotsScored(scores)).toEqual(['a', 'c']);
  });

  it('auto_lowest_rejection prefers bots with the cleanest fill record', () => {
    botFleet.set({ activeRealBots: 2, assignmentMode: 'auto_lowest_rejection' });
    expect(botFleet.pickRealBotsScored(scores)).toEqual(['b', 'c']);
  });

  it('auto_highest_stability picks bots with the smoothest equity', () => {
    botFleet.set({ activeRealBots: 2, assignmentMode: 'auto_highest_stability' });
    expect(botFleet.pickRealBotsScored(scores)).toEqual(['b', 'c']);
  });

  it('manual keeps the existing pinned IDs (insertion order)', () => {
    botFleet.set({ activeRealBots: 2, assignmentMode: 'manual' });
    // Pin a + d first.
    botFleet.syncRealBotIds([{ id: 'a' }, { id: 'd' }, { id: 'b' }, { id: 'c' }]);
    expect(botFleet.get().realBotIds).toEqual(['a', 'd']);
    // Re-sync with scores must NOT promote b/c past the pinned manual pair.
    botFleet.syncRealBotIds(scores);
    expect(botFleet.get().realBotIds).toEqual(['a', 'd']);
  });

  it('syncRealBotIds auto-detects score payloads and re-ranks', () => {
    botFleet.set({ activeRealBots: 2, assignmentMode: 'auto_best' });
    botFleet.syncRealBotIds(scores);
    expect(botFleet.get().realBotIds).toEqual(['b', 'c']);
  });
});
