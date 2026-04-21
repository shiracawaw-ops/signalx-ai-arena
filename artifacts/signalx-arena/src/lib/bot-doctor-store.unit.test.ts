import { beforeEach, describe, expect, it } from 'vitest';
import { botDoctorStore } from './bot-doctor-store.js';

beforeEach(() => {
  localStorage.clear();
  botDoctorStore.reset();
});

describe('botDoctorStore — modes', () => {
  it('defaults to MONITOR', () => {
    expect(botDoctorStore.getMode()).toBe('MONITOR');
    expect(botDoctorStore.canAutoAct()).toBe(false);
    expect(botDoctorStore.canDeepAct()).toBe(false);
  });

  it('AUTO_FIX enables auto-act but not deep-act', () => {
    botDoctorStore.setMode('AUTO_FIX');
    expect(botDoctorStore.canAutoAct()).toBe(true);
    expect(botDoctorStore.canDeepAct()).toBe(false);
  });

  it('FULL_ACTIVE enables both', () => {
    botDoctorStore.setMode('FULL_ACTIVE');
    expect(botDoctorStore.canAutoAct()).toBe(true);
    expect(botDoctorStore.canDeepAct()).toBe(true);
  });

  it('OFF disables everything', () => {
    botDoctorStore.setMode('OFF');
    expect(botDoctorStore.canAutoAct()).toBe(false);
    expect(botDoctorStore.canDeepAct()).toBe(false);
  });
});

describe('botDoctorStore — bench list', () => {
  it('benches with default expiry and reports isBenched', () => {
    botDoctorStore.bench('bot-1', 'high_reject_rate', '80% rejected');
    expect(botDoctorStore.isBenched('bot-1')).toBe(true);
    const e = botDoctorStore.benchEntry('bot-1');
    expect(e?.code).toBe('high_reject_rate');
    expect(e?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('manual bench is permanent (expiresAt = 0)', () => {
    botDoctorStore.bench('bot-2', 'manual', 'user paused');
    const e = botDoctorStore.benchEntry('bot-2');
    expect(e?.expiresAt).toBe(0);
  });

  it('unbench removes from list', () => {
    botDoctorStore.bench('bot-3', 'cooldown_spam', 'spam');
    botDoctorStore.unbench('bot-3');
    expect(botDoctorStore.isBenched('bot-3')).toBe(false);
  });

  it('expired bench entries are auto-pruned on read', () => {
    // bench with 1ms expiry by passing custom duration
    botDoctorStore.bench('bot-4', 'cooldown_spam', 'short', 1);
    // wait beyond expiry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(botDoctorStore.isBenched('bot-4')).toBe(false);
        resolve();
      }, 10);
    });
  });
});

describe('botDoctorStore — observe / auto-bench', () => {
  beforeEach(() => botDoctorStore.setMode('AUTO_FIX'));

  it('does NOT bench in MONITOR mode', () => {
    botDoctorStore.setMode('MONITOR');
    const code = botDoctorStore.observe({
      botId: 'b', rejectReason: 'min_notional', rejectionRate: 1, submittedRecent: 1,
      exchange: 'binance', baseAsset: 'XRP',
    });
    expect(code).toBeNull();
    expect(botDoctorStore.isBenched('b')).toBe(false);
  });

  it('benches dust + marks symbol on min_notional', () => {
    const code = botDoctorStore.observe({
      botId: 'b', rejectReason: 'owned_qty_below_min_notional',
      rejectDetail: '0.001 BTC < $10', rejectionRate: 1, submittedRecent: 1,
      exchange: 'binance', baseAsset: 'btc',
    });
    expect(code).toBe('dust_unsellable');
    expect(botDoctorStore.isBenched('b')).toBe(true);
    expect(botDoctorStore.isDust('binance', 'BTC')).toBe(true);
  });

  it('benches adapter_not_ready after 3 attempts', () => {
    expect(botDoctorStore.observe({
      botId: 'b', rejectReason: 'adapter_not_ready', rejectionRate: 1, submittedRecent: 2,
    })).toBeNull();
    expect(botDoctorStore.isBenched('b')).toBe(false);
    const code = botDoctorStore.observe({
      botId: 'b', rejectReason: 'adapter_not_ready', rejectionRate: 1, submittedRecent: 3,
    });
    expect(code).toBe('adapter_not_ready');
    expect(botDoctorStore.isBenched('b')).toBe(true);
  });

  it('benches high reject rate after enough samples', () => {
    const code = botDoctorStore.observe({
      botId: 'b', rejectReason: 'exchange_rejected', rejectionRate: 0.8, submittedRecent: 10,
    });
    expect(code).toBe('high_reject_rate');
  });

  it('does not bench on small samples', () => {
    const code = botDoctorStore.observe({
      botId: 'b', rejectReason: 'exchange_rejected', rejectionRate: 1, submittedRecent: 2,
    });
    expect(code).toBeNull();
  });
});

describe('botDoctorStore — dust map', () => {
  it('marks and clears dust', () => {
    botDoctorStore.markDust('bybit', 'doge', 'too small');
    expect(botDoctorStore.isDust('bybit', 'DOGE')).toBe(true);
    expect(botDoctorStore.isDust('bybit', 'doge')).toBe(true); // case-insensitive
    botDoctorStore.clearDust('bybit', 'DOGE');
    expect(botDoctorStore.isDust('bybit', 'DOGE')).toBe(false);
  });
});
