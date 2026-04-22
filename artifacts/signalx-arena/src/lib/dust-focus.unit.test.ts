import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  requestDustFocus,
  consumeDustFocus,
  peekDustFocus,
  subscribeDustFocus,
  __resetDustFocusForTests,
} from './dust-focus';

// Tests for the dust-focus module — the singleton hand-off used by Dust
// badges in Arena / Wallet / Leaderboard to ask the Holdings cleanup view
// (pages/exchange.tsx) to scroll to and focus the matching asset row.
//
// The contract this guards:
//   1. requestDustFocus normalizes the asset to UPPERCASE so the receiver
//      can look up `badge-dust-${ASSET}` without having to re-normalize.
//   2. consumeDustFocus drains the pending request exactly once — repeated
//      mounts of the cleanup view must not refire a stale focus.
//   3. There are TWO valid delivery paths (both used in production):
//        - pending-on-mount: the click happens *before* the cleanup view
//          mounts (typical Arena → /exchange jump). The new mount picks
//          the request up via consumeDustFocus().
//        - live-subscription: the click happens *while* the cleanup view
//          is already mounted (e.g. clicked from a side panel). The
//          subscriber callback fires synchronously.
//      A subscriber must NOT be replayed past requests, otherwise the
//      pending-on-mount path would deliver the same focus twice (once via
//      consumeDustFocus, once via the just-attached subscriber).

beforeEach(() => {
  __resetDustFocusForTests();
});

describe('dust-focus — requestDustFocus', () => {
  it('stores the request as the pending focus', () => {
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    expect(peekDustFocus()).toEqual({ exchange: 'binance', asset: 'XRP' });
  });

  it('uppercases the asset so a lowercase click still matches badge-dust-XRP', () => {
    requestDustFocus({ exchange: 'binance', asset: 'xrp' });
    expect(peekDustFocus()?.asset).toBe('XRP');
  });

  it('preserves the exchange id verbatim (case-sensitive identifiers)', () => {
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    expect(peekDustFocus()?.exchange).toBe('binance');
  });

  it('overwrites any earlier pending request with the latest one', () => {
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    requestDustFocus({ exchange: 'kraken',  asset: 'doge' });
    expect(peekDustFocus()).toEqual({ exchange: 'kraken', asset: 'DOGE' });
  });
});

describe('dust-focus — consumeDustFocus', () => {
  it('returns the pending request and clears it so a second call yields null', () => {
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    expect(consumeDustFocus()).toEqual({ exchange: 'binance', asset: 'XRP' });
    expect(consumeDustFocus()).toBeNull();
    expect(peekDustFocus()).toBeNull();
  });

  it('returns null when nothing is pending', () => {
    expect(consumeDustFocus()).toBeNull();
  });
});

describe('dust-focus — pending-on-mount flow', () => {
  it('a request emitted BEFORE subscribe is delivered via consumeDustFocus, not the new subscriber', () => {
    // Simulates the Arena → /exchange jump: requestDustFocus fires first,
    // then setLocation('/exchange') causes the cleanup page to mount and
    // run its effect (consumeDustFocus + subscribeDustFocus).
    requestDustFocus({ exchange: 'binance', asset: 'xrp' });

    const liveCb  = vi.fn();
    const drained = consumeDustFocus();
    const unsub   = subscribeDustFocus(liveCb);

    expect(drained).toEqual({ exchange: 'binance', asset: 'XRP' });
    // Subscribers must NOT be replayed past requests — otherwise the focus
    // effect would run twice for a single click.
    expect(liveCb).not.toHaveBeenCalled();

    unsub();
  });

  it('after a drain, a fresh request fires only the live subscriber (no stale replay)', () => {
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    consumeDustFocus();

    const cb = vi.fn();
    const unsub = subscribeDustFocus(cb);

    requestDustFocus({ exchange: 'binance', asset: 'doge' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ exchange: 'binance', asset: 'DOGE' });

    unsub();
  });
});

describe('dust-focus — live-subscription flow', () => {
  it('delivers requests synchronously to listeners that are already subscribed', () => {
    const cb = vi.fn();
    const unsub = subscribeDustFocus(cb);

    // Nothing pending yet — drain returns null.
    expect(consumeDustFocus()).toBeNull();

    // User clicks a Dust badge while the cleanup view is already on screen
    // (e.g. clicked a badge from a parallel panel).
    requestDustFocus({ exchange: 'binance', asset: 'xrp' });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ exchange: 'binance', asset: 'XRP' });

    unsub();
  });

  it('the returned unsubscribe stops further deliveries', () => {
    const cb = vi.fn();
    const unsub = subscribeDustFocus(cb);
    unsub();
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('multiple subscribers all receive the request', () => {
    const a = vi.fn();
    const b = vi.fn();
    const ua = subscribeDustFocus(a);
    const ub = subscribeDustFocus(b);
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    expect(a).toHaveBeenCalledWith({ exchange: 'binance', asset: 'XRP' });
    expect(b).toHaveBeenCalledWith({ exchange: 'binance', asset: 'XRP' });
    ua(); ub();
  });

  it('a throwing listener does not block other listeners (one bad badge consumer must not break the rest)', () => {
    const bad  = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    const u1 = subscribeDustFocus(bad);
    const u2 = subscribeDustFocus(good);
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    u1(); u2();
  });

  it('a request fired during dispatch still leaves the latest one as pending', () => {
    // Listener that re-routes to a different asset (defensive — the real
    // page never does this, but the module must not corrupt its pending
    // slot if anyone ever does).
    const u = subscribeDustFocus(() => {
      // re-emit only on the first call to avoid infinite recursion in tests
      if (peekDustFocus()?.asset === 'XRP') {
        requestDustFocus({ exchange: 'binance', asset: 'doge' });
      }
    });
    requestDustFocus({ exchange: 'binance', asset: 'XRP' });
    expect(peekDustFocus()).toEqual({ exchange: 'binance', asset: 'DOGE' });
    u();
  });
});
