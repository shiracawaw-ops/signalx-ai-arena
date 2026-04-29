import { describe, expect, it } from 'vitest';
import {
  evaluateBotStop,
  scoreReplacementCandidate,
  selectReplacementBot,
} from './smart-bot-replacement';

describe('smart-bot-replacement', () => {
  it('stops losing bot on 3 consecutive losses', () => {
    const stop = evaluateBotStop({
      netPnlUSD: -5,
      rejectionRate: 0.2,
      last10Net: [-1.2, -0.9, -0.4, 0.3],
    });
    expect(stop.stop).toBe(true);
    expect(stop.reasons.join('|')).toContain('consecutive_losses:3');
  });

  it('stops bot on drawdown > 1%', () => {
    const stop = evaluateBotStop({
      netPnlUSD: 4,
      rejectionRate: 0.1,
      drawdownPct: 1.4,
      last10Net: [2, -1, -2, 0.5],
    });
    expect(stop.stop).toBe(true);
    expect(stop.reasons.join('|')).toContain('drawdown:1.40%');
  });

  it('selects better replacement bot when qualified', () => {
    const best = selectReplacementBot([
      {
        botId: 'loser',
        trades: 12,
        realizedNetPnlUSD: -32,
        recentWinRate: 0.35,
        rejectionRate: 0.52,
        last10Net: [-3, -2, -1, 0.1],
      },
      {
        botId: 'winner-a',
        trades: 20,
        realizedNetPnlUSD: 46,
        recentWinRate: 0.91,
        rejectionRate: 0.08,
        stabilityScore: 0.88,
        complianceScore: 0.95,
        last10Net: [2.1, 1.8, 0.9, 0.7, 0.2],
      },
      {
        botId: 'winner-b',
        trades: 15,
        realizedNetPnlUSD: 31,
        recentWinRate: 0.76,
        rejectionRate: 0.14,
        stabilityScore: 0.8,
        complianceScore: 0.86,
        last10Net: [1.1, 0.9, 0.7, 0.5],
      },
    ], 'loser');

    expect(best).toBeDefined();
    expect(best?.botId).toBe('winner-a');
    expect(best?.qualifies).toBe(true);
    expect((best?.confidence ?? 0) >= 75).toBe(true);
  });

  it('returns no replacement when nobody is qualified', () => {
    const best = selectReplacementBot([
      {
        botId: 'a',
        trades: 8,
        realizedNetPnlUSD: -2,
        recentWinRate: 0.5,
        rejectionRate: 0.4,
        last10Net: [0.1, -0.1, 0.1, -0.1],
      },
      {
        botId: 'b',
        trades: 4,
        realizedNetPnlUSD: 5,
        recentWinRate: 0.6,
        rejectionRate: 0.35,
        drawdownPct: 1.5,
        last10Net: [0.2, 0.1, -0.3, 0.1],
      },
    ], 'stopped');
    expect(best).toBeUndefined();
  });

  it('scores candidate confidence and penalties correctly', () => {
    const scored = scoreReplacementCandidate({
      botId: 'candidate',
      trades: 10,
      realizedNetPnlUSD: 20,
      recentWinRate: 0.92,
      rejectionRate: 0.08,
      stabilityScore: 0.9,
      complianceScore: 0.95,
      spamRejectsRecent: 0,
      riskBreakRejectsRecent: 0,
      badEntryRejectsRecent: 0,
      last10Net: [1, 1, 0.8, 0.7, 0.4],
    });
    expect(scored.confidence).toBeGreaterThanOrEqual(75);
    expect(scored.qualifies).toBe(true);
    expect(scored.score).toBeGreaterThan(0);
  });
});
