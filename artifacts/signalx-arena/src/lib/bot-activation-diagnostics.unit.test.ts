import { describe, expect, it, vi } from 'vitest';
import type { Bot, Trade } from './storage';
import { diagnoseBotActivations, summarizeHoldReasons } from './bot-activation-diagnostics';
import { botFleet } from './bot-fleet';
import { botActivityStore } from './bot-activity-store';

vi.mock('./bot-fleet', async () => {
  const actual = await vi.importActual<typeof import('./bot-fleet')>('./bot-fleet');
  return {
    ...actual,
    botFleet: {
      ...actual.botFleet,
      get: vi.fn(),
    },
  };
});

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'b1',
    name: 'Bot 1',
    symbol: 'BTC',
    strategy: 'RSI',
    balance: 1000,
    startingBalance: 1000,
    position: 0,
    avgEntryPrice: 0,
    trades: [],
    isRunning: true,
    createdAt: 0,
    color: '#0f0',
    ...overrides,
  };
}

function makeMarket(symbol: string, len = 60, start = 100): Record<string, Array<{ close: number; high: number; low: number; volume: number; time: number; open: number }>> {
  const candles = Array.from({ length: len }, (_, i) => {
    const base = start + i * 0.5;
    return {
      time: i * 60_000,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.2,
      volume: 1000 + i,
    };
  });
  return { [symbol]: candles };
}

describe('bot-activation-diagnostics', () => {
  it('flags confidence-below-threshold standby reason', () => {
    vi.mocked(botFleet.get).mockReturnValue({
      maxBots: 20,
      activeRealBots: 1,
      remainingMode: 'standby',
      capitalUsagePct: 25,
      assignmentMode: 'auto_best',
      realBotIds: ['b1'],
    });
    botActivityStore.reset();

    const bots = [makeBot()];
    const trades: Trade[] = [];
    const market = makeMarket('BTC', 60, 100);
    const diags = diagnoseBotActivations({ bots, trades, market });
    expect(diags).toHaveLength(1);
    expect(diags[0].standbyReasonCode).toBe('confidence_below_threshold');
    expect(diags[0].standbyReason).toContain('confidence below threshold');
  });

  it('maps price drift reject to drift-block standby reason', () => {
    vi.mocked(botFleet.get).mockReturnValue({
      maxBots: 20,
      activeRealBots: 1,
      remainingMode: 'standby',
      capitalUsagePct: 25,
      assignmentMode: 'auto_best',
      realBotIds: ['b1'],
    });
    botActivityStore.reset();
    botActivityStore.recordAttempt({
      botId: 'b1',
      kind: 'reject',
      symbol: 'BTC',
      reason: 'price_drift_too_large',
      detail: 'Signal/internal price drifted',
    });

    const bots = [makeBot()];
    const market = makeMarket('BTC', 60, 100);
    const diags = diagnoseBotActivations({ bots, trades: [], market });
    expect(diags[0].standbyReasonCode).toBe('drift_block');
  });

  it('summarizes hold reasons for UI headline', () => {
    const out = summarizeHoldReasons([
      { code: 'risk_gate_prevented_entry', message: 'Risk HIGH blocked BUY' },
      { code: 'market_regime_says_hold', message: 'Daily loss guard active' },
    ]);
    expect(out.summary).toContain('Risk HIGH blocked BUY');
    expect(out.summary).toContain('Daily loss guard active');
  });
});
