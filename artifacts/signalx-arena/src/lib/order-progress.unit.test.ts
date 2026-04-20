// ─── Order Progress Store — unit tests ────────────────────────────────────────
// Covers the shared subscribable progress store consumed by the Balances
// (close-position), Manual Order and AutoPilot panels. The store centralises
// the polling loop + terminal-phase detection that used to be inlined in
// exchange.tsx so a regression in any one consumer can't silently break the
// others.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./api-client.js', () => ({
  apiClient: { getOrderStatus: vi.fn() },
}));

import { apiClient } from './api-client.js';
import { orderProgress, TERMINAL_PHASES } from './order-progress.js';

const mockGetStatus = vi.mocked(apiClient.getOrderStatus);

const CREDS = { apiKey: 'k', secretKey: 's' };

beforeEach(() => {
  vi.useFakeTimers();
  mockGetStatus.mockReset();
  // Wipe any state left over from a previous test.
  for (const k of Object.keys(orderProgress.all())) orderProgress.dismiss(k);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('orderProgress.start / update / dismiss', () => {
  it('starts in submitting phase and emits to subscribers', () => {
    const seen: string[] = [];
    const unsub = orderProgress.subscribe(s => {
      const p = s['close:BTC'];
      if (p) seen.push(p.phase);
    });

    orderProgress.start({
      key: 'close:BTC', source: 'close', exchange: 'binance',
      symbol: 'BTC', side: 'sell',
    });
    orderProgress.update('close:BTC', { phase: 'pending', orderId: 'O1' });
    orderProgress.update('close:BTC', { phase: 'filled', filledQty: 1, quantity: 1, avgPrice: 50_000 });

    unsub();
    expect(seen).toContain('submitting');
    expect(seen).toContain('pending');
    expect(seen).toContain('filled');
    expect(orderProgress.get('close:BTC')?.avgPrice).toBe(50_000);
  });

  it('dismiss() removes the row and notifies subscribers', () => {
    orderProgress.start({
      key: 'manual:O2', source: 'manual', exchange: 'binance',
      symbol: 'ETH', side: 'buy',
    });
    expect(orderProgress.get('manual:O2')).toBeTruthy();
    orderProgress.dismiss('manual:O2');
    expect(orderProgress.get('manual:O2')).toBeUndefined();
  });
});

describe('orderProgress.poll', () => {
  it('marks the order filled when getOrderStatus reports filled', async () => {
    mockGetStatus.mockResolvedValue({
      ok: true,
      data: { order: {
        orderId: 'X', status: 'filled', filledQty: 0.5, quantity: 0.5, avgPrice: 84_000,
      } },
    } as never);

    orderProgress.start({
      key: 'autopilot:X', source: 'autopilot', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });
    orderProgress.poll({
      key: 'autopilot:X', orderId: 'X', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });

    await vi.advanceTimersByTimeAsync(1500);
    // flush microtasks scheduled by the awaited mock
    await vi.advanceTimersByTimeAsync(0);

    const p = orderProgress.get('autopilot:X')!;
    expect(p.phase).toBe('filled');
    expect(p.filledQty).toBe(0.5);
    expect(p.avgPrice).toBe(84_000);
    expect(TERMINAL_PHASES.has(p.phase)).toBe(true);
  });

  it('flips to partial when the exchange reports an open order with a partial fill', async () => {
    mockGetStatus.mockResolvedValue({
      ok: true,
      data: { order: {
        orderId: 'Y', status: 'open', filledQty: 0.25, quantity: 1, avgPrice: 84_000,
      } },
    } as never);

    orderProgress.start({
      key: 'manual:Y', source: 'manual', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });
    orderProgress.poll({
      key: 'manual:Y', orderId: 'Y', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });

    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(0);

    expect(orderProgress.get('manual:Y')?.phase).toBe('partial');
  });
});
