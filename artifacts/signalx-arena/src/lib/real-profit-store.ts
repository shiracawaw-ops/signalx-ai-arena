// ─── Real Profit Store ────────────────────────────────────────────────────────
// Single source of truth for REALIZED profit in REAL trading mode. Kept
// completely separate from the synthetic Bot.balance / paper PnL so the user
// can see the actual money movements with no mixing of score/projections.
//
// Mechanics:
//   - On every successful real BUY we open / extend a FIFO lot for that
//     exchange:base asset with the executed qty + price + fee.
//   - On every successful real SELL we close lots in FIFO order, computing
//     `realized = (sellPrice - lotEntryPrice) * matchedQty - feeShare`.
//   - Fees are accumulated into `feesPaidUSD` separately so the panel can
//     show `gross realized` and `net realized after fees` independently.
//   - Starting balance is captured the first time the store sees a non-zero
//     equity. Current equity is updated by callers (after each real-balance
//     refresh) via `setCurrentEquity`.
//
// Persistence: localStorage (`sx_real_profit_v1`). Cleared per-exchange via
// resetExchange() if the user disconnects + reconnects with new keys.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'sx_real_profit_v1';

export interface RealLot {
  qty:      number;   // remaining qty in this lot
  price:    number;   // entry price (USD)
  fee:      number;   // entry fee (USD), pro-rated as the lot is closed
  ts:       number;   // entry timestamp
  botId?:   string;   // which bot opened this lot
  symbol?:  string;   // exchange symbol (when known, e.g. BTCUSDT)
}

export interface RealProfitState {
  startingBalanceUSD: number;     // first non-zero equity ever seen
  currentEquityUSD:   number;     // last equity push from /balances
  realizedPnlUSD:     number;     // gross realized (before fees)
  feesPaidUSD:        number;     // total fees paid on real fills
  unrealizedPnlUSD:   number;     // most recent mark-to-market on open lots
  winsClosed:         number;     // # closed positions with realized > 0
  lossesClosed:       number;     // # closed positions with realized <= 0
  perBot:             Record<string, BotRealStat>;
  // FIFO inventory per exchange:baseAsset
  lots:               Record<string, RealLot[]>;
  // Append-only audit log of every closed real-mode SELL match. Capped at
  // MAX_CLOSED_TRADES so localStorage stays bounded. Powers the
  // "Real Profit Proof" panel — every entry is a real, executed trade.
  closedTrades:       ClosedRealTrade[];
  lastUpdated:        number;
}

export interface BotRealStat {
  realizedPnlUSD: number;
  feesPaidUSD:    number;
  trades:         number;
  wins:           number;
  losses:         number;
  // Last closed trade's NET realized PnL after fees.
  lastTradeNetPnlUSD?: number;
  // Day bucket keyed in local timezone.
  todayNetPnlUSD?: number;
  // Alias for readability in panels.
  lifetimeNetPnlUSD?: number;
  // Optional mirrors from other stores (activity/doctor). Kept optional so
  // this store remains the source of money truth without hard coupling.
  rejectRate?: number;
  executionQualityScore?: number;
  doctorHealthStatus?: 'healthy' | 'watch' | 'critical' | 'benched';
}

export interface ClosedRealTrade {
  // Backward-compatible timestamp field kept for older UI call sites.
  ts:           number;
  exchange:     string;
  symbol:       string;
  baseAsset:    string;
  botId?:       string;
  botName?:     string;
  quantity:     number;
  entryPrice:   number;
  exitPrice:    number;
  entryTime:    number;
  exitTime:     number;
  feesUSD:      number;     // entry fee share + sell fee share for this match
  grossPnlUSD:  number;     // (exit - entry) * qty
  netPnlUSD:    number;     // gross - feesUSD
  // Optional best-effort slippage impact in USD for this match.
  slippageImpactUSD?: number;
}

const MAX_CLOSED_TRADES = 200;

function emptyState(): RealProfitState {
  return {
    startingBalanceUSD: 0,
    currentEquityUSD:   0,
    realizedPnlUSD:     0,
    feesPaidUSD:        0,
    unrealizedPnlUSD:   0,
    winsClosed:         0,
    lossesClosed:       0,
    perBot:             {},
    lots:               {},
    closedTrades:       [],
    lastUpdated:        0,
  };
}

