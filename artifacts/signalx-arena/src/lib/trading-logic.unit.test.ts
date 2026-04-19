import { describe, it, expect, beforeEach } from 'vitest';
import { validateRisk } from './risk-manager.js';
import { REJECT } from './execution-log.js';
import { tradeConfig } from './trade-config.js';
import { exchangeMode } from './exchange-mode.js';
import type { SymbolRules } from './risk-manager.js';

const SYMBOL_RULES: SymbolRules = {
  symbol: 'BTCUSDT',
  minQty: 0.00001,
  maxQty: 9_000_000,
  stepSize: 0.00001,
  minNotional: 1,
  tickSize: 0.01,
};

function makeRiskInput(overrides: Partial<Parameters<typeof validateRisk>[0]> = {}) {
  const cfg = tradeConfig.get('binance');
  cfg.emergencyStop = false;
  cfg.onlyLong = false;
  cfg.maxDailyTrades = 0;
  cfg.cooldownSeconds = 0;

  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    side: 'buy' as const,
    price: 84_000,
    amountUSD: 1_000,
    availableUSD: 50_000,
    openPositions: 0,
    dailyTradeCount: 0,
    lastTradeTs: 0,
    signalId: `sig_${Math.random().toString(36).slice(2)}`,
    recentSignals: [],
    symbolRules: SYMBOL_RULES,
    config: cfg,
    ...overrides,
  };
}

describe('Risk Manager', () => {
  beforeEach(() => {
    const cfg = tradeConfig.get('binance');
    cfg.emergencyStop = false;
    cfg.onlyLong = false;
    cfg.maxDailyTrades = 0;
    cfg.cooldownSeconds = 0;
  });

  it('passes a valid order and computes the correct quantity', () => {
    const result = validateRisk(makeRiskInput());

    expect(result.ok).toBe(true);
    const expectedQty = 1_000 / 84_000;
    expect(result.quantity).toBeCloseTo(expectedQty, 4);
  });

  it('rejects when available balance is insufficient', () => {
    const result = validateRisk(makeRiskInput({ amountUSD: 10_000, availableUSD: 50 }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REJECT.INSUFFICIENT_BALANCE);
  });

  it('rejects when cooldown is still active', () => {
    const cfg = tradeConfig.get('binance');
    cfg.cooldownSeconds = 30;

    const result = validateRisk(makeRiskInput({
      lastTradeTs: Date.now() - 10_000,
      config: cfg,
    }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REJECT.COOLDOWN_ACTIVE);
  });

  it('rejects when daily trade limit is reached', () => {
    const cfg = tradeConfig.get('binance');
    cfg.maxDailyTrades = 5;

    const result = validateRisk(makeRiskInput({ dailyTradeCount: 5, config: cfg }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REJECT.MAX_DAILY_TRADES);
  });

  it('rejects a duplicate signal', () => {
    const signalId = 'dup_signal_xyz';
    const result = validateRisk(makeRiskInput({ signalId, recentSignals: [signalId] }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REJECT.DUPLICATE_SIGNAL);
  });

  it('rejects a sell order when only-long mode is enabled', () => {
    const cfg = tradeConfig.get('binance');
    cfg.onlyLong = true;

    const result = validateRisk(makeRiskInput({ side: 'sell', config: cfg }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REJECT.SYMBOL_BLOCKED);
  });

  it('rejects any order when emergency stop is active', () => {
    const cfg = tradeConfig.get('binance');
    cfg.emergencyStop = true;

    const result = validateRisk(makeRiskInput({ config: cfg }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REJECT.EMERGENCY_STOP);

    cfg.emergencyStop = false;
  });

  it('allows a trade when maxDailyTrades is 0 (unlimited)', () => {
    const cfg = tradeConfig.get('binance');
    cfg.maxDailyTrades = 0;

    const result = validateRisk(makeRiskInput({ dailyTradeCount: 999, config: cfg }));

    expect(result.ok).toBe(true);
  });
});

describe('Exchange Mode', () => {
  beforeEach(() => {
    exchangeMode.update({ mode: 'demo', apiValidated: false, armed: false });
  });

  it('starts in demo mode by default', () => {
    const state = exchangeMode.get();
    expect(state.mode).toBe('demo');
  });

  it('updates mode and arm status', () => {
    exchangeMode.update({ mode: 'live', apiValidated: true, armed: true });
    const state = exchangeMode.get();
    expect(state.mode).toBe('live');
    expect(state.armed).toBe(true);
    expect(state.apiValidated).toBe(true);
  });

  it('clears arm and validation state when switching exchange', () => {
    exchangeMode.update({ mode: 'live', apiValidated: true, armed: true });
    exchangeMode.setExchange('kucoin');

    const state = exchangeMode.get();
    expect(state.exchange).toBe('kucoin');
    expect(state.armed).toBe(false);
    expect(state.apiValidated).toBe(false);
  });
});
