// ─── Live Execution Bridge — integration tests ────────────────────────────────
// These tests close the regression gap left by the executeSignal unit tests:
// they verify the THREE wiring points (bot tick, AutoPilot decision loop,
// Manual Order form) actually invoke executeSignal with the right Signal
// shape. A future change that quietly removes any of these wires would
// silently turn the app back into demo mode in real/testnet — exactly the
// bug task #54 fixed. These tests catch that immediately.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the engine and the api-client BEFORE importing the bridge so the
// module under test picks up the mocked references.
vi.mock('./execution-engine.js', () => ({
  executeSignal: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock('./api-client.js', () => ({
  apiClient: {
    getPrice: vi.fn(),
  },
  isBackendReachable: vi.fn().mockResolvedValue(true),
}));

import { executeSignal } from './execution-engine.js';
import { apiClient } from './api-client.js';
import { exchangeMode } from './exchange-mode.js';
import {
  bridgeBotTradeToExchange,
  dispatchAutoPilotLiveSignal,
  submitManualOrder,
  __resetUnsupportedAssetWarnings,
} from './live-execution-bridge.js';
import type { Trade } from './storage.js';
import type { AutoPilotDecision, BotEvaluation } from './autopilot.js';
import type { Bot } from './storage.js';

const mockExecute  = vi.mocked(executeSignal);
const mockGetPrice = vi.mocked(apiClient.getPrice);

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id:        't_abc123',
    botId:     'bot_1',
    symbol:    'BTC',
    type:      'BUY',
    price:     84_000,
    quantity:  0.01,
    timestamp: 1_700_000_000_000,
    pnl:       0,
    indicators: '',
    ...overrides,
  };
}

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot_1',
    name: 'Test Bot',
    symbol: 'BTC',
    strategy: 'RSI',
    balance: 1000,
    startingBalance: 1000,
    position: 0,
    avgEntryPrice: 0,
    trades: [],
    isRunning: true,
    createdAt: 0,
    color: '#fff',
    ...overrides,
  };
}

function makeDecision(
  action: 'BUY' | 'SELL' | 'HOLD',
  bot?: Partial<Bot>,
): AutoPilotDecision {
  const evalSelected: BotEvaluation | null = action === 'HOLD' && !bot
    ? null
    : {
        bot: makeBot(bot),
        score: 80, pnl: 0, pnlPct: 0, winRate: 60, drawdown: 0,
        tradeCount: 5, recentWins: 3, recentLosses: 2,
        health: 'good', action, confidence: 80, reasons: [],
      };
  return {
    selectedBot:    evalSelected,
    topBots:        evalSelected ? [evalSelected] : [],
    riskLevel:      'SAFE',
    riskReason:     '',
    masterAction:   action,
    portfolioPnL:   0,
    portfolioPnLPct: 0,
    activeBotCount: 1,
    timestamp:      0,
  };
}

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({
    ok: true, orderId: 'order_xyz', logId: 'log_1',
  });
  mockGetPrice.mockReset();
  __resetUnsupportedAssetWarnings();
  exchangeMode.disconnect();
  // Put the mode singleton in a fully-armed real state so the bridge
  // helpers see "live trading" without the engine actually running.
  exchangeMode.update({
    mode:           'real',
    exchange:       'binance',
    armed:          true,
    apiValidated:   true,
    balanceFetched: true,
    networkUp:      true,
    permissions:    { read: true, trade: true, withdraw: false, futures: false },
    connectionState: 'balance_loaded',
  });
});

// ─── 1. Bot tick → engine ─────────────────────────────────────────────────────

