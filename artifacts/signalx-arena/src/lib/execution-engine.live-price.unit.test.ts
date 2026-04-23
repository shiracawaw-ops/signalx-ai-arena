import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPriceMock, getSymbolRulesMock, getBalancesMock, placeOrderMock } = vi.hoisted(() => ({
  getPriceMock: vi.fn(),
  getSymbolRulesMock: vi.fn(),
  getBalancesMock: vi.fn(),
  placeOrderMock: vi.fn(),
}));

vi.mock('./api-client.js', () => ({
  apiClient: {
    getPrice: getPriceMock,
    getSymbolRules: getSymbolRulesMock,
    getBalances: getBalancesMock,
    placeOrder: placeOrderMock,
  },
  isBackendReachable: vi.fn(async () => true),
}));

import { executeSignal, _tests, setCredentials } from './execution-engine.js';
import { exchangeMode } from './exchange-mode.js';
import { executionLog, REJECT } from './execution-log.js';
import { _resetInternalPositions } from './internal-positions.js';
import { pipelineCache } from './pipeline-cache.js';
import { botDoctorStore } from './bot-doctor-store.js';

function makeSignal(overrides: Partial<{ price: number; side: 'buy' | 'sell'; symbol: string }> = {}) {
  return {
    id: `sig_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    symbol: 'DOGE',
    side: 'buy' as const,
    price: 0.0974,
    ts: Date.now(),
    source: 'unit-test',
    ...overrides,
  };
}

const rules = {
  symbol: 'DOGEUSDT',
  minQty: 1,
  maxQty: 9_000_000,
  stepSize: 1,
  minNotional: 5,
  tickSize: 0.00001,
  quoteCurrency: 'USDT',
  baseCurrency: 'DOGE',
  filterSource: 'live',
};

describe('execution-engine live quote pricing pipeline', () => {
  beforeEach(() => {
    _tests.resetCounters();
    executionLog.clear();
    _resetInternalPositions();
    pipelineCache.clearAll();
    botDoctorStore.reset();
    getPriceMock.mockReset();
    getSymbolRulesMock.mockReset();
    getBalancesMock.mockReset();
    placeOrderMock.mockReset();

    getSymbolRulesMock.mockResolvedValue({ ok: true, data: { rules } });
    getBalancesMock.mockResolvedValue({
      ok: true,
      data: { balances: [{ asset: 'USDT', available: 1_000 }, { asset: 'DOGE', available: 0 }] },
    });
    placeOrderMock.mockResolvedValue({
      ok: true,
      data: { order: { orderId: 'ord_live_price_1' } },
    });

    exchangeMode.update({
      mode: 'real',
      exchange: 'bybit',
      armed: true,
      apiValidated: true,
      balanceFetched: true,
      networkUp: true,
      permissions: { read: true, trade: true, withdraw: false, futures: false },
      connectionState: 'balance_loaded',
    });
    setCredentials({ apiKey: 'k', secretKey: 's' });
  });

  it('uses fresh bybit quote for sizing and logs normalized symbol + price provenance', async () => {
    getPriceMock.mockResolvedValue({ ok: true, data: { price: 0.09747 } });

    const res = await executeSignal(makeSignal({ price: 0.09745 }));
    expect(res.ok).toBe(true);

    expect(getPriceMock).toHaveBeenCalledWith('bybit', 'DOGEUSDT');
    expect(placeOrderMock).toHaveBeenCalledTimes(1);

    const attempt = placeOrderMock.mock.calls[0]?.[2];
    expect(attempt.symbol).toBe('DOGE');
    // quantity must be derived from the live quote, not the incoming signal price.
    // tradeAmountUSD defaults to 100, so floor(100 / 0.09747) = 1025 at stepSize 1.
    expect(attempt.quantity).toBe(1025);

    const logs = executionLog.all();
    const executingOrExecuted = logs.find(e => e.signalId?.startsWith('sig_'));
    expect(executingOrExecuted).toBeDefined();
    expect(executingOrExecuted?.requestedSymbol).toBe('DOGE');
    expect(executingOrExecuted?.normalizedSymbol).toBe('DOGEUSDT');
    expect(executingOrExecuted?.priceSource).toBe('bybit:spot_ticker');
    expect(executingOrExecuted?.fetchedMarketPrice).toBeCloseTo(0.09747, 8);
    expect(typeof executingOrExecuted?.quoteTimestamp).toBe('number');
    expect((executingOrExecuted?.quoteTimestamp ?? 0) > 0).toBe(true);
    expect((executingOrExecuted?.finalNotional ?? 0) > 0).toBe(true);
  });

  it('blocks order when internal price materially deviates from live bybit quote', async () => {
    getPriceMock.mockResolvedValue({ ok: true, data: { price: 0.09747 } });

    const res = await executeSignal(makeSignal({ price: 0.41 }));
    expect(res.ok).toBe(false);
    expect(res.rejectReason).toBe(REJECT.PRICE_DRIFT_TOO_LARGE);
    expect(placeOrderMock).not.toHaveBeenCalled();

    const rejected = executionLog.all()[0];
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejectReason).toBe(REJECT.PRICE_DRIFT_TOO_LARGE);
  });
});
