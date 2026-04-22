// ─── Execution Engine Internal Tests ──────────────────────────────────────────
// Run from browser console: import('/src/lib/execution-engine.test.ts').then(m => m.runAll())
// These are lightweight in-process tests, no external runner needed.

import { exchangeMode }   from './exchange-mode.js';
import { tradeConfig }    from './trade-config.js';
import { executionLog }   from './execution-log.js';
import { executeSignal, _tests, setCredentials } from './execution-engine.js';
import { validateRisk }   from './risk-manager.js';
import { REJECT }         from './execution-log.js';

type TestResult = { name: string; ok: boolean; error?: string };

async function test(name: string, fn: () => Promise<void> | void): Promise<TestResult> {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    return { name, ok: true };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error(`  ❌ FAIL: ${name} — ${msg}`);
    return { name, ok: false, error: msg };
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function makeSignal(overrides: Partial<{ id: string; symbol: string; side: 'buy' | 'sell'; price: number }> = {}) {
  return {
    id:     `test_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    symbol: 'BTCUSDT',
    side:   'buy' as const,
    price:  84000,
    ts:     Date.now(),
    source: 'test',
    ...overrides,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

export async function runAll(): Promise<void> {
  console.group('%c[SignalX Engine Tests]', 'color: #4ade80; font-weight: bold');
  const results: TestResult[] = [];

  // Reset state before suite
  _tests.resetCounters();
  executionLog.clear();
  setCredentials(null);

  // T1: Demo mode — never places live orders
  results.push(await test('demo mode never places live order', async () => {
    exchangeMode.update({ mode: 'demo', apiValidated: false, armed: false });
    const res = await executeSignal(makeSignal());
    assert(res.ok, 'Demo signal should succeed');
    assert(!!res.demo, 'Result should be marked as demo');
    const entry = executionLog.all()[0];
    assert(entry.mode === 'demo', 'Log entry mode should be demo');
    assert(!entry.orderId?.startsWith('real'), 'orderId should not be a real order');
  }));

  // T2: Live mode blocked when not armed
  results.push(await test('live mode blocked when not armed', async () => {
    _tests.resetCounters();
    exchangeMode.update({ mode: 'live', apiValidated: true, armed: false, permissions: { read: true, trade: true, withdraw: false, futures: false } });
    setCredentials({ apiKey: 'test', secretKey: 'test' });
    const res = await executeSignal(makeSignal());
    assert(!res.ok, 'Should be rejected when not armed');
    assert(res.rejectReason === REJECT.BOT_NOT_ARMED, `Expected BOT_NOT_ARMED, got ${res.rejectReason}`);
  }));

  // T3: Live mode blocked when no trade permission
  results.push(await test('live mode blocked when no trade permission', async () => {
    _tests.resetCounters();
    exchangeMode.update({ mode: 'live', apiValidated: true, armed: true, permissions: { read: true, trade: false, withdraw: false, futures: false } });
    setCredentials({ apiKey: 'test', secretKey: 'test' });
    const res = await executeSignal(makeSignal());
    assert(!res.ok, 'Should be rejected without trade permission');
    assert(res.rejectReason === REJECT.NO_TRADE_PERMISSION, `Expected NO_TRADE_PERMISSION, got ${res.rejectReason}`);
  }));

  // T4: Live mode blocked — not validated
  results.push(await test('live mode blocked when api not validated', async () => {
    _tests.resetCounters();
    exchangeMode.update({ mode: 'live', apiValidated: false, armed: true, permissions: { read: true, trade: true, withdraw: false, futures: false } });
    setCredentials({ apiKey: 'test', secretKey: 'test' });
    const res = await executeSignal(makeSignal());
    assert(!res.ok, 'Should be rejected when API not validated');
    assert(res.rejectReason === REJECT.ADAPTER_NOT_READY, `Expected ADAPTER_NOT_READY, got ${res.rejectReason}`);
  }));

  // T5: Insufficient balance rejection (risk manager)
  results.push(await test('insufficient balance rejection', () => {
    const risk = validateRisk({
      exchange: 'binance', symbol: 'BTCUSDT', side: 'buy',
      price: 84000, amountUSD: 10000, availableUSD: 50, // only $50 available
      openPositions: 0, dailyTradeCount: 0, lastTradeTs: 0,
      signalId: 'test', recentSignals: [],
      symbolRules: { symbol: 'BTCUSDT', minQty: 0.00001, maxQty: 9000000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 },
      config: tradeConfig.get('binance'),
    });
    assert(!risk.ok, 'Should reject due to insufficient balance');
    assert(risk.reason === REJECT.INSUFFICIENT_BALANCE, `Expected INSUFFICIENT_BALANCE, got ${risk.reason}`);
  }));

  // T6: Cooldown active rejection
  results.push(await test('cooldown active rejection', () => {
    const cfg = tradeConfig.get('binance');
    cfg.cooldownSeconds = 30;
    const risk = validateRisk({
      exchange: 'binance', symbol: 'BTCUSDT', side: 'buy',
      price: 84000, amountUSD: 100, availableUSD: 10000,
      openPositions: 0, dailyTradeCount: 0,
      lastTradeTs: Date.now() - 10_000, // 10s ago, cooldown = 30s
      signalId: 'test2', recentSignals: [],
      symbolRules: { symbol: 'BTCUSDT', minQty: 0.00001, maxQty: 9000000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 },
      config: cfg,
    });
    assert(!risk.ok, 'Should reject due to cooldown');
    assert(risk.reason === REJECT.COOLDOWN_ACTIVE, `Expected COOLDOWN_ACTIVE, got ${risk.reason}`);
  }));

  // T7: Max daily trades rejection
  results.push(await test('max daily trades rejection', () => {
    const cfg = tradeConfig.get('binance');
    cfg.maxDailyTrades = 5;
    const risk = validateRisk({
      exchange: 'binance', symbol: 'BTCUSDT', side: 'buy',
      price: 84000, amountUSD: 100, availableUSD: 10000,
      openPositions: 0, dailyTradeCount: 5, lastTradeTs: 0,
      signalId: 'test3', recentSignals: [],
      symbolRules: { symbol: 'BTCUSDT', minQty: 0.00001, maxQty: 9000000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 },
      config: cfg,
    });
    assert(!risk.ok, 'Should reject due to max daily trades');
    assert(risk.reason === REJECT.MAX_DAILY_TRADES, `Expected MAX_DAILY_TRADES, got ${risk.reason}`);
  }));

  // T8: Duplicate signal rejection
  results.push(await test('duplicate signal prevention', () => {
    const cfg = tradeConfig.get('binance');
    const risk = validateRisk({
      exchange: 'binance', symbol: 'BTCUSDT', side: 'buy',
      price: 84000, amountUSD: 100, availableUSD: 10000,
      openPositions: 0, dailyTradeCount: 0, lastTradeTs: 0,
      signalId: 'dup_signal_xyz',
      recentSignals: ['dup_signal_xyz'], // already processed
      symbolRules: { symbol: 'BTCUSDT', minQty: 0.00001, maxQty: 9000000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 },
      config: cfg,
    });
    assert(!risk.ok, 'Should reject duplicate signal');
    assert(risk.reason === REJECT.DUPLICATE_SIGNAL, `Expected DUPLICATE_SIGNAL, got ${risk.reason}`);
  }));

  // T9: Exchange switch clears stale state
  results.push(await test('exchange switch clears stale state', () => {
    exchangeMode.update({ mode: 'live', apiValidated: true, armed: true });
    exchangeMode.setExchange('kucoin');
    const state = exchangeMode.get();
    assert(state.exchange === 'kucoin', 'Exchange should be kucoin');
    assert(!state.armed, 'Armed should be cleared after exchange switch');
    assert(!state.apiValidated, 'apiValidated should be cleared after exchange switch');
  }));

  // T10: Unsupported symbol rejection (only-long + sell)
  results.push(await test('unsupported symbol rejection (sell in only-long mode)', () => {
    const cfg = tradeConfig.get('binance');
    cfg.onlyLong = true;
    const risk = validateRisk({
      exchange: 'binance', symbol: 'BTCUSDT', side: 'sell',
      price: 84000, amountUSD: 100, availableUSD: 10000,
      openPositions: 0, dailyTradeCount: 0, lastTradeTs: 0,
      signalId: 'sell_test', recentSignals: [],
      symbolRules: { symbol: 'BTCUSDT', minQty: 0.00001, maxQty: 9000000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 },
      config: cfg,
    });
    assert(!risk.ok, 'Should reject sell in only-long mode');
    assert(risk.reason === REJECT.ONLY_LONG_MODE_BLOCKS_SELL, `Expected ONLY_LONG_MODE_BLOCKS_SELL, got ${risk.reason}`);
  }));

  // T11: Emergency stop
  results.push(await test('emergency stop rejects all trades', () => {
    const cfg = tradeConfig.get('binance');
    cfg.emergencyStop = true;
    const risk = validateRisk({
      exchange: 'binance', symbol: 'BTCUSDT', side: 'buy',
      price: 84000, amountUSD: 100, availableUSD: 10000,
      openPositions: 0, dailyTradeCount: 0, lastTradeTs: 0,
      signalId: 'stop_test', recentSignals: [],
      symbolRules: { symbol: 'BTCUSDT', minQty: 0.00001, maxQty: 9000000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 },
      config: cfg,
    });
    assert(!risk.ok, 'Should reject when emergency stop is active');
    assert(risk.reason === REJECT.EMERGENCY_STOP, `Expected EMERGENCY_STOP, got ${risk.reason}`);
    cfg.emergencyStop = false; // cleanup
  }));

  // T12: Successful risk check + quantity computation
  results.push(await test('successful risk check computes correct quantity', () => {
    const cfg = tradeConfig.get('binance');
    cfg.emergencyStop = false;
    cfg.onlyLong = false;
    cfg.maxDailyTrades = 0;
    cfg.cooldownSeconds = 0;
    const risk = validateRisk({
      exchange: 'binance', symbol: 'BTCUSDT', side: 'buy',
      price: 84000, amountUSD: 1000, availableUSD: 50000,
      openPositions: 0, dailyTradeCount: 0, lastTradeTs: 0,
      signalId: 'ok_signal', recentSignals: [],
      symbolRules: { symbol: 'BTCUSDT', minQty: 0.00001, maxQty: 9000000, stepSize: 0.00001, minNotional: 1, tickSize: 0.01 },
      config: cfg,
    });
    assert(risk.ok, `Risk check should pass, got: ${risk.reason}`);
    const expectedQty = 1000 / 84000;
    assert(Math.abs((risk.quantity ?? 0) - expectedQty) < 0.001, `Quantity mismatch: ${risk.quantity} vs ~${expectedQty}`);
  }));

  // T13 + T14 — Task #77 upfront SELL gate (browser-side counterpart of
  // execution-engine.upfront-sell.unit.test.ts; full coverage lives in vitest).
  results.push(await test('upfront SELL gate rejects dust SELL before network', async () => {
    const { recordBuy, _resetInternalPositions } = await import('./internal-positions.js');
    const { pipelineCache } = await import('./pipeline-cache.js');
    const { botDoctorStore } = await import('./bot-doctor-store.js');
    _tests.resetCounters();
    _resetInternalPositions();
    pipelineCache.clearAll();
    botDoctorStore.reset();
    setCredentials({ apiKey: 'k', apiSecret: 's' } as never);
    exchangeMode.update({
      mode: 'real', exchange: 'binance',
      networkUp: true, apiValidated: true, balanceFetched: true, armed: true,
      permissions: { read: true, trade: true, withdraw: false },
    });
    recordBuy('binance', 'XRP', 5, 0.5);
    pipelineCache.set('rules:binance:XRPUSDT', {
      symbol: 'XRPUSDT', minQty: 0.0001, maxQty: 1e9, stepSize: 0.0001,
      minNotional: 10, tickSize: 0.0001,
    }, 600_000);
    const res = await executeSignal(makeSignal({ symbol: 'XRP', side: 'sell', price: 0.5 }));
    assert(!res.ok, 'Dust SELL must be rejected by upfront gate');
    assert(res.rejectReason === REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL,
      `Reject reason should be OWNED_QTY_BELOW_MIN_NOTIONAL, got: ${res.rejectReason}`);
    assert(botDoctorStore.isDust('binance', 'XRP'), 'Dust mark must be applied');
  }));

  results.push(await test('upfront SELL gate does NOT bump per-symbol cooldown counter', async () => {
    const { recordBuy, _resetInternalPositions } = await import('./internal-positions.js');
    const { pipelineCache } = await import('./pipeline-cache.js');
    const { botDoctorStore } = await import('./bot-doctor-store.js');
    _tests.resetCounters();
    _resetInternalPositions();
    pipelineCache.clearAll();
    botDoctorStore.reset();
    setCredentials({ apiKey: 'k', apiSecret: 's' } as never);
    exchangeMode.update({
      mode: 'real', exchange: 'binance',
      networkUp: true, apiValidated: true, balanceFetched: true, armed: true,
      permissions: { read: true, trade: true, withdraw: false },
    });
    recordBuy('binance', 'XRP', 5, 0.5);
    pipelineCache.set('rules:binance:XRPUSDT', {
      symbol: 'XRPUSDT', minQty: 0.0001, maxQty: 1e9, stepSize: 0.0001,
      minNotional: 10, tickSize: 0.0001,
    }, 600_000);
    // Iter 1: upfront gate (OWNED_QTY_BELOW_MIN_NOTIONAL). Iter 2+: doctor
    // dust gate (BELOW_MIN_NOTIONAL). Both must skip feNoteFailure.
    for (let i = 0; i < 5; i++) {
      const r = await executeSignal(makeSignal({ symbol: 'XRP', side: 'sell', price: 0.5 }));
      const isDustReject = !r.ok && (r.rejectReason === REJECT.OWNED_QTY_BELOW_MIN_NOTIONAL ||
                                     r.rejectReason === REJECT.BELOW_MIN_NOTIONAL);
      assert(isDustReject, `Iteration ${i} should be a dust reject, got: ${r.rejectReason}`);
    }
    const fails = _tests.getFeFails('binance', 'XRP', 'real');
    assert(fails === 0, `feFails for binance:XRP must remain 0, got ${fails}`);
  }));

  // Summary
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.groupEnd();
  console.log(`\n%c[SignalX Engine Tests] ${passed}/${results.length} passed${failed > 0 ? ` · ${failed} failed` : ' ✅'}`, 
    failed > 0 ? 'color: #ef4444; font-weight: bold' : 'color: #4ade80; font-weight: bold');

  if (failed > 0) {
    console.table(results.filter(r => !r.ok).map(r => ({ Test: r.name, Error: r.error })));
  }
}

// Auto-run in dev
if (import.meta.env.DEV) {
  runAll();
}
