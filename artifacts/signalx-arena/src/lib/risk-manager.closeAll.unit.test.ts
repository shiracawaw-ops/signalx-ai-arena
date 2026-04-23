import { describe, expect, it } from 'vitest';
import { validateRisk, type SymbolRules } from './risk-manager.js';
import type { TradeConfig } from './trade-config.js';

const RULES: SymbolRules = {
  symbol:      'XRPUSDT',
  minQty:      0.0001,
  maxQty:      1e9,
  stepSize:    0.0001,
  minNotional: 5,
  tickSize:    0.0001,
  baseCurrency:  'XRP',
  quoteCurrency: 'USDT',
};

const CFG: TradeConfig = {
  exchange:           'binance',
  tradeAmountUSD:     10,
  maxDailyTrades:     0,
  maxOpenPositions:   0,
  stopLossPct:        0,
  takeProfitPct:      0,
  cooldownSeconds:    0,
  allowedSymbols:     [],
  onlyLong:           false,
  emergencyStop:      false,
  orderType:          'market',
  pollTimeoutSeconds: { manual: 30, autopilot: 30, bot: 30 },
};

describe('risk-manager — closeAll SELL behaviour', () => {
  it('without closeAll: SELL is sized from amountUSD/price, leaving residual when price has risen', () => {
    // Bought ~25 XRP at $0.40 ($10 notional). Price now $1.00 → owned still 25.
    // amountUSD/price = 10 / 1.00 = 10 XRP — SELL would only liquidate 10 of 25.
    const r = validateRisk({
      exchange:        'binance', symbol: 'XRPUSDT', side: 'sell',
      price:           1.00,
      amountUSD:       10,
      availableQuote:  0,
      availableBase:   25,
      openPositions:   0,
      dailyTradeCount: 0,
      lastTradeTs:     0,
      signalId:        't1',
      recentSignals:   [],
      symbolRules:     RULES,
      config:          CFG,
    });
    expect(r.ok).toBe(true);
    expect(r.quantity).toBe(10);                // BUG-shaped legacy behaviour preserved for manual sells
    expect(r.finalQty).toBe(10);
    expect(25 - (r.quantity ?? 0)).toBeGreaterThan(0); // 15 XRP residual stranded
  });

  it('with closeAll=true: SELL liquidates the FULL owned base balance regardless of amountUSD', () => {
    const r = validateRisk({
      exchange:        'binance', symbol: 'XRPUSDT', side: 'sell',
      price:           1.00,
      amountUSD:       10,        // would normally cap to 10 units…
      availableQuote:  0,
      availableBase:   25,        // …but we own 25 — closeAll must sell all 25.
      openPositions:   0,
      dailyTradeCount: 0,
      lastTradeTs:     0,
      signalId:        't2',
      recentSignals:   [],
      symbolRules:     RULES,
      config:          CFG,
      closeAll:        true,
    });
    expect(r.ok).toBe(true);
    expect(r.quantity).toBe(25);
    expect(r.finalQty).toBe(25);
    expect(r.notional).toBe(25);
  });

  it('with closeAll=true: rounds DOWN to stepSize so we never request more than free balance', () => {
    // Owned 25.00037; stepSize 0.0001 → must round to 25.0003.
    const r = validateRisk({
      exchange:        'binance', symbol: 'XRPUSDT', side: 'sell',
      price:           1.00,
      amountUSD:       10,
      availableQuote:  0,
      availableBase:   25.00037,
      openPositions:   0,
      dailyTradeCount: 0,
      lastTradeTs:     0,
      signalId:        't3',
      recentSignals:   [],
      symbolRules:     RULES,
      config:          CFG,
      closeAll:        true,
    });
    expect(r.ok).toBe(true);
    expect(r.quantity).toBe(25.0003);
    expect((r.quantity ?? 0) <= 25.00037).toBe(true);
  });

  it('with closeAll on BUY: ignored — BUY sizing is unchanged (closeAll is exit-only)', () => {
    const r = validateRisk({
      exchange:        'binance', symbol: 'XRPUSDT', side: 'buy',
      price:           1.00,
      amountUSD:       10,
      availableQuote:  100,
      availableBase:   25,
      openPositions:   0,
      dailyTradeCount: 0,
      lastTradeTs:     0,
      signalId:        't4',
      recentSignals:   [],
      symbolRules:     RULES,
      config:          CFG,
      closeAll:        true,
    });
    expect(r.ok).toBe(true);
    expect(r.quantity).toBe(10);   // BUY still sized from amountUSD
  });
});
