// ─── Execution Engine — upfront SELL gate (vitest) ────────────────────────────
// Covers the two requirements from Task #77 review:
//   1) Upfront-blocked SELL: a SELL of an asset whose value is below the cached
//      symbol's minNotional must be rejected BEFORE any network call, with the
//      doctor's dust mark applied.
//   2) Cooldown-not-bumped: the per-(exchange,symbol) `feNoteFailure` counter
//      must NOT be incremented for that reject — otherwise a single dust asset
//      would push the symbol into `cooldown_active` and snowball across the
//      fleet (the original v1.5.0 production bug).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api-client BEFORE importing the engine so isBackendReachable
// always resolves true and no real network call is attempted.
vi.mock('./api-client.js', () => ({
  apiClient: {
    getPrice: vi.fn(async () => ({ ok: true, data: { price: 0.5 } })),
    getSymbolRules: vi.fn(async () => ({
      ok: true,
      data: {
        rules: {
          symbol: 'XRPUSDT',
          minQty: 0.0001,
          maxQty: 1e9,
          stepSize: 0.0001,
          minNotional: 10,
          tickSize: 0.0001,
          quoteCurrency: 'USDT',
          baseCurrency: 'XRP',
          filterSource: 'live',
        },
      },
    })),
    getBalances: vi.fn(async () => ({ ok: true, data: { balances: [] } })),
    placeOrder: vi.fn(async () => ({ ok: false, error: 'not expected in upfront-sell test' })),
  },
  isBackendReachable:  vi.fn(async () => true),
}));

import { executeSignal, _tests, setCredentials } from './execution-engine.js';
import { exchangeMode } from './exchange-mode.js';
import { recordBuy, _resetInternalPositions } from './internal-positions.js';
import { pipelineCache } from './pipeline-cache.js';
import { botDoctorStore } from './bot-doctor-store.js';
import { executionLog, REJECT } from './execution-log.js';

const EX  = 'binance';
const SYM = 'XRP';            // arena symbol form (catalog key)
const EX_SYM = 'XRPUSDT';     // resolved exchange-side symbol
const ASSET = 'XRP';

function makeRealReady() {
  exchangeMode.update({
    mode:            'real',
    exchange:        EX,
    networkUp:       true,
    apiValidated:    true,
    balanceFetched:  true,
    armed:           true,
    permissions:     { read: true, trade: true, withdraw: false },
  });
}

function makeSellSignal(price: number) {
  return {
    id:     `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    symbol: SYM,
    side:   'sell' as const,
    price,
    ts:     Date.now(),
    source: 'unit-test',
  };
}

describe('execution-engine — upfront SELL min-notional gate', () => {
  beforeEach(() => {
    _tests.resetCounters();
    _resetInternalPositions();
    executionLog.clear();
    pipelineCache.clearAll();
    botDoctorStore.reset();
    setCredentials({ apiKey: 'k', apiSecret: 's' } as never);
    makeRealReady();
  });

  it('rejects a SELL whose owned-notional is below the cached minNotional, marks dust, and never calls the network', async () => {
    // Owned 5 XRP @ $0.50 → notional $2.50, below $10 minNotional.
    recordBuy(EX, ASSET, 5, 0.5);
    pipelineCache.set(`rules:${EX}:${EX_SYM}`, {
      symbol: EX_SYM, minQty: 0.0001, maxQty: 1e9, stepSize: 0.0001,
      minNotional: 10, tickSize: 0.0001,
    }, 600_000);

    const res = await executeSignal(makeSellSignal(0.5));

    expect(res.ok).toBe(false);
    expect(res.rejectReason).toBe(REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL);
    expect(res.detail).toMatch(/minNotional/i);
    expect(res.detail).toMatch(/\$10/);

    expect(botDoctorStore.isDust(EX, ASSET)).toBe(true);
    const dust = botDoctorStore.dustList().find(d => d.exchange === EX && d.baseAsset === ASSET);
    expect(dust?.reason).toContain(REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL);
    expect(dust?.reason).toMatch(/minNotional/i);

    // Fresh market quote is fetched before sizing/validation, but order
    // submission must still be short-circuited by the upfront dust gate.
    const { apiClient } = await import('./api-client.js');
    expect((apiClient.getPrice as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    expect((apiClient.placeOrder as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it('does NOT bump the per-symbol cooldown counter when blocked by the upfront gate (cooldown_active spam fix)', async () => {
    recordBuy(EX, ASSET, 5, 0.5);
    pipelineCache.set(`rules:${EX}:${EX_SYM}`, {
      symbol: EX_SYM, minQty: 0.0001, maxQty: 1e9, stepSize: 0.0001,
      minNotional: 10, tickSize: 0.0001,
    }, 600_000);

    expect(_tests.getFeFails(EX, SYM, 'real')).toBe(0);

    // Fire 5 times — well past the FE_FAILURE_THRESHOLD of 3.
    // Iteration 1 hits the upfront SELL gate (OWNED_QTY_BELOW_MIN_NOTIONAL)
    // and applies the dust mark. Subsequent iterations hit the slightly
    // earlier Doctor dust gate (BELOW_MIN_NOTIONAL). Both paths are dust
    // rejects and BOTH must skip feNoteFailure — that is the whole fix.
    const dustRejects: string[] = [REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL, REJECT.BELOW_MIN_NOTIONAL];
    for (let i = 0; i < 5; i++) {
      // Each call needs a unique signal id (duplicate guard).
      const r = await executeSignal(makeSellSignal(0.5));
      expect(r.ok).toBe(false);
      expect(dustRejects).toContain(r.rejectReason);
    }

    // The whole point of Task #77: dust rejects must never escalate.
    expect(_tests.getFeFails(EX, SYM, 'real')).toBe(0);
  });
});
