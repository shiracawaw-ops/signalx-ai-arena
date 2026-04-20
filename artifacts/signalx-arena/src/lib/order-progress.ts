// ─── Shared Order Progress Store ──────────────────────────────────────────────
// Subscribable, module-scoped registry of in-flight orders the UI is tracking
// from "submitting" through to a terminal phase (filled / canceled / rejected
// / timeout / error). Polls `apiClient.getOrderStatus` for live exchange
// orders and emits to subscribers whenever any tracked order changes.
//
// Used by:
//   • Balances tab    → close-position progress (key = `close:<ASSET>`)
//   • Manual Order    → manual fill progress    (key = `manual:<orderId>`)
//   • Live Status tab → autopilot fill progress (key = `autopilot:<orderId>`)
//
// Centralised so the polling loop and terminal-state detection are not
// copy-pasted between callers.

import { apiClient } from './api-client.js';
import type { ExchangeCredentials } from './exchange-mode.js';

export type ProgressPhase =
  | 'submitting' | 'pending'  | 'partial' | 'filled'
  | 'canceled'   | 'rejected' | 'timeout' | 'error';

export type ProgressSource = 'close' | 'manual' | 'autopilot';

export interface OrderProgress {
  key:        string;
  source:     ProgressSource;
  exchange:   string;
  symbol:     string;
  side:       'buy' | 'sell';
  phase:      ProgressPhase;
  orderId?:   string;
  quantity:   number;
  filledQty:  number;
  avgPrice:   number;
  message?:   string;
  label?:     string;
  startedAt:  number;
  updatedAt:  number;
}

export const TERMINAL_PHASES: ReadonlySet<ProgressPhase> = new Set<ProgressPhase>([
  'filled', 'canceled', 'rejected', 'timeout', 'error',
]);

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS  = 60_000;

type Listener = (state: Record<string, OrderProgress>) => void;

class OrderProgressStore {
  private state: Record<string, OrderProgress> = {};
  private listeners = new Set<Listener>();
  private pollers   = new Map<string, ReturnType<typeof setTimeout>>();

  all(): Record<string, OrderProgress> { return this.state; }
  get(key: string): OrderProgress | undefined { return this.state[key]; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    const snap = { ...this.state };
    for (const l of this.listeners) {
      try { l(snap); } catch { /* ignore listener errors */ }
    }
  }

  // Begin tracking a new order (or restart tracking on the same key — useful
  // when the user re-clicks "Close Position" on the same asset).
  start(opts: {
    key:      string;
    source:   ProgressSource;
    exchange: string;
    symbol:   string;
    side:     'buy' | 'sell';
    label?:   string;
  }): void {
    this.cancelPoller(opts.key);
    const now = Date.now();
    this.state = {
      ...this.state,
      [opts.key]: {
        key:       opts.key,
        source:    opts.source,
        exchange:  opts.exchange,
        symbol:    opts.symbol,
        side:      opts.side,
        label:     opts.label,
        phase:     'submitting',
        quantity:  0,
        filledQty: 0,
        avgPrice:  0,
        startedAt: now,
        updatedAt: now,
      },
    };
    this.emit();
  }

  update(key: string, patch: Partial<Omit<OrderProgress, 'key'>>): void {
    const prev = this.state[key];
    if (!prev) return;
    this.state = { ...this.state, [key]: { ...prev, ...patch, updatedAt: Date.now() } };
    this.emit();
  }

  // Begin polling getOrderStatus until terminal or POLL_TIMEOUT_MS elapsed.
  // Safe to re-call on the same key — any existing poller is cancelled first.
  poll(opts: {
    key:        string;
    orderId:    string;
    exchange:   string;
    symbol:     string;
    creds:      ExchangeCredentials;
    onTerminal?: (final: OrderProgress) => void;
  }): void {
    this.cancelPoller(opts.key);
    const startedAt = this.state[opts.key]?.startedAt ?? Date.now();

    const tick = async () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > POLL_TIMEOUT_MS) {
        const cur = this.state[opts.key];
        if (cur && !TERMINAL_PHASES.has(cur.phase)) {
          this.update(opts.key, {
            phase:   'timeout',
            message: 'Stopped polling after 60s — check the order history for the final status.',
          });
          opts.onTerminal?.(this.state[opts.key]!);
        }
        this.pollers.delete(opts.key);
        return;
      }
      try {
        const r = await apiClient.getOrderStatus(opts.exchange, opts.creds, opts.orderId, opts.symbol);
        if (r.ok && r.data.order) {
          const o = r.data.order;
          const filled = Number(o.filledQty) || 0;
          const qty    = Number(o.quantity)  || 0;
          const avg    = Number(o.avgPrice)  || 0;
          const isPartial =
            o.status === 'partial' || (o.status === 'open' && filled > 0);
          const phase: ProgressPhase =
            o.status === 'filled'   ? 'filled'   :
            o.status === 'canceled' ? 'canceled' :
            o.status === 'rejected' ? 'rejected' :
            isPartial               ? 'partial'  : 'pending';
          this.update(opts.key, {
            orderId:   opts.orderId,
            phase,
            quantity:  qty,
            filledQty: filled,
            avgPrice:  avg,
          });
          if (TERMINAL_PHASES.has(phase)) {
            this.pollers.delete(opts.key);
            opts.onTerminal?.(this.state[opts.key]!);
            return;
          }
        }
      } catch { /* swallow — try again next tick */ }
      this.pollers.set(opts.key, setTimeout(tick, POLL_INTERVAL_MS));
    };

    this.pollers.set(opts.key, setTimeout(tick, POLL_INTERVAL_MS));
  }

  cancelPoller(key: string): void {
    const t = this.pollers.get(key);
    if (t) { clearTimeout(t); this.pollers.delete(key); }
  }

  dismiss(key: string): void {
    this.cancelPoller(key);
    if (!this.state[key]) return;
    const next = { ...this.state };
    delete next[key];
    this.state = next;
    this.emit();
  }

  // Convenience filters used by the Live Status tab to show recent
  // autopilot/manual fills without leaking close-position rows.
  bySource(source: ProgressSource): OrderProgress[] {
    return Object.values(this.state).filter(p => p.source === source);
  }
}

export const orderProgress = new OrderProgressStore();