function lotKey(exchange: string, baseAsset: string): string {
  return `${exchange}:${baseAsset.toUpperCase()}`;
}

class RealProfitStore {
  private state: RealProfitState = emptyState();
  private listeners = new Set<(s: RealProfitState) => void>();

  constructor() { this.load(); }

  private load() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<RealProfitState>;
        this.state = { ...emptyState(), ...parsed };
        if (!this.state.perBot || typeof this.state.perBot !== 'object') this.state.perBot = {};
        if (!this.state.lots   || typeof this.state.lots   !== 'object') this.state.lots   = {};
        if (!Array.isArray(this.state.closedTrades))                     this.state.closedTrades = [];
      }
    } catch { this.state = emptyState(); }
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* full */ }
  }

  private notify() {
    const snap = this.snapshot();
    this.listeners.forEach(fn => { try { fn(snap); } catch { /* swallow */ } });
  }

  snapshot(): RealProfitState {
    return JSON.parse(JSON.stringify(this.state)) as RealProfitState;
  }

  subscribe(fn: (s: RealProfitState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called once per real-balance refresh from /balances. */
  setCurrentEquity(equityUSD: number): void {
    if (!Number.isFinite(equityUSD) || equityUSD < 0) return;
    this.state.currentEquityUSD = equityUSD;
    if (this.state.startingBalanceUSD <= 0 && equityUSD > 0) {
      this.state.startingBalanceUSD = equityUSD;
    }
    this.state.lastUpdated = Date.now();
    this.save();
    this.notify();
  }

  /** Record a successful real BUY fill. */
  recordRealBuy(input: {
    exchange: string; baseAsset: string; qty: number; price: number;
    feeUSD?: number; botId?: string; symbol?: string;
  }): void {
    const key = lotKey(input.exchange, input.baseAsset);
    const fee = Math.max(0, input.feeUSD ?? 0);
    if (!this.state.lots[key]) this.state.lots[key] = [];
    this.state.lots[key].push({
      qty:   input.qty,
      price: input.price,
      fee,
      ts:    Date.now(),
      botId: input.botId,
      symbol: input.symbol,
    });
    this.state.feesPaidUSD += fee;
    if (input.botId) this.bumpBot(input.botId, { fees: fee, trades: 1 });
    this.state.lastUpdated = Date.now();
    this.save();
    this.notify();
  }

  /**
   * Record a successful real SELL fill. Closes FIFO lots and computes
   * realized profit attributed to whichever bot opened each closed lot
   * (falls back to `botId` if the lot has none).
   */
  recordRealSell(input: {
    exchange: string; baseAsset: string; qty: number; price: number;
    feeUSD?: number; botId?: string; botName?: string; symbol?: string;
    slippageImpactUSD?: number;
  }): { realizedUSD: number; matchedQty: number } {
    const key = lotKey(input.exchange, input.baseAsset);
    const lots = this.state.lots[key] ?? [];
    const sellFee = Math.max(0, input.feeUSD ?? 0);
    let remainingToClose = input.qty;
    let realizedTotal    = 0;
    let matched          = 0;
    while (remainingToClose > 1e-12 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(lot.qty, remainingToClose);
      const lotFeeShare = lot.qty > 0 ? (lot.fee * (take / lot.qty)) : 0;
      // Pro-rate the SELL fee across the matched qty too.
      const sellFeeShare = input.qty > 0 ? (sellFee * (take / input.qty)) : 0;
      const grossRealized = (input.price - lot.price) * take;
      const netRealized   = grossRealized - lotFeeShare - sellFeeShare;
      realizedTotal += grossRealized;
      matched       += take;

      const owner = lot.botId ?? input.botId;
      if (owner) {
        this.bumpBot(owner, {
          realized: grossRealized,
          fees:     lotFeeShare + sellFeeShare,
          trades:   1,
          win:      netRealized > 0 ? 1 : 0,
          loss:     netRealized > 0 ? 0 : 1,
          lastTradeNet: netRealized,
        });
      }
      if (netRealized > 0) this.state.winsClosed   += 1;
      else                 this.state.lossesClosed += 1;

      // Append to the immutable trade ledger for the Real Profit Proof panel.
      this.state.closedTrades = [
        {
          ts:          Date.now(),
          exchange:    input.exchange,
          symbol:      input.symbol ?? lot.symbol ?? input.baseAsset.toUpperCase(),
          baseAsset:   input.baseAsset.toUpperCase(),
          quantity:    take,
          entryPrice:  lot.price,
          exitPrice:   input.price,
          entryTime:   lot.ts,
          exitTime:    Date.now(),
          feesUSD:     lotFeeShare + sellFeeShare,
          grossPnlUSD: grossRealized,
          netPnlUSD:   netRealized,
          botId:       owner,
          botName:     input.botName,
          ...(input.slippageImpactUSD !== undefined ? { slippageImpactUSD: input.slippageImpactUSD } : {}),
        },
        ...this.state.closedTrades,
      ].slice(0, MAX_CLOSED_TRADES);

      lot.qty -= take;
      lot.fee -= lotFeeShare;
      remainingToClose -= take;
      if (lot.qty <= 1e-12) lots.shift();
    }
    if (lots.length === 0) delete this.state.lots[key]; else this.state.lots[key] = lots;

    this.state.realizedPnlUSD += realizedTotal;
    this.state.feesPaidUSD    += sellFee;
    this.state.lastUpdated     = Date.now();
    this.save();
    this.notify();
    return { realizedUSD: realizedTotal, matchedQty: matched };
  }

  /** Recompute mark-to-market for open lots given a price lookup. */
  refreshUnrealized(getPrice: (exchange: string, baseAsset: string) => number | undefined): void {
    let unreal = 0;
    for (const [k, lots] of Object.entries(this.state.lots)) {
      const [exchange, base] = k.split(':');
      const p = getPrice(exchange, base);
      if (!p || p <= 0) continue;
      for (const lot of lots) {
        unreal += (p - lot.price) * lot.qty;
      }
    }
    this.state.unrealizedPnlUSD = unreal;
    this.state.lastUpdated      = Date.now();
    this.save();
    this.notify();
  }

  /** Most-recent-first list of closed REAL trades (capped). */
  getClosedTrades(limit = 50): ClosedRealTrade[] {
    return this.state.closedTrades.slice(0, Math.max(1, Math.min(limit, MAX_CLOSED_TRADES)));
  }

  /** Erase the entire realized history (use only when keys are rotated). */
  reset(): void {
    this.state = emptyState();
    this.save();
    this.notify();
  }

  resetExchange(exchange: string): void {
    for (const k of Object.keys(this.state.lots)) {
      if (k.startsWith(`${exchange}:`)) delete this.state.lots[k];
    }
    this.save();
    this.notify();
  }

  private bumpBot(botId: string, p: {
    realized?: number;
    fees?: number;
    trades?: number;
    win?: number;
    loss?: number;
    lastTradeNet?: number;
  }) {
    const cur = this.state.perBot[botId] ?? { realizedPnlUSD: 0, feesPaidUSD: 0, trades: 0, wins: 0, losses: 0 };
    cur.realizedPnlUSD += p.realized ?? 0;
    cur.feesPaidUSD    += p.fees     ?? 0;
    cur.trades         += p.trades   ?? 0;
    cur.wins           += p.win      ?? 0;
    cur.losses         += p.loss     ?? 0;
    if (p.lastTradeNet !== undefined) cur.lastTradeNetPnlUSD = p.lastTradeNet;
    const lifetimeNet = cur.realizedPnlUSD - cur.feesPaidUSD;
    cur.lifetimeNetPnlUSD = lifetimeNet;
    const todayKey = new Date().toDateString();
    const todayClosed = this.state.closedTrades.filter(t => new Date(t.exitTime).toDateString() === todayKey && t.botId === botId);
    cur.todayNetPnlUSD = todayClosed.reduce((s, t) => s + t.netPnlUSD, 0) + (p.lastTradeNet ?? 0);
    this.state.perBot[botId] = cur;
  }
}

export const realProfitStore = new RealProfitStore();

export function useRealProfit(): RealProfitState {
  const [s, setS] = useState<RealProfitState>(() => realProfitStore.snapshot());
  useEffect(() => realProfitStore.subscribe(setS), []);
  return s;
}

/**
 * Net realized profit after all fees — the single number the user cares
 * about most. Positive = real money made, negative = real money lost.
 */
export function netRealized(state: RealProfitState): number {
  return state.realizedPnlUSD - state.feesPaidUSD;
}
