import { describe, it, expect } from 'vitest';
import {
  buildSweepDustPlan,
  cancelSweepDustDialog,
  confirmSweepDustDialog,
  getDustPayoutToken,
  initialSweepDustDialogState,
  openSweepDustDialog,
} from './sweep-dust-dialog';

describe('getDustPayoutToken', () => {
  it('returns BNB for binance regardless of case', () => {
    expect(getDustPayoutToken('binance')).toBe('BNB');
    expect(getDustPayoutToken('BINANCE')).toBe('BNB');
  });
  it('falls back to a generic label for unknown adapters', () => {
    expect(getDustPayoutToken('kraken')).toMatch(/payout token/i);
  });
});

describe('buildSweepDustPlan', () => {
  const balances = [
    { asset: 'shib', usdtValue: 0.34 },
    { asset: 'BNB',  usdtValue: 0.12 },
    { asset: 'XRP',  usdtValue: undefined },
  ];
  it('normalises targets, dedupes, and attaches USDT values', () => {
    const plan = buildSweepDustPlan({
      exchangeId:   'binance',
      exchangeName: 'Binance',
      targets:      ['shib', 'SHIB', 'bnb', ''],
      balances,
    });
    expect(plan.payoutToken).toBe('BNB');
    expect(plan.rows).toEqual([
      { asset: 'SHIB', usdValue: 0.34 },
      { asset: 'BNB',  usdValue: 0.12 },
    ]);
    expect(plan.totalUsd).toBeCloseTo(0.46, 6);
  });
  it('still renders rows for assets missing from the live balances', () => {
    const plan = buildSweepDustPlan({
      exchangeId: 'binance', exchangeName: 'Binance',
      targets: ['DOGE'], balances,
    });
    expect(plan.rows).toEqual([{ asset: 'DOGE' }]);
    expect(plan.totalUsd).toBe(0);
  });
});

describe('sweep dust dialog state machine', () => {
  it('starts closed with no targets', () => {
    expect(initialSweepDustDialogState).toEqual({ open: false, targets: [] });
  });

  it('opens with normalised, deduped, non-empty targets', () => {
    const s = openSweepDustDialog(['shib', 'SHIB', '', 'bnb']);
    expect(s).toEqual({ open: true, targets: ['SHIB', 'BNB'] });
  });

  it('does NOT open when every target is blank', () => {
    const s = openSweepDustDialog(['', '']);
    expect(s.open).toBe(false);
    expect(s.targets).toEqual([]);
  });

  it('does NOT open when the targets list is empty', () => {
    const s = openSweepDustDialog([]);
    expect(s).toEqual({ open: false, targets: [] });
  });

  it('cancel path clears targets and closes the dialog', () => {
    const opened = openSweepDustDialog(['SHIB']);
    expect(opened.open).toBe(true);
    const closed = cancelSweepDustDialog();
    expect(closed).toEqual({ open: false, targets: [] });
  });

  it('confirm path returns the targets and closes the dialog', () => {
    const opened = openSweepDustDialog(['shib', 'BNB']);
    const { targets, next } = confirmSweepDustDialog(opened);
    expect(targets).toEqual(['SHIB', 'BNB']);
    expect(next).toEqual({ open: false, targets: [] });
  });

  it('open → cancel → open again works as a fresh transition', () => {
    let s = openSweepDustDialog(['SHIB']);
    s = cancelSweepDustDialog();
    expect(s.open).toBe(false);
    s = openSweepDustDialog(['DOGE', 'doge']);
    expect(s).toEqual({ open: true, targets: ['DOGE'] });
  });
});