describe('bridgeBotTradeToExchange (bot tick → engine)', () => {
  it('forwards a bot Trade to executeSignal with a matching Signal in REAL mode', async () => {
    const trade = makeTrade();
    const promise = bridgeBotTradeToExchange(trade);
    expect(promise).not.toBeNull();
    await promise;

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith({
      id:     'bot_t_abc123',
      symbol: 'BTC',
      side:   'buy',
      price:  84_000,
      ts:     1_700_000_000_000,
      source: 'bot-engine',
      botId:  'bot_1',
    });
  });

  it('maps SELL trades to side="sell"', async () => {
    await bridgeBotTradeToExchange(makeTrade({ type: 'SELL', id: 't_sell' }));
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bot_t_sell', side: 'sell' }),
    );
  });

  it('forwards in TESTNET mode too', async () => {
    exchangeMode.setMode('testnet');
    await bridgeBotTradeToExchange(makeTrade());
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('returns null and skips the engine in DEMO mode', () => {
    exchangeMode.setMode('demo');
    expect(bridgeBotTradeToExchange(makeTrade())).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns null and skips the engine in PAPER mode', () => {
    exchangeMode.setMode('paper');
    expect(bridgeBotTradeToExchange(makeTrade())).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('skips non-crypto symbols (e.g. AAPL)', () => {
    expect(bridgeBotTradeToExchange(makeTrade({ symbol: 'AAPL' }))).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ─── 2. AutoPilot decision → engine ───────────────────────────────────────────

describe('dispatchAutoPilotLiveSignal (autopilot → engine)', () => {
  it('dispatches once on a BUY transition and surfaces a Signal with the right fields', async () => {
    const out = await dispatchAutoPilotLiveSignal({
      decision:        makeDecision('BUY'),
      lastDispatch:    null,
      getCurrentPrice: () => 84_000,
    });

    expect(out.dispatched).toBe(true);
    expect(out.newLast).toEqual({ botId: 'bot_1', action: 'BUY' });
    expect(mockExecute).toHaveBeenCalledTimes(1);

    const sig = mockExecute.mock.calls[0][0];
    expect(sig).toMatchObject({
      symbol: 'BTC',
      side:   'buy',
      price:  84_000,
      source: 'autopilot',
    });
    expect(sig.id).toMatch(/^autopilot_bot_1_BUY_\d+$/);
  });

  it('does NOT call the engine again on the next decision cycle while the action stays the same', async () => {
    const decision = makeDecision('BUY');
    const out1 = await dispatchAutoPilotLiveSignal({
      decision, lastDispatch: null, getCurrentPrice: () => 84_000,
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);

    const out2 = await dispatchAutoPilotLiveSignal({
      decision,                       // identical decision
      lastDispatch:    out1.newLast,  // caller carries the latch forward
      getCurrentPrice: () => 84_000,
    });
    expect(out2.dispatched).toBe(false);
    expect(out2.reason).toBe('duplicate');
    expect(mockExecute).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it('does NOT latch on engine rejection — next cycle retries', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: false, rejectReason: 'BOT_NOT_ARMED', detail: 'arm first',
    });
    const out1 = await dispatchAutoPilotLiveSignal({
      decision:        makeDecision('BUY'),
      lastDispatch:    null,
      getCurrentPrice: () => 84_000,
    });
    expect(out1.dispatched).toBe(true);
    expect(out1.newLast).toBeNull();

    // Next cycle the engine accepts; because the previous attempt did not
    // latch, the helper must dispatch again rather than dedupe.
    const out2 = await dispatchAutoPilotLiveSignal({
      decision:        makeDecision('BUY'),
      lastDispatch:    out1.newLast,
      getCurrentPrice: () => 84_000,
    });
    expect(out2.dispatched).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch on HOLD and signals the caller to reset its latch', async () => {
    const out = await dispatchAutoPilotLiveSignal({
      decision:        makeDecision('HOLD'),
      lastDispatch:    { botId: 'bot_1', action: 'BUY' },
      getCurrentPrice: () => 1,
    });
    expect(out.dispatched).toBe(false);
    expect(out.reset).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('skips non-crypto symbols (stocks/metals/forex)', async () => {
    const out = await dispatchAutoPilotLiveSignal({
      decision:        makeDecision('BUY', { symbol: 'AAPL' }),
      lastDispatch:    null,
      getCurrentPrice: () => 200,
    });
    expect(out.dispatched).toBe(false);
    expect(out.reason).toBe('not-crypto');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('skips when not in live mode (DEMO)', async () => {
    exchangeMode.setMode('demo');
    const out = await dispatchAutoPilotLiveSignal({
      decision:        makeDecision('BUY'),
      lastDispatch:    null,
      getCurrentPrice: () => 84_000,
    });
    expect(out.dispatched).toBe(false);
    expect(out.reason).toBe('not-live');
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ─── 3. Manual Order form → engine ────────────────────────────────────────────

describe('submitManualOrder (manual order → engine)', () => {
  it('submits a live BUY using the price override and surfaces a success message', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: true, orderId: 'ord_777', logId: 'log_x',
    });
    const out = await submitManualOrder({
      exchangeId:    'binance',
      exchangeName:  'Binance',
      symbol:        'BTC',
      side:          'buy',
      priceOverride: '84000',
      mode:          'real',
    });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0]).toMatchObject({
      symbol: 'BTC',
      side:   'buy',
      price:  84_000,
      source: 'manual',
    });
    expect(out.ok).toBe(true);
    expect(out.message).toContain('Live BUY BTC placed');
    expect(out.message).toContain('ord_777');
  });

  it('fetches a live price via apiClient when no override is supplied', async () => {
    mockGetPrice.mockResolvedValueOnce({
      ok: true, status: 200, data: { price: 95_500 },
    });
    mockExecute.mockResolvedValueOnce({
      ok: true, orderId: 'ord_a', logId: 'log_a',
    });

    const out = await submitManualOrder({
      exchangeId:    'binance',
      exchangeName:  'Binance',
      symbol:        'ETH',
      side:          'sell',
      priceOverride: '',
      mode:          'real',
    });

    expect(mockGetPrice).toHaveBeenCalledWith('binance', 'ETH');
    expect(mockExecute.mock.calls[0][0]).toMatchObject({
      symbol: 'ETH', side: 'sell', price: 95_500, source: 'manual',
    });
    expect(out.ok).toBe(true);
  });

  it('refuses to size a live order from a placeholder when no price is available', async () => {
    mockGetPrice.mockResolvedValueOnce({ ok: false, error: 'no price', status: 500 });
    const out = await submitManualOrder({
      exchangeId:    'binance',
      exchangeName:  'Binance',
      symbol:        'BTC',
      side:          'buy',
      priceOverride: '',
      mode:          'real',
    });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('Cannot resolve a live price');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('falls back to a $1 placeholder price in DEMO mode (form stays usable)', async () => {
    mockGetPrice.mockResolvedValueOnce({ ok: false, error: 'down', status: 500 });
    mockExecute.mockResolvedValueOnce({
      ok: true, demo: true, orderId: 'demo_1', logId: 'log_d',
    });
    const out = await submitManualOrder({
      exchangeId:    'binance',
      exchangeName:  'Binance',
      symbol:        'BTC',
      side:          'buy',
      priceOverride: '',
      mode:          'demo',
    });
    expect(mockExecute.mock.calls[0][0].price).toBe(1);
    expect(out.ok).toBe(true);
    expect(out.message).toContain('Simulated BUY BTC');
  });

  it('surfaces the engine reject reason and detail to the form result', async () => {
    mockExecute.mockResolvedValueOnce({
      ok: false, rejectReason: 'BOT_NOT_ARMED', detail: 'arm first',
    });
    const out = await submitManualOrder({
      exchangeId:    'binance',
      exchangeName:  'Binance',
      symbol:        'BTC',
      side:          'buy',
      priceOverride: '84000',
      mode:          'real',
    });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('BOT_NOT_ARMED');
    expect(out.message).toContain('arm first');
  });
});
