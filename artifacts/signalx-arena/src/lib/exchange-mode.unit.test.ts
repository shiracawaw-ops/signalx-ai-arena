import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_RETRY_NETWORK_MS,
  AUTO_RETRY_RATE_LIMIT_MS,
  exchangeMode,
} from './exchange-mode';

const FIXED_NOW = 1_700_000_000_000;

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  exchangeMode.disconnect();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setConnectionState auto-retry scheduling', () => {
  it('schedules a single network auto-retry on network_error', () => {
    exchangeMode.setConnectionState('network_error', 'offline');
    const s = exchangeMode.get();

    expect(s.connectionState).toBe('network_error');
    expect(s.connectionError).toBe('offline');
    expect(s.autoRetryReason).toBe('network');
    expect(s.autoRetryAt).toBe(FIXED_NOW + AUTO_RETRY_NETWORK_MS);
    expect(s.autoRetryAttempted).toBeFalsy();
    expect(s.networkUp).toBe(false);
    expect(s.armed).toBe(false);
  });

  it('uses the default 30s rate-limit delay when no Retry-After is supplied', () => {
    exchangeMode.setConnectionState('rate_limited', 'throttled');
    const s = exchangeMode.get();

    expect(s.autoRetryReason).toBe('rate_limit');
    expect(s.autoRetryAt).toBe(FIXED_NOW + AUTO_RETRY_RATE_LIMIT_MS);
  });

  it('honors Retry-After hint for rate_limited (longer than default)', () => {
    exchangeMode.setConnectionState('rate_limited', 'throttled', 60_000);
    const s = exchangeMode.get();

    expect(s.autoRetryReason).toBe('rate_limit');
    expect(s.autoRetryAt).toBe(FIXED_NOW + 60_000);
  });

  it('honors Retry-After hint for rate_limited (shorter than default)', () => {
    exchangeMode.setConnectionState('rate_limited', 'throttled', 7_500);
    expect(exchangeMode.get().autoRetryAt).toBe(FIXED_NOW + 7_500);
  });

  it('clamps tiny Retry-After values to a 1s minimum to avoid retry storms', () => {
    exchangeMode.setConnectionState('rate_limited', 'throttled', 50);
    expect(exchangeMode.get().autoRetryAt).toBe(FIXED_NOW + 1_000);
  });

  it('only schedules one auto-retry per error cycle (network)', () => {
    exchangeMode.setConnectionState('network_error');
    expect(exchangeMode.get().autoRetryAt).toBe(FIXED_NOW + AUTO_RETRY_NETWORK_MS);

    // The retry runs and fails again — mark it consumed, then re-enter the error.
    exchangeMode.markAutoRetryConsumed();
    expect(exchangeMode.get().autoRetryAttempted).toBe(true);
    expect(exchangeMode.get().autoRetryAt).toBeUndefined();

    vi.setSystemTime(FIXED_NOW + 10_000);
    exchangeMode.setConnectionState('network_error');

    const s = exchangeMode.get();
    expect(s.connectionState).toBe('network_error');
    expect(s.autoRetryAt).toBeUndefined();
    expect(s.autoRetryReason).toBeUndefined();
    expect(s.autoRetryAttempted).toBe(true);
  });

  it('only schedules one auto-retry per error cycle (rate limit)', () => {
    exchangeMode.setConnectionState('rate_limited', undefined, 5_000);
    expect(exchangeMode.get().autoRetryAt).toBe(FIXED_NOW + 5_000);

    exchangeMode.markAutoRetryConsumed();
    vi.setSystemTime(FIXED_NOW + 10_000);
    exchangeMode.setConnectionState('rate_limited', undefined, 5_000);

    expect(exchangeMode.get().autoRetryAt).toBeUndefined();
    expect(exchangeMode.get().autoRetryReason).toBeUndefined();
  });
});

describe('schedule is cleared on clean states', () => {
  beforeEach(() => {
    exchangeMode.setConnectionState('network_error');
    expect(exchangeMode.get().autoRetryAt).toBeDefined();
  });

  it('clears the schedule and resets the one-shot flag on connected', () => {
    exchangeMode.markAutoRetryConsumed();
    expect(exchangeMode.get().autoRetryAttempted).toBe(true);

    exchangeMode.setConnectionState('connected');
    const s = exchangeMode.get();
    expect(s.autoRetryAt).toBeUndefined();
    expect(s.autoRetryReason).toBeUndefined();
    expect(s.autoRetryAttempted).toBe(false);
    expect(s.networkUp).toBe(true);
  });

  it('clears the schedule on balance_loaded and balance_empty', () => {
    exchangeMode.setConnectionState('balance_loaded');
    expect(exchangeMode.get().autoRetryAt).toBeUndefined();
    expect(exchangeMode.get().autoRetryAttempted).toBe(false);

    exchangeMode.setConnectionState('network_error');
    exchangeMode.markAutoRetryConsumed();
    exchangeMode.setConnectionState('balance_empty');
    expect(exchangeMode.get().autoRetryAt).toBeUndefined();
    expect(exchangeMode.get().autoRetryAttempted).toBe(false);
  });

  it('clears the schedule on disconnected and keys_saved', () => {
    exchangeMode.setConnectionState('keys_saved');
    expect(exchangeMode.get().autoRetryAt).toBeUndefined();
    expect(exchangeMode.get().autoRetryAttempted).toBe(false);

    exchangeMode.setConnectionState('network_error');
    exchangeMode.setConnectionState('disconnected');
    expect(exchangeMode.get().autoRetryAt).toBeUndefined();
    expect(exchangeMode.get().autoRetryAttempted).toBe(false);
  });
});

