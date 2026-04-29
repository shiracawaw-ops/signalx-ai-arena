import { describe, it, expect } from 'vitest';
import {
  scoreTradeQuality,
  roundTripCostBps,
  QUALITY_FLOOR,
} from './trade-quality.js';

const RULES_5 = { minNotional: 5, minQty: 0.0001, stepSize: 0.0001, tickSize: 0.01 };

describe('roundTripCostBps', () => {
  it('returns ~30bps for binance/bybit (10bps taker × 2 + 10bps spread)', () => {
    expect(roundTripCostBps('binance')).toBe(30);
    expect(roundTripCostBps('bybit')).toBe(30);
  });

  it('uses a conservative default for unknown venues', () => {
    expect(roundTripCostBps('unknown')).toBeGreaterThan(30);
  });
});

describe('scoreTradeQuality — passing cases', () => {
  it('passes a fresh, well-buffered, no-edge-info trade', () => {
    const v = scoreTradeQuality({
      notional: 25,            // 5× minNotional
      refPrice: 100,
      signalAgeMs: 1_000,      // fresh
      rules: RULES_5,
      recentFails: 0,
      exchange: 'binance',
    });
    expect(v.pass).toBe(true);
    expect(v.score).toBeGreaterThanOrEqual(QUALITY_FLOOR);
    expect(v.vetoes).toEqual([]);
  });

  it('still passes when no rules are cached (neutral buffer + no fee veto)', () => {
    const v = scoreTradeQuality({
      notional: 100,
      refPrice: 100,
      signalAgeMs: 0,
      exchange: 'binance',
    });
    expect(v.pass).toBe(true);
  });

  it('passes when supplied edge comfortably exceeds round-trip cost', () => {
    const v = scoreTradeQuality({
      notional: 25,
      refPrice: 100,
      signalAgeMs: 1_000,
      rules: RULES_5,
      expectedEdgeBps: 100,    // 100bps vs 30bps round-trip
      exchange: 'binance',
    });
    expect(v.pass).toBe(true);
  });
});

describe('scoreTradeQuality — failing & veto cases', () => {
  it('vetoes when the exit notional after fees would not clear minNotional×1.1', () => {
    // notional just barely above min, fees would drop the exit below min*1.1
    const v = scoreTradeQuality({
      notional: 5.10,          // basically at min
      refPrice: 100,
      signalAgeMs: 0,
      rules: RULES_5,
      exchange: 'binance',
    });
    expect(v.pass).toBe(false);
    expect(v.vetoes.length).toBeGreaterThan(0);
    expect(v.vetoes[0]).toMatch(/round-trip|exit notional|after fees/i);
  });

  it('vetoes when supplied edge is below the round-trip cost', () => {
    const v = scoreTradeQuality({
      notional: 100,           // huge buffer so only the edge veto fires
      refPrice: 100,
      signalAgeMs: 0,
      rules: RULES_5,
      expectedEdgeBps: 5,      // 5bps < 30bps round-trip
      exchange: 'binance',
    });
    expect(v.pass).toBe(false);
    expect(v.vetoes.some(r => /round-trip cost/i.test(r))).toBe(true);
  });

  it('fails on composite (no veto) when several signals are weak together', () => {
    const v = scoreTradeQuality({
      notional: 6,             // tiny buffer above min — clears veto, hurts buffer score
      refPrice: 100,
      signalAgeMs: 25_000,     // very stale
      rules: RULES_5,
      recentFails: 2,          // at the cooldown ceiling
      confidence: 30,          // weak confidence
      exchange: 'binance',
    });
    expect(v.pass).toBe(false);
    expect(v.vetoes).toEqual([]);            // composite-driven, no veto
    expect(v.reason).toMatch(/below floor/i);
  });

  it('weights stale price into a lower freshness component', () => {
    const fresh = scoreTradeQuality({
      notional: 25, refPrice: 100, signalAgeMs: 0,
      rules: RULES_5, exchange: 'binance',
    });
    const stale = scoreTradeQuality({
      notional: 25, refPrice: 100, signalAgeMs: 30_000,
      rules: RULES_5, exchange: 'binance',
    });
    const freshC = fresh.components.find(c => c.id === 'price_freshness')!;
    const staleC = stale.components.find(c => c.id === 'price_freshness')!;
    expect(freshC.score).toBeGreaterThan(staleC.score);
    expect(staleC.score).toBe(0);
  });
});

describe('scoreTradeQuality — component breakdown', () => {
  it('always exposes the named components in stable order', () => {
    const v = scoreTradeQuality({
      notional: 25, refPrice: 100, signalAgeMs: 0,
      rules: RULES_5, exchange: 'binance',
    });
    expect(v.components.map(c => c.id)).toEqual([
      'notional_buffer',
      'price_freshness',
      'fee_headroom',
      'cooldown_penalty',
      'confidence',
      'edge_after_fees',
      'spread_quality',
      'volatility_sanity',
      'momentum_confirmation',
      'volume_confirmation',
    ]);
  });

  it('component weights sum to 1.3 and normalize in composite', () => {
    const v = scoreTradeQuality({
      notional: 25, refPrice: 100, signalAgeMs: 0,
      rules: RULES_5, exchange: 'binance',
    });
    const total = v.components.reduce((s, c) => s + c.weight, 0);
    expect(total).toBeCloseTo(1.3, 6);
    const normalized = v.components.reduce((s, c) => s + (c.weight / total), 0);
    expect(normalized).toBeCloseTo(1.0, 6);
  });
});
