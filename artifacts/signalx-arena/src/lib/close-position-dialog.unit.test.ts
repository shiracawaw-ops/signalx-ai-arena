import { describe, it, expect } from 'vitest';
import {
  buildClosePositionPlan,
  cancelClosePositionDialog,
  confirmClosePositionDialog,
  initialClosePositionDialogState,
  openClosePositionDialog,
} from './close-position-dialog';

describe('buildClosePositionPlan', () => {
  const balances = [
    { asset: 'btc', available: 0.123, usdtValue: 8000.5 },
    { asset: 'ETH', available: 1.5,   usdtValue: undefined },
    { asset: 'XRP', available: NaN,   usdtValue: 12.34 },
  ];

  it('normalises the asset to upper-case and attaches qty + USDT value', () => {
    const plan = buildClosePositionPlan({
      exchangeId:   'binance',
      exchangeName: 'Binance',
      asset:        'btc',
      balances,
    });
    expect(plan.exchangeId).toBe('binance');
    expect(plan.exchangeName).toBe('Binance');
    expect(plan.asset).toBe('BTC');
    expect(plan.available).toBe(0.123);
    expect(plan.usdValue).toBe(8000.5);
  });

  it('omits usdValue when the live row has none', () => {
    const plan = buildClosePositionPlan({
      exchangeId: 'binance', exchangeName: 'Binance',
      asset: 'eth', balances,
    });
    expect(plan.asset).toBe('ETH');
    expect(plan.available).toBe(1.5);
    expect(plan.usdValue).toBeUndefined();
  });

  it('clamps a non-finite available qty to 0', () => {
    const plan = buildClosePositionPlan({
      exchangeId: 'binance', exchangeName: 'Binance',
      asset: 'XRP', balances,
    });
    expect(plan.available).toBe(0);
    expect(plan.usdValue).toBe(12.34);
  });

  it('still renders an empty preview for assets missing from live balances', () => {
    const plan = buildClosePositionPlan({
      exchangeId: 'binance', exchangeName: 'Binance',
      asset: 'doge', balances,
    });
    expect(plan.asset).toBe('DOGE');
    expect(plan.available).toBe(0);
    expect(plan.usdValue).toBeUndefined();
  });
});

describe('close position dialog state machine', () => {
  it('starts closed with no asset', () => {
    expect(initialClosePositionDialogState).toEqual({ open: false, asset: '' });
  });

  it('opens with a normalised, trimmed, upper-cased asset', () => {
    expect(openClosePositionDialog('  shib  ')).toEqual({ open: true, asset: 'SHIB' });
    expect(openClosePositionDialog('btc')).toEqual({ open: true, asset: 'BTC' });
  });

  it('does NOT open when the asset is blank', () => {
    expect(openClosePositionDialog('')).toEqual({ open: false, asset: '' });
    expect(openClosePositionDialog('   ')).toEqual({ open: false, asset: '' });
  });

  it('cancel path clears the asset and closes the dialog', () => {
    const opened = openClosePositionDialog('SHIB');
    expect(opened.open).toBe(true);
    expect(cancelClosePositionDialog()).toEqual({ open: false, asset: '' });
  });

  it('confirm path returns the asset and closes the dialog', () => {
    const opened = openClosePositionDialog('shib');
    const { asset, next } = confirmClosePositionDialog(opened);
    expect(asset).toBe('SHIB');
    expect(next).toEqual({ open: false, asset: '' });
  });

  it('open → cancel → open again works as a fresh transition', () => {
    let s = openClosePositionDialog('SHIB');
    s = cancelClosePositionDialog();
    expect(s.open).toBe(false);
    s = openClosePositionDialog('doge');
    expect(s).toEqual({ open: true, asset: 'DOGE' });
  });
});