describe('schedule is cancelled (but not consumed) on transient/error transitions', () => {
  beforeEach(() => {
    exchangeMode.setConnectionState('network_error');
  });

  it.each(['validating', 'invalid_credentials', 'permission_denied', 'balance_error'] as const)(
    'cancels schedule but keeps autoRetryAttempted untouched on %s',
    (target) => {
      // Pretend the one-shot has already fired so we can prove these
      // transitions DO NOT reset the flag (only clean states do).
      exchangeMode.markAutoRetryConsumed();
      expect(exchangeMode.get().autoRetryAttempted).toBe(true);

      exchangeMode.setConnectionState(target);
      const s = exchangeMode.get();
      expect(s.autoRetryAt).toBeUndefined();
      expect(s.autoRetryReason).toBeUndefined();
      expect(s.autoRetryAttempted).toBe(true);
    },
  );
});

describe('disconnect / setMode / setExchange clear the schedule', () => {
  it('disconnect() clears auto-retry fields and resets the one-shot flag', () => {
    exchangeMode.setConnectionState('network_error');
    exchangeMode.markAutoRetryConsumed();

    exchangeMode.disconnect();
    const s = exchangeMode.get();
    expect(s.autoRetryAt).toBeUndefined();
    expect(s.autoRetryReason).toBeUndefined();
    expect(s.autoRetryAttempted).toBe(false);
    expect(s.connectionState).toBe('disconnected');
  });

  it('setMode() clears auto-retry fields and resets the one-shot flag', () => {
    exchangeMode.setConnectionState('rate_limited');
    exchangeMode.markAutoRetryConsumed();

    exchangeMode.setMode('paper');
    const s = exchangeMode.get();
    expect(s.mode).toBe('paper');
    expect(s.autoRetryAt).toBeUndefined();
    expect(s.autoRetryReason).toBeUndefined();
    expect(s.autoRetryAttempted).toBe(false);
  });

  it('setExchange() clears auto-retry fields and resets the one-shot flag', () => {
    exchangeMode.setConnectionState('network_error');
    exchangeMode.markAutoRetryConsumed();

    exchangeMode.setExchange('kraken');
    const s = exchangeMode.get();
    expect(s.exchange).toBe('kraken');
    expect(s.autoRetryAt).toBeUndefined();
    expect(s.autoRetryReason).toBeUndefined();
    expect(s.autoRetryAttempted).toBe(false);
  });
});

describe('cancelAutoRetry', () => {
  it('clears the pending schedule without setting the one-shot flag', () => {
    exchangeMode.setConnectionState('network_error');
    expect(exchangeMode.get().autoRetryAt).toBeDefined();

    exchangeMode.cancelAutoRetry();
    const s = exchangeMode.get();
    expect(s.autoRetryAt).toBeUndefined();
    expect(s.autoRetryReason).toBeUndefined();
    // Crucially NOT consumed — a manual retry that fails should still be
    // allowed to schedule a fresh one-shot auto-retry.
    expect(s.autoRetryAttempted).toBeFalsy();
    // Connection state itself is untouched.
    expect(s.connectionState).toBe('network_error');
  });

  it('is a no-op when there is no pending schedule', () => {
    const before = exchangeMode.get();
    exchangeMode.cancelAutoRetry();
    const after = exchangeMode.get();
    expect(after).toEqual(before);
  });

  it('allows a fresh auto-retry to be scheduled after cancellation', () => {
    exchangeMode.setConnectionState('network_error');
    exchangeMode.cancelAutoRetry();

    vi.setSystemTime(FIXED_NOW + 15_000);
    exchangeMode.setConnectionState('network_error');

    const s = exchangeMode.get();
    expect(s.autoRetryAt).toBe(FIXED_NOW + 15_000 + AUTO_RETRY_NETWORK_MS);
    expect(s.autoRetryReason).toBe('network');
  });
});

describe('markAutoRetryConsumed', () => {
  it('clears the schedule and prevents a second auto-retry until a clean state', () => {
    exchangeMode.setConnectionState('network_error');
    exchangeMode.markAutoRetryConsumed();

    // Retry happens and fails again with the same class — must NOT reschedule.
    vi.setSystemTime(FIXED_NOW + AUTO_RETRY_NETWORK_MS);
    exchangeMode.setConnectionState('network_error');
    expect(exchangeMode.get().autoRetryAt).toBeUndefined();

    // A different transient class also must not get a free retry.
    exchangeMode.setConnectionState('rate_limited', undefined, 2_000);
    expect(exchangeMode.get().autoRetryAt).toBeUndefined();

    // After a clean state the one-shot resets.
    exchangeMode.setConnectionState('connected');
    expect(exchangeMode.get().autoRetryAttempted).toBe(false);

    vi.setSystemTime(FIXED_NOW + 60_000);
    exchangeMode.setConnectionState('network_error');
    expect(exchangeMode.get().autoRetryAt).toBe(FIXED_NOW + 60_000 + AUTO_RETRY_NETWORK_MS);
  });
});
