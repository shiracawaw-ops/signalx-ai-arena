import { describe, it, expect } from 'vitest';
import { diagnoseReal, summarizeReal } from './real-mode-diagnostics.js';
import type { BotActivityState } from './bot-activity-store.js';
import type { RealProfitState }   from './real-profit-store.js';
import type { BenchEntry }        from './bot-doctor-store.js';

function bot(id: string, partial: Partial<BotActivityState['bots'][string]> = {}) {
  return {
    botId: id, eligibleNow: true,
    lastAttemptTs: 0, lastSuccessTs: 0, lastRejectTs: 0,
    recent: [],
    ...partial,
  };
}

function activityState(bots: Record<string, ReturnType<typeof bot>>): BotActivityState {
  return {
    bots,
    totals: { totalBots: Object.keys(bots).length, eligibleForReal: 0, activeNow: 0, executedRealToday: 0, standby: 0, blocked: 0 },
    lastUpdated: Date.now(),
  };
}

function emptyProfit(): RealProfitState {
  return {
    startingBalanceUSD: 0, currentEquityUSD: 0,
    realizedPnlUSD: 0, feesPaidUSD: 0, unrealizedPnlUSD: 0,
    winsClosed: 0, lossesClosed: 0,
    perBot: {}, lots: {}, closedTrades: [], lastUpdated: 0,
  };
}

const noBench = () => false;
const noEntry = (): BenchEntry | undefined => undefined;

describe('diagnoseReal', () => {
  it('returns HEALTHY shape for a clean eligible bot with no attempts', () => {
    const a = activityState({ b1: bot('b1', { eligibleNow: true }) });
    const d = diagnoseReal({ activity: a, profit: emptyProfit(), isBenched: noBench, benchEntry: noEntry });
    expect(d).toHaveLength(1);
    // Inactive eligible — info-level only, no critical
    expect(d[0].issues.find(i => i.code === 'INACTIVE_ELIGIBLE')).toBeDefined();
    expect(d[0].issues.find(i => i.level === 'critical')).toBeUndefined();
  });

  it('flags ADAPTER_NOT_READY after repeated adapter rejects', () => {
    const recent = Array.from({ length: 3 }, () => ({
      ts: Date.now(), kind: 'reject' as const, reason: 'adapter_not_ready', detail: 'down',
    }));
    const a = activityState({ b1: bot('b1', { recent, lastRejectTs: Date.now(), lastRejectCode: 'adapter_not_ready' }) });
    const d = diagnoseReal({ activity: a, profit: emptyProfit(), isBenched: noBench, benchEntry: noEntry });
    expect(d[0].issues.find(i => i.code === 'ADAPTER_NOT_READY')?.level).toBe('critical');
  });

  it('flags COOLDOWN_SPAM when many cooldown-class rejects', () => {
    const recent = Array.from({ length: 5 }, () => ({
      ts: Date.now(), kind: 'reject' as const, reason: 'cooldown_active', detail: 'cd',
    }));
    const a = activityState({ b1: bot('b1', { recent, lastRejectTs: Date.now() }) });
    const d = diagnoseReal({ activity: a, profit: emptyProfit(), isBenched: noBench, benchEntry: noEntry });
    expect(d[0].issues.find(i => i.code === 'COOLDOWN_SPAM')).toBeDefined();
  });

  it('flags DUST_UNSELLABLE on min_notional reject', () => {
    const recent = [{ ts: Date.now(), kind: 'reject' as const, reason: 'min_notional_below', detail: 'too small' }];
    const a = activityState({ b1: bot('b1', { recent, lastRejectTs: Date.now() }) });
    const d = diagnoseReal({ activity: a, profit: emptyProfit(), isBenched: noBench, benchEntry: noEntry });
    expect(d[0].issues.find(i => i.code === 'DUST_UNSELLABLE')).toBeDefined();
  });

  it('flags HIGH_REJECT_RATE on generic reject storm', () => {
    const recent = Array.from({ length: 10 }, (_, i) => ({
      ts: Date.now() - i, kind: (i < 8 ? 'reject' : 'success') as 'reject' | 'success', reason: i < 8 ? 'exchange_rejected' : undefined,
    }));
    const a = activityState({ b1: bot('b1', { recent }) });
    const d = diagnoseReal({ activity: a, profit: emptyProfit(), isBenched: noBench, benchEntry: noEntry });
    expect(d[0].issues.find(i => i.code === 'HIGH_REJECT_RATE')?.level).toBe('critical');
  });

  it('flags UNDERPERFORMING_REAL after 5+ trades with negative net', () => {
    const profit = emptyProfit();
    profit.perBot['b1'] = { realizedPnlUSD: -10, feesPaidUSD: 5, trades: 6, wins: 1, losses: 5 };
    const a = activityState({ b1: bot('b1', { lastSuccessTs: Date.now() }) });
    const d = diagnoseReal({ activity: a, profit, isBenched: noBench, benchEntry: noEntry });
    expect(d[0].issues.find(i => i.code === 'UNDERPERFORMING_REAL')).toBeDefined();
  });

  it('shows benched info when isBenched returns true', () => {
    const entry: BenchEntry = {
      botId: 'b1', code: 'high_reject_rate', reason: '90% rejected',
      benchedAt: Date.now(), expiresAt: Date.now() + 60_000,
    };
    const a = activityState({ b1: bot('b1') });
    const d = diagnoseReal({
      activity: a, profit: emptyProfit(),
      isBenched: id => id === 'b1',
      benchEntry: id => id === 'b1' ? entry : undefined,
    });
    expect(d[0].benched).toBe(true);
    expect(d[0].issues[0].title).toContain('Benched by Doctor');
  });

  it('flags ALLOCATION_STARVED for capital-starved eligible bot', () => {
    const a = activityState({ b1: bot('b1', { eligibleNow: true }) });
    const d = diagnoseReal({
      activity: a, profit: emptyProfit(), isBenched: noBench, benchEntry: noEntry,
      capitalStarved: new Set(['b1']),
    });
    expect(d[0].issues.find(i => i.code === 'ALLOCATION_STARVED')).toBeDefined();
  });
});

describe('summarizeReal', () => {
  it('counts levels correctly', () => {
    const recentReject = Array.from({ length: 10 }, () => ({ ts: Date.now(), kind: 'reject' as const, reason: 'exchange_rejected' }));
    const a = activityState({
      a: bot('a'),                                    // info only (inactive eligible)
      b: bot('b', { recent: recentReject }),           // critical (high reject)
    });
    const d = diagnoseReal({ activity: a, profit: emptyProfit(), isBenched: noBench, benchEntry: noEntry });
    const sum = summarizeReal(d);
    expect(sum.totalBots).toBe(2);
    expect(sum.withCriticalIssue).toBe(1);
    // 'a' has only info → counted as healthy bucket of (no critical, no warning)? No —
    // healthy = 0 issues; so a has issues (info) → not healthy. So healthy = 0.
    expect(sum.healthy).toBe(0);
  });
});
