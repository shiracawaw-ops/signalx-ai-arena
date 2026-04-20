// ─── Order Progress Store — multi-tab sync tests ──────────────────────────────
// Covers the BroadcastChannel-based cross-tab layer in `order-progress.ts`:
// leader election (so only one tab polls a given orderId), dismiss
// propagation, snapshot-on-open, and leader release / takeover. These paths
// are otherwise only exercised by the live browser, so a regression in the
// tiebreak / heartbeat logic could silently re-introduce duplicate polling.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Install a shared in-memory BroadcastChannel polyfill BEFORE the module
// under test is imported, so its constructor wires onto our mock. We expose
// the bus registry so each test can wipe it (and so the singleton instance
// created at import time can't leak messages into later tests).
const { buses } = vi.hoisted(() => {
  const buses = new Map<string, Set<MockBC>>();
  class MockBC {
    name: string;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      let set = buses.get(name);
      if (!set) { set = new Set(); buses.set(name, set); }
      set.add(this);
    }
    postMessage(data: unknown): void {
      const peers = buses.get(this.name);
      if (!peers) return;
      for (const peer of peers) {
        if (peer === this) continue; // BroadcastChannel never echoes
        try { peer.onmessage?.({ data }); } catch { /* ignore */ }
      }
    }
    close(): void { buses.get(this.name)?.delete(this); }
  }
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = MockBC;
  return { buses };
});

vi.mock('./api-client.js', () => ({
  apiClient: { getOrderStatus: vi.fn() },
}));

import { apiClient } from './api-client.js';
import { OrderProgressStore } from './order-progress.js';

const mockGetStatus = vi.mocked(apiClient.getOrderStatus);

const CREDS = { apiKey: 'k', secretKey: 's' };

// Default "still open" status response so polling loops have something to
// chew on without immediately reaching a terminal phase.
const OPEN_STATUS = {
  ok: true,
  data: { order: {
    orderId: 'O', status: 'open', filledQty: 0, quantity: 1, avgPrice: 0,
  } },
} as never;

beforeEach(() => {
  vi.useFakeTimers();
  mockGetStatus.mockReset();
  mockGetStatus.mockResolvedValue(OPEN_STATUS);
  // Wipe the bus so the module-level singleton (constructed at import time)
  // can't see traffic from the per-test instances and vice versa.
  buses.clear();
  // Clear persisted progress so each new OrderProgressStore starts empty —
  // the store rehydrates non-terminal rows from localStorage on construction.
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  vi.useRealTimers();
});

// Drain the microtask queue so the awaited `getOrderStatus` promise inside
// the polling tick resolves before we make assertions.
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

describe('orderProgress cross-tab sync', () => {
  it('only the leader tab issues getOrderStatus when two tabs poll the same key', async () => {
    const tabA = new OrderProgressStore();
    const tabB = new OrderProgressStore();

    tabA.start({
      key: 'manual:Z', source: 'manual', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });
    // The mutation is broadcast synchronously to tabB.
    expect(tabB.get('manual:Z')?.phase).toBe('submitting');

    tabA.poll({
      key: 'manual:Z', orderId: 'Z', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });
    // tabB sees the poll-claim from tabA (delivered synchronously) and so
    // its own poll() call must defer instead of starting a duplicate loop.
    tabB.poll({
      key: 'manual:Z', orderId: 'Z', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });

    // Several poll ticks worth of time. Only tabA should be polling.
    await vi.advanceTimersByTimeAsync(1500); await flush();
    await vi.advanceTimersByTimeAsync(1500); await flush();
    await vi.advanceTimersByTimeAsync(1500); await flush();

    expect(mockGetStatus).toHaveBeenCalledTimes(3);
  });

  it('dismiss in one tab clears the row and cancels polling in the other', async () => {
    const tabA = new OrderProgressStore();
    const tabB = new OrderProgressStore();

    tabA.start({
      key: 'close:ETH', source: 'close', exchange: 'binance',
      symbol: 'ETH', side: 'sell',
    });
    tabA.poll({
      key: 'close:ETH', orderId: 'E1', exchange: 'binance',
      symbol: 'ETH', creds: CREDS,
    });

    expect(tabB.get('close:ETH')).toBeTruthy();

    tabB.dismiss('close:ETH');

    expect(tabA.get('close:ETH')).toBeUndefined();
    expect(tabB.get('close:ETH')).toBeUndefined();

    // tabA should also have stopped polling now that the row was dismissed.
    await vi.advanceTimersByTimeAsync(5000); await flush();
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('snapshot reply populates a freshly-constructed tab', () => {
    const tabA = new OrderProgressStore();
    tabA.start({
      key: 'autopilot:S1', source: 'autopilot', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });

    // tabB joins later. Its constructor sends a snapshot-request which tabA
    // answers with its current state — tabB should immediately see the row.
    const tabB = new OrderProgressStore();

    expect(tabB.get('autopilot:S1')).toBeTruthy();
    expect(tabB.get('autopilot:S1')?.phase).toBe('submitting');
  });

  it('a peer takes over polling when the leader tab releases', async () => {
    const tabA = new OrderProgressStore();
    const tabB = new OrderProgressStore();

    tabA.start({
      key: 'manual:R', source: 'manual', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });
    tabA.poll({
      key: 'manual:R', orderId: 'R', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });
    tabB.poll({
      key: 'manual:R', orderId: 'R', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });

    // Let tabA poll once so we know it really is the leader.
    await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    mockGetStatus.mockClear();

    // Simulate tabA closing: its `beforeunload` listener broadcasts a
    // `poll-release` for every key it's leading. tabB's onMessage handler
    // should observe the release and (because it has stashed local opts)
    // promote itself to leader and resume polling. We detach tabA from the
    // bus first so the closed tab can't react to tabB's subsequent
    // poll-claim and steal leadership back — that's what a real closed tab
    // would look like to the peer.
    tabA.cancelPoller('manual:R');
    const aChan = (tabA as unknown as { channel: { close(): void } | null }).channel;
    aChan?.close();
    window.dispatchEvent(new Event('beforeunload'));

    // tabA should no longer be polling — only tabB.
    await vi.advanceTimersByTimeAsync(1500); await flush();
    await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });
});
