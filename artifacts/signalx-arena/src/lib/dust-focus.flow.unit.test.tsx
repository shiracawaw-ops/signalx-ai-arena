// @vitest-environment jsdom

// Integration test for the Dust badge → cleanup tool jump.
//
// This test stitches together the real `dust-focus` singleton, real `wouter`
// routing, and a tiny harness that mirrors the production wiring on both
// sides of the hand-off so that a regression in either half is caught:
//
//   - Source side (Arena / Wallet / Leaderboard): clicking the Dust badge
//     calls `requestDustFocus(...)` and then `setLocation('/exchange')`.
//     See `pages/arena.tsx` (`onDustClick`, `focusDust`) and `pages/wallet.tsx`.
//
//   - Destination side (Holdings cleanup tool / ClassifiedBalances): on
//     mount, `consumeDustFocus()` drains a pending request, while
//     `subscribeDustFocus(...)` handles requests that fire after mount.
//     The asset is then handed off to the focus effect that scrolls to and
//     focuses `[data-testid="badge-dust-${ASSET}"]`. See `pages/exchange.tsx`
//     (`handleDustFocus` + `ClassifiedBalances` focus effect).
//
// We intentionally keep the harness components small (instead of mounting
// the full `ExchangePage` / `ArenaPage`) because those pages depend on a
// large web of singletons (auth, market data, exchange adapters, etc.).
// The harness mirrors the wiring shape exactly; the production-page-level
// wiring is also exercised by the existing render and end-to-end tests.

import { useCallback, useEffect, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Router as WouterRouter, Route, Switch, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import {
  requestDustFocus,
  consumeDustFocus,
  subscribeDustFocus,
  __resetDustFocusForTests,
  type DustFocusRequest,
} from './dust-focus';

// ─── Source-side stand-in (Arena/Wallet Dust badge) ─────────────────────────
// Mirrors `onDustClick` in pages/arena.tsx and the equivalent click in
// pages/wallet.tsx: fire requestDustFocus, then navigate to /exchange.
function ArenaSim({ exchange, asset }: { exchange: string; asset: string }) {
  const [, setLocation] = useLocation();
  return (
    <button
      type="button"
      data-testid="badge-bot-dust-trigger"
      onClick={() => {
        requestDustFocus({ exchange, asset });
        setLocation('/exchange');
      }}
    >
      Dust
    </button>
  );
}

// ─── Destination-side stand-in (Holdings cleanup tool) ──────────────────────
// Mirrors the focus effect in pages/exchange.tsx (consume on mount + live
// subscribe → setFocusAsset) and the badge markup that ClassifiedBalances
// renders for each dust-marked balance row (`badge-dust-${ASSET}`).
function ExchangeSim() {
  const [focusAsset, setFocusAsset] = useState<string | null>(null);

  const handleDustFocus = useCallback((req: DustFocusRequest) => {
    setFocusAsset(req.asset);
  }, []);

  useEffect(() => {
    const pending = consumeDustFocus();
    if (pending) handleDustFocus(pending);
    return subscribeDustFocus(handleDustFocus);
  }, [handleDustFocus]);

  // Scroll-into-view + focus, matching the behavior in
  // ClassifiedBalances' focus effect (without the highlight ring polish).
  useEffect(() => {
    if (!focusAsset) return;
    const el = document.querySelector<HTMLElement>(
      `[data-testid="badge-dust-${focusAsset}"]`,
    );
    if (el) {
      try { el.focus({ preventScroll: true }); } catch { /* focus optional */ }
    }
  }, [focusAsset]);

  return (
    <div data-testid="exchange-page">
      <button
        type="button"
        data-testid="badge-dust-XRP"
        aria-label="Clear dust mark for XRP"
      >
        Dust
      </button>
      <button
        type="button"
        data-testid="badge-dust-DOGE"
        aria-label="Clear dust mark for DOGE"
      >
        Dust
      </button>
    </div>
  );
}

// ─── Harness lifecycle ──────────────────────────────────────────────────────
let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  __resetDustFocusForTests();
});

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

function mount(initialPath: string) {
  const memory = memoryLocation({ path: initialPath, record: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(
      <WouterRouter hook={memory.hook}>
        <Switch>
          <Route path="/arena">
            <ArenaSim exchange="binance" asset="xrp" />
          </Route>
          <Route path="/exchange"><ExchangeSim /></Route>
          <Route><div data-testid="404">no route</div></Route>
        </Switch>
      </WouterRouter>,
    );
  });
  return memory;
}

describe('Dust badge → cleanup tool jump', () => {
  it('clicking the Dust badge navigates to the cleanup tool and focuses badge-dust-XRP', async () => {
    const memory = mount('/arena');

    // Sanity: we are on the source page first; cleanup tool not yet mounted.
    expect(container!.querySelector('[data-testid="badge-bot-dust-trigger"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="exchange-page"]')).toBeNull();

    // Click the Dust badge — fires requestDustFocus + setLocation('/exchange').
    const trigger = container!.querySelector<HTMLButtonElement>(
      '[data-testid="badge-bot-dust-trigger"]',
    )!;
    await act(async () => {
      trigger.click();
    });

    // Router switched to the cleanup tool.
    expect(memory.history?.[memory.history.length - 1]).toBe('/exchange');
    expect(container!.querySelector('[data-testid="exchange-page"]')).not.toBeNull();

    // The dust badge for the requested asset (uppercased) is focused, and
    // a sibling badge for an unrelated asset is NOT focused. This is the
    // user-facing promise: clicking Dust on Arena's XRP bot lands on the
    // XRP row in Holdings, ready for keyboard interaction.
    const xrp  = container!.querySelector<HTMLButtonElement>('[data-testid="badge-dust-XRP"]')!;
    const doge = container!.querySelector<HTMLButtonElement>('[data-testid="badge-dust-DOGE"]')!;
    expect(document.activeElement).toBe(xrp);
    expect(document.activeElement).not.toBe(doge);
  });

  it('a request fired while the cleanup tool is already mounted is delivered via the live subscription', async () => {
    mount('/exchange');

    const xrp  = container!.querySelector<HTMLButtonElement>('[data-testid="badge-dust-XRP"]')!;
    const doge = container!.querySelector<HTMLButtonElement>('[data-testid="badge-dust-DOGE"]')!;

    // Nothing focused initially — no pending request was drained on mount.
    expect(document.activeElement).not.toBe(xrp);
    expect(document.activeElement).not.toBe(doge);

    // User clicks a Dust badge in some surface that's visible alongside
    // the cleanup tool — exercises the subscribeDustFocus path, not the
    // consumeDustFocus path.
    await act(async () => {
      requestDustFocus({ exchange: 'binance', asset: 'doge' });
    });

    expect(document.activeElement).toBe(doge);
  });
});
