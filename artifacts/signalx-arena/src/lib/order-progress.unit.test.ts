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
import { orderProgress, TERMINAL_PHASES, POLL_TIMEOUTS_MS, setPollTimeout } from './order-progress.js';

const mockGetStatus = vi.mocked(apiClient.getOrderStatus);

const CREDS = { apiKey: 'k', secretKey: 's' };

beforeEach(() => {
  vi.useFakeTimers();
  mockGetStatus.mockReset();
  // Wipe any state left over from a previous test.
  for (const k of Object.keys(orderProgress.all())) orderProgress.dismiss(k);
  try { localStorage.removeItem('sx_order_progress_v1'); } catch { /* noop */ }
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

  it('persists non-terminal rows to localStorage and re-attaches polling via resume()', async () => {
    // Simulate a prior page load that left a pending row in storage:
    // start the order, advance it to pending, and verify the persisted
    // payload contains it.
    orderProgress.start({
      key: 'manual:Z', source: 'manual', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });
    orderProgress.update('manual:Z', { phase: 'pending', orderId: 'Z' });

    const persisted = JSON.parse(localStorage.getItem('sx_order_progress_v1') ?? '{}');
    expect(persisted['manual:Z']?.phase).toBe('pending');
    expect(persisted['manual:Z']?.orderId).toBe('Z');

    // resume() with available creds should call getOrderStatus on the next tick.
    mockGetStatus.mockResolvedValue({
      ok: true,
      data: { order: { orderId: 'Z', status: 'filled', filledQty: 1, quantity: 1, avgPrice: 100 } },
    } as never);
    orderProgress.resumeAll(() => CREDS);

    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockGetStatus).toHaveBeenCalledWith('binance', CREDS, 'Z', 'BTC');
    expect(orderProgress.get('manual:Z')?.phase).toBe('filled');

    // After reaching a terminal phase the row must be dropped from
    // persisted storage so a refresh does not bring it back.
    const after = JSON.parse(localStorage.getItem('sx_order_progress_v1') ?? '{}');
    expect(after['manual:Z']).toBeUndefined();
  });

  it('resume() with no creds does nothing, then begins polling once creds become available', async () => {
    orderProgress.start({
      key: 'autopilot:Q', source: 'autopilot', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });
    orderProgress.update('autopilot:Q', { phase: 'pending', orderId: 'Q' });

    // First resume: no creds yet — must NOT call getOrderStatus.
    mockGetStatus.mockResolvedValue({
      ok: true,
      data: { order: { orderId: 'Q', status: 'filled', filledQty: 1, quantity: 1, avgPrice: 200 } },
    } as never);
    orderProgress.resumeAll(() => null);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).not.toHaveBeenCalled();
    expect(orderProgress.get('autopilot:Q')?.phase).toBe('pending');

    // Second resume after creds become available — polling starts.
    orderProgress.resumeAll(() => CREDS);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledWith('binance', CREDS, 'Q', 'BTC');
    expect(orderProgress.get('autopilot:Q')?.phase).toBe('filled');
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

  it('marks the order timeout once the per-source budget elapses and exposes a resumable flag', async () => {
    // getOrderStatus keeps reporting "open" with no fill so we hit the timeout.
    mockGetStatus.mockResolvedValue({
      ok: true,
      data: { order: {
        orderId: 'T', status: 'open', filledQty: 0, quantity: 1, avgPrice: 0,
      } },
    } as never);

    orderProgress.start({
      key: 'close:T', source: 'close', exchange: 'binance',
      symbol: 'BTC', side: 'sell',
    });
    orderProgress.poll({
      key: 'close:T', orderId: 'T', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });

    // Advance well past the close timeout (60s default).
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUTS_MS.close + 5_000);

    const p = orderProgress.get('close:T')!;
    expect(p.phase).toBe('timeout');
    expect(p.resumable).toBe(true);
    expect(p.message).toMatch(/Resume/i);
  });

  it('resume() restarts polling on a timed-out row using the original opts', async () => {
    mockGetStatus.mockResolvedValue({
      ok: true,
      data: { order: {
        orderId: 'R', status: 'open', filledQty: 0, quantity: 1, avgPrice: 0,
      } },
    } as never);

    orderProgress.start({
      key: 'manual:R', source: 'manual', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });
    orderProgress.poll({
      key: 'manual:R', orderId: 'R', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });

    await vi.advanceTimersByTimeAsync(POLL_TIMEOUTS_MS.manual + 5_000);
    expect(orderProgress.get('manual:R')?.phase).toBe('timeout');

    // Now the exchange flips to filled — resume() should pick it up.
    mockGetStatus.mockResolvedValue({
      ok: true,
      data: { order: {
        orderId: 'R', status: 'filled', filledQty: 1, quantity: 1, avgPrice: 100,
      } },
    } as never);

    const ok = orderProgress.resume('manual:R');
    expect(ok).toBe(true);
    expect(orderProgress.get('manual:R')?.phase).toBe('pending');
    expect(orderProgress.get('manual:R')?.resumable).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(0);

    expect(orderProgress.get('manual:R')?.phase).toBe('filled');
  });

  it('backs off transient errors instead of retrying every 1.5s', async () => {
    // First three calls reject (transient), fourth resolves filled.
    mockGetStatus
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        ok: true,
        data: { order: {
          orderId: 'B', status: 'filled', filledQty: 1, quantity: 1, avgPrice: 50,
        } },
      } as never);

    orderProgress.start({
      key: 'manual:B', source: 'manual', exchange: 'binance',
      symbol: 'BTC', side: 'buy',
    });
    orderProgress.poll({
      key: 'manual:B', orderId: 'B', exchange: 'binance',
      symbol: 'BTC', creds: CREDS,
    });

    // Tick 1 (after base 1500ms) → error, schedule next at 1500ms.
    await vi.advanceTimersByTimeAsync(1500); await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    // Advancing only 1500ms lands the second tick (1.5s backoff).
    await vi.advanceTimersByTimeAsync(1500); await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledTimes(2);

    // Third tick should be scheduled 3000ms out — 1500ms is NOT enough.
    await vi.advanceTimersByTimeAsync(1500); await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500); await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledTimes(3);

    // Fourth tick should be scheduled 6000ms out.
    await vi.advanceTimersByTimeAsync(3000); await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000); await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledTimes(4);

    expect(orderProgress.get('manual:B')?.phase).toBe('filled');
  });

  it('setPollTimeout() overrides the per-source budget', () => {
    const original = POLL_TIMEOUTS_MS.autopilot;
    setPollTimeout('autopilot', 30_000);
    expect(POLL_TIMEOUTS_MS.autopilot).toBe(30_000);
    setPollTimeout('autopilot', original);
    expect(POLL_TIMEOUTS_MS.autopilot).toBe(original);
  });
});
