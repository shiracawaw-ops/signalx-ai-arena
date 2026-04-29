import { describe, it, expect } from 'vitest';
import { evaluateScalperOpportunity, type SmartScalperSnapshot } from './smart-scalper';

function mkSnapshot(overrides?: Partial<SmartScalperSnapshot>): SmartScalperSnapshot {
  const base1 = Array.from({ length: 40 }, (_, i) => {
    const px = 100 + i * 0.12;
    return { time: Date.now() - (40 - i) * 60_000, open: px - 0.08, high: px + 0.12, low: px - 0.12, close: px, volume: 1000 + i * 12 };
  });
  const base3 = Array.from({ length: 30 }, (_, i) => {
    const px = 99 + i * 0.25;
    return { time: Date.now() - (30 - i) * 180_000, open: px - 0.15, high: px + 0.22, low: px - 0.2, close: px, volume: 3000 + i * 25 };
  });
  const base5 = Array.from({ length: 30 }, (_, i) => {
    const px = 98 + i * 0.35;
    return { time: Date.now() - (30 - i) * 300_000, open: px - 0.2, high: px + 0.3, low: px - 0.25, close: px, volume: 5000 + i * 45 };
  });
  return {
    symbol: 'BTCUSDT',
    price: base1[base1.length - 1]!.close,
    timestamp: Date.now(),
    spreadPct: 0.04,
    candles: { '1m': base1, '3m': base3, '5m': base5 },
    ...overrides,
  };
}

describe('smart-scalper entry/exit rules', () => {
  it('blocks buy in flat/noisy market', () => {
    const flat = mkSnapshot({
      candles: {
        '1m': Array.from({ length: 35 }, (_, i) => ({
          time: Date.now() - (35 - i) * 60_000,
          open: 100,
          high: 100.02,
          low: 99.98,
          close: 100 + (i % 2 === 0 ? 0.005 : -0.005),
          volume: 50,
        })),
        '3m': Array.from({ length: 20 }, (_, i) => ({
          time: Date.now() - (20 - i) * 180_000,
          open: 100,
          high: 100.02,
          low: 99.98,
          close: 100 + (i % 2 === 0 ? 0.002 : -0.002),
          volume: 50,
        })),
        '5m': Array.from({ length: 20 }, (_, i) => ({
          time: Date.now() - (20 - i) * 300_000,
          open: 100,
          high: 100.02,
          low: 99.98,
          close: 100 + (i % 2 === 0 ? 0.002 : -0.002),
          volume: 50,
        })),
      },
    });
    const res = evaluateScalperOpportunity({
      symbol: 'BTC',
      side: 'buy',
      signalPrice: 100,
      notionalUSD: 100,
      confidence: 88,
      snapshot: flat,
      cooldownActive: false,
      duplicateSignal: false,
      hasOpenPosition: false,
      hourlyTradesOnSymbol: 0,
      maxTradesPerSymbolHour: 12,
      weakSignalLoop: false,
      takeProfitPct: 1.2,
      stopLossPct: 0.6,
      trailingStopPct: 0.4,
      symbolRulesMinNotional: 5,
    });
    expect(res.pass).toBe(false);
  });

  it('blocks buy when RSI is overbought', () => {
    const snap = mkSnapshot({
      candles: {
        '1m': Array.from({ length: 35 }, (_, i) => {
          const px = 100 + i * 1.0;
          return { time: Date.now() - (35 - i) * 60_000, open: px - 0.3, high: px + 0.5, low: px - 0.5, close: px, volume: 5000 };
        }),
        '3m': mkSnapshot().candles['3m'],
        '5m': mkSnapshot().candles['5m'],
      },
    });
    const res = evaluateScalperOpportunity({
      symbol: 'BTC',
      side: 'buy',
      signalPrice: snap.price,
      notionalUSD: 100,
      confidence: 90,
      snapshot: snap,
      cooldownActive: false,
      duplicateSignal: false,
      hasOpenPosition: false,
      hourlyTradesOnSymbol: 0,
      maxTradesPerSymbolHour: 12,
      weakSignalLoop: false,
      takeProfitPct: 1.2,
      stopLossPct: 0.6,
      trailingStopPct: 0.4,
      symbolRulesMinNotional: 5,
    });
    expect(res.pass).toBe(false);
    expect(res.reason).toBe('rsi_out_of_buy_band');
  });

  it('blocks duplicate same-symbol position for buy', () => {
    const res = evaluateScalperOpportunity({
      symbol: 'BTC',
      side: 'buy',
      signalPrice: 105,
      notionalUSD: 100,
      confidence: 85,
      snapshot: mkSnapshot(),
      cooldownActive: false,
      duplicateSignal: false,
      hasOpenPosition: true,
      hourlyTradesOnSymbol: 0,
      maxTradesPerSymbolHour: 12,
      weakSignalLoop: false,
      takeProfitPct: 1.2,
      stopLossPct: 0.6,
      trailingStopPct: 0.4,
      symbolRulesMinNotional: 5,
    });
    expect(res.pass).toBe(false);
    expect(res.reason).toBe('position_already_open');
  });

  it('blocks instant sell right after buy unless stop/risk exit', () => {
    const res = evaluateScalperOpportunity({
      symbol: 'BTC',
      side: 'sell',
      signalPrice: 100,
      notionalUSD: 100,
      confidence: 85,
      snapshot: mkSnapshot({ price: 100.1 }),
      cooldownActive: false,
      duplicateSignal: false,
      hasOpenPosition: true,
      hourlyTradesOnSymbol: 0,
      maxTradesPerSymbolHour: 12,
      weakSignalLoop: false,
      takeProfitPct: 1.2,
      stopLossPct: 0.6,
      trailingStopPct: 0.4,
      positionEntryPrice: 100,
      justOpenedAt: Date.now() - 10_000,
      symbolRulesMinNotional: 5,
    });
    expect(res.pass).toBe(false);
    expect(res.reason).toBe('early_exit_locked');
  });

  it('allows sell when TP/SL/trailing/emergency conditions trigger', () => {
    const tp = evaluateScalperOpportunity({
      symbol: 'BTC',
      side: 'sell',
      signalPrice: 101.5,
      notionalUSD: 100,
      confidence: 80,
      snapshot: mkSnapshot({ price: 101.5 }),
      cooldownActive: false,
      duplicateSignal: false,
      hasOpenPosition: true,
      hourlyTradesOnSymbol: 0,
      maxTradesPerSymbolHour: 12,
      weakSignalLoop: false,
      takeProfitPct: 1.2,
      stopLossPct: 0.6,
      trailingStopPct: 0.4,
      positionEntryPrice: 100,
      justOpenedAt: Date.now() - 180_000,
      symbolRulesMinNotional: 5,
    });
    expect(tp.pass).toBe(true);
    expect(tp.reason).toBe('sell_exit_confirmed');
  });
});
