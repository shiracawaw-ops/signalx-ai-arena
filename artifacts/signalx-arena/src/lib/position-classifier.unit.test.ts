import { describe, expect, it } from 'vitest';
import { classifyHolding } from './position-classifier.js';
import type { SymbolRules } from './risk-manager.js';

const RULES = (overrides: Partial<SymbolRules> = {}): SymbolRules => ({
  symbol:      'BTCUSDT',
  minQty:      0.0001,
  maxQty:      9_000_000,
  stepSize:    0.0001,
  minNotional: 10,
  tickSize:    0.01,
  ...overrides,
});

describe('classifyHolding', () => {
  it('classifies a stable coin as wallet_holding (never closable)', () => {
    const r = classifyHolding({
      asset: 'USDT', available: 1234, exchange: 'binance', isStable: true,
    });
    expect(r.category).toBe('wallet_holding');
    expect(r.reason).toBe('wallet_only_not_trade_position');
    expect(r.canClose).toBe(false);
  });

  it('classifies an asset with no balance as fully_closed', () => {
    const r = classifyHolding({
      asset: 'BTC', available: 0, exchange: 'binance', symbolRules: RULES(),
    });
    expect(r.category).toBe('fully_closed');
    expect(r.canClose).toBe(false);
  });

  it('classifies a tracked + flattened position as fully_closed', () => {
    const r = classifyHolding({
      asset: 'ADA', available: 0, exchange: 'binance', symbolRules: RULES(),
      trackedQty: 100,
    });
    expect(r.category).toBe('fully_closed');
    expect(r.reason).toBe('fully_flattened');
    expect(r.canClose).toBe(false);
  });

  it('classifies a doctor-marked dust asset as dust_balance', () => {
    const r = classifyHolding({
      asset: 'BTC', available: 0.00005, usdtValue: 4.2, exchange: 'binance',
      symbolRules: RULES(), isDustMarked: true,
    });
    expect(r.category).toBe('dust_balance');
    expect(r.reason).toBe('unsellable_dust');
    expect(r.canClose).toBe(false);
  });

  it('classifies dust by min-notional', () => {
    const r = classifyHolding({
      asset: 'XRP', available: 5, usdtValue: 3.21, exchange: 'binance',
      symbolRules: RULES({ minNotional: 10, minQty: 0 }),
    });
    expect(r.category).toBe('dust_balance');
    expect(r.reason).toBe('below_min_notional');
    expect(r.canClose).toBe(false);
    expect(r.detail).toMatch(/\$10/);
    expect(r.detail).toMatch(/\$3\.21/);
  });

  it('classifies dust by min-qty', () => {
    const r = classifyHolding({
      asset: 'BTC', available: 0.00005, usdtValue: 1000, exchange: 'binance',
      symbolRules: RULES({ minQty: 0.001 }),
    });
    expect(r.category).toBe('dust_balance');
    expect(r.reason).toBe('below_min_sell_qty');
    expect(r.canClose).toBe(false);
  });

  it('classifies a full active position when balance ≈ tracked qty', () => {
    const r = classifyHolding({
      asset: 'ETH', available: 0.5, usdtValue: 1500, exchange: 'binance',
      symbolRules: RULES({ minQty: 0.001, minNotional: 10 }),
      trackedQty: 0.5,
    });
    expect(r.category).toBe('active_position');
    expect(r.reason).toBe('sellable_position');
    expect(r.sellable).toBe(true);
    expect(r.canClose).toBe(true);
  });

  it('classifies a partial position (still sellable)', () => {
    const r = classifyHolding({
      asset: 'ETH', available: 0.2, usdtValue: 600, exchange: 'binance',
      symbolRules: RULES({ minQty: 0.001, minNotional: 10 }),
      trackedQty: 1.0,
    });
    expect(r.category).toBe('partial_position');
    expect(r.reason).toBe('residual_sellable');
    expect(r.canClose).toBe(true);
  });

  it('classifies a partial position that became dust as residual_unsellable', () => {
    const r = classifyHolding({
      asset: 'XRP', available: 5, usdtValue: 3.21, exchange: 'binance',
      symbolRules: RULES({ minNotional: 10, minQty: 0 }),
      trackedQty: 100,
    });
    expect(r.category).toBe('partial_position');
    expect(r.reason).toBe('residual_unsellable');
    expect(r.canClose).toBe(false);
  });

  it('classifies wallet-only asset (no tracked qty) as wallet_holding, not closable', () => {
    const r = classifyHolding({
      asset: 'DOGE', available: 100, usdtValue: 9, exchange: 'binance',
      symbolRules: RULES({ minNotional: 5, minQty: 1 }),
    });
    expect(r.category).toBe('wallet_holding');
    expect(r.reason).toBe('wallet_only_not_trade_position');
    expect(r.canClose).toBe(false);
    expect(r.sellable).toBe(true);
  });

  it('returns symbol_rules_unknown when no cached rules and we have a tracked position', () => {
    const r = classifyHolding({
      asset: 'SOL', available: 1, usdtValue: 200, exchange: 'binance',
      trackedQty: 1,
    });
    expect(r.reason).toBe('symbol_rules_unknown');
    expect(r.canClose).toBe(false);
  });

  it('honors exchange-specific minNotional differences', () => {
    const binance = classifyHolding({
      asset: 'BTC', available: 0.0002, usdtValue: 12, exchange: 'binance',
      symbolRules: RULES({ minNotional: 10, minQty: 0.0001 }),
      trackedQty: 0.0002,
    });
    const bybit = classifyHolding({
      asset: 'BTC', available: 0.0002, usdtValue: 12, exchange: 'bybit',
      symbolRules: RULES({ minNotional: 50, minQty: 0.0001 }),
      trackedQty: 0.0002,
    });
    expect(binance.canClose).toBe(true);
    expect(bybit.canClose).toBe(false);
    expect(bybit.reason).toBe('residual_unsellable');
  });

  it('still surfaces dust mark even when rules are cached', () => {
    const r = classifyHolding({
      asset: 'BTC', available: 1, usdtValue: 50000, exchange: 'binance',
      symbolRules: RULES(), isDustMarked: true,
    });
    expect(r.canClose).toBe(false);
    expect(r.reason).toBe('unsellable_dust');
  });

  it('uses the doctor-provided dust reason text when available', () => {
    const r = classifyHolding({
      asset: 'XRP', available: 5, usdtValue: 3.21, exchange: 'binance',
      symbolRules: RULES({ minNotional: 10 }),
      isDustMarked: true,
      dustReason: 'below_min_notional: Owned XRP value $3.21 below binance minNotional $10.',
    });
    expect(r.detail).toContain('$3.21');
    expect(r.detail).toContain('$10');
    expect(r.detail.toLowerCase()).toContain('marked dust');
  });
});
