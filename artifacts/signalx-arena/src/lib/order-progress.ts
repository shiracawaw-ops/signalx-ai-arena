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
//
// ─── Cross-tab sync ──────────────────────────────────────────────────────────
// All mutations (start / update / dismiss) and polling leadership are mirrored
// across browser tabs via a BroadcastChannel so:
//   • Only one tab actively polls a given orderId at a time (leader election).
//   • Phase changes appear in every open tab immediately.
//   • Dismissing in one tab clears the row in every other tab.
// The channel is optional — if BroadcastChannel is unavailable (SSR, old
// browsers, some test environments) the store degrades to per-tab behaviour.

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

// Cross-tab channel name. Bumping the suffix invalidates any in-flight
// messages in older tabs after a deploy that changes the wire format.
const CHANNEL_NAME = 'signalx-order-progress-v1';
// How long a remote leader's last heartbeat is considered fresh. After this
// window with no `poll-active` from the leader, another tab may take over.
const LEADER_STALE_MS = 5_000;

type PollOpts = {
  key:         string;
  orderId:     string;
  exchange:    string;
  symbol:      string;
  creds:       ExchangeCredentials;
  onTerminal?: (final: OrderProgress) => void;
};

type Listener = (state: Record<string, OrderProgress>) => void;

// Wire format for cross-tab messages. `from` is the originating tab's id so
// each tab can ignore its own echoes.
type Msg =
  | { type: 'mutate';           from: string; key: string; value: OrderProgress | null }
  | { type: 'snapshot-request'; from: string }
  | { type: 'snapshot';         from: string; state: Record<string, OrderProgress> }
  | { type: 'poll-claim';       from: string; key: string }
  | { type: 'poll-active';      from: string; key: string }
  | { type: 'poll-release';     from: string; key: string };

class OrderProgressStore {
  private state: Record<string, OrderProgress> = {};
  private listeners = new Set<Listener>();
  private pollers   = new Map<string, ReturnType<typeof setTimeout>>();

  // Stable per-tab id used both to ignore our own broadcasts and as the
  // tiebreaker when two tabs race to claim leadership for the same key.
  private tabId =
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // Optional cross-tab channel — null in non-browser environments.
  private channel: BroadcastChannel | null = null;
  // Known leader (per orderId key) responsible for polling `getOrderStatus`.
  // `tabId === this.tabId` means we are the leader.
  private leaders = new Map<string, { tabId: string; lastSeen: number }>();
  // Poll opts the local tab has issued. Kept so we can fire `onTerminal`
  // toasts in the originating tab when a *remote* leader observes the
  // terminal phase, and so we can resume polling if the leader yields.
  private localPollOpts = new Map<string, PollOpts>();
  // Heartbeat interval ids per key — leaders broadcast `poll-active` every
  // poll tick so newly-opened tabs can detect that polling is already in
  // progress and avoid duplicate `getOrderStatus` requests.
  private heartbeats = new Map<string, ReturnType<typeof setInterval>>();

  constructor() {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = e => this.onMessage(e.data as Msg);
      // Ask any existing tabs for their current state so a freshly-opened
      // tab immediately reflects in-flight orders started elsewhere.
      this.send({ type: 'snapshot-request', from: this.tabId });
      // Best-effort cleanup so other tabs can take over polling and so
      // stale leadership records don't survive a tab close.
      window.addEventListener('beforeunload', () => {
        for (const [key, leader] of this.leaders) {
          if (leader.tabId === this.tabId) {
            this.send({ type: 'poll-release', from: this.tabId, key });
          }
        }
      });
    } catch { /* BroadcastChannel construction failed — degrade silently */ }
  }

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

  private send(msg: Msg): void {
    if (!this.channel) return;
    try { this.channel.postMessage(msg); } catch { /* channel closed */ }
  }

  // Apply a per-key state change locally and (optionally) broadcast it so
  // other tabs converge on the same state. `value === null` deletes the key.
  private applyMutation(key: string, value: OrderProgress | null, broadcast: boolean): void {
    const prev = this.state[key];
    if (value === null) {
      if (!prev) return;
      const next = { ...this.state };
      delete next[key];
      this.state = next;
    } else {
      this.state = { ...this.state, [key]: value };
    }
    this.emit();
    if (broadcast) this.send({ type: 'mutate', from: this.tabId, key, value });

    // Fire onTerminal in the originating tab when the order reaches a
    // terminal phase — even if the remote leader was the one that observed
    // it. Each opts entry is consumed exactly once.
    if (value && TERMINAL_PHASES.has(value.phase)) {
      const opts = this.localPollOpts.get(key);
      if (opts) {
        this.localPollOpts.delete(key);
        try { opts.onTerminal?.(value); } catch { /* ignore */ }
      }
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
    this.applyMutation(opts.key, {
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
    }, true);
  }

  update(key: string, patch: Partial<Omit<OrderProgress, 'key'>>): void {
    const prev = this.state[key];
    if (!prev) return;
    this.applyMutation(key, { ...prev, ...patch, updatedAt: Date.now() }, true);
  }

  // Begin polling getOrderStatus until terminal or POLL_TIMEOUT_MS elapsed.
  // Safe to re-call on the same key — any existing poller is cancelled first.
  // If another tab is already polling this key (its leadership heartbeat is
  // still fresh), this tab defers — it will receive state updates over the
  // BroadcastChannel without issuing duplicate `getOrderStatus` requests.
  poll(opts: PollOpts): void {
    this.localPollOpts.set(opts.key, opts);
    this.cancelPoller(opts.key);

    const remote = this.leaders.get(opts.key);
    if (remote && remote.tabId !== this.tabId &&
        Date.now() - remote.lastSeen < LEADER_STALE_MS) {
      // Another tab is the active leader — let it do the polling. We'll
      // converge on the result via `mutate` broadcasts.
      return;
    }

    // Claim leadership. If a peer races us we'll resolve via the tiebreak
    // in `onMessage` below (lower tabId wins; the loser cancels its poller).
    this.leaders.set(opts.key, { tabId: this.tabId, lastSeen: Date.now() });
    this.send({ type: 'poll-claim', from: this.tabId, key: opts.key });
    this.startPolling(opts);
  }

  // Internal polling loop. Only invoked when this tab is the leader for
  // `opts.key`. Heartbeats every tick so other tabs can detect active
  // polling and skip duplicating it.
  private startPolling(opts: PollOpts): void {
    const startedAt = this.state[opts.key]?.startedAt ?? Date.now();

    // Heartbeat — broadcast that we're actively polling so any tab opened
    // mid-flight knows to defer instead of starting its own poller.
    const beat = () => this.send({ type: 'poll-active', from: this.tabId, key: opts.key });
    const beatTimer = setInterval(beat, POLL_INTERVAL_MS);
    this.heartbeats.set(opts.key, beatTimer);

    const tick = async () => {
      // Bail out if leadership changed under us (another tab took over).
      const lead = this.leaders.get(opts.key);
      if (!lead || lead.tabId !== this.tabId) {
        this.stopHeartbeat(opts.key);
        this.pollers.delete(opts.key);
        return;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed > POLL_TIMEOUT_MS) {
        const cur = this.state[opts.key];
        if (cur && !TERMINAL_PHASES.has(cur.phase)) {
          this.update(opts.key, {
            phase:   'timeout',
            message: 'Stopped polling after 60s — check the order history for the final status.',
          });
        }
        this.stopHeartbeat(opts.key);
        this.pollers.delete(opts.key);
        this.send({ type: 'poll-release', from: this.tabId, key: opts.key });
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
            this.stopHeartbeat(opts.key);
            this.pollers.delete(opts.key);
            this.send({ type: 'poll-release', from: this.tabId, key: opts.key });
            return;
          }
        }
      } catch { /* swallow — try again next tick */ }
      this.pollers.set(opts.key, setTimeout(tick, POLL_INTERVAL_MS));
    };

    this.pollers.set(opts.key, setTimeout(tick, POLL_INTERVAL_MS));
  }

  private stopHeartbeat(key: string): void {
    const t = this.heartbeats.get(key);
    if (t) { clearInterval(t); this.heartbeats.delete(key); }
  }

  cancelPoller(key: string): void {
    const t = this.pollers.get(key);
    if (t) { clearTimeout(t); this.pollers.delete(key); }
    this.stopHeartbeat(key);
  }

  dismiss(key: string): void {
    this.cancelPoller(key);
    this.localPollOpts.delete(key);
    const wasLeader = this.leaders.get(key)?.tabId === this.tabId;
    this.leaders.delete(key);
    if (!this.state[key]) {
      // Even if we never had local state (e.g. another tab created the row
      // and we received it via snapshot but already dismissed), still notify
      // peers so leadership/state stays in sync.
      this.send({ type: 'mutate', from: this.tabId, key, value: null });
      if (wasLeader) this.send({ type: 'poll-release', from: this.tabId, key });
      return;
    }
    this.applyMutation(key, null, true);
    if (wasLeader) this.send({ type: 'poll-release', from: this.tabId, key });
  }

  // ── Cross-tab message handler ──────────────────────────────────────────
  // Applies remote mutations to our local state and resolves polling
  // leadership. All branches ignore messages we sent ourselves — the
  // BroadcastChannel API does not echo to the originating tab in modern
  // browsers, but we guard explicitly so tests/polyfills behave the same.
  private onMessage(msg: Msg): void {
    if (!msg || msg.from === this.tabId) return;

    switch (msg.type) {
      case 'mutate': {
        // Apply without re-broadcasting to avoid an echo storm.
        this.applyMutation(msg.key, msg.value, false);
        // If a peer dismissed the row, clear any local poller / opts.
        if (msg.value === null) {
          this.cancelPoller(msg.key);
          this.localPollOpts.delete(msg.key);
          this.leaders.delete(msg.key);
        }
        break;
      }

      case 'snapshot-request': {
        // Reply only with non-empty state so we don't spam the channel
        // when the tab opens before any orders are tracked.
        if (Object.keys(this.state).length === 0) break;
        this.send({ type: 'snapshot', from: this.tabId, state: this.state });
        break;
      }

      case 'snapshot': {
        // Merge missing keys from the peer's view of the world. We never
        // overwrite local state — if both tabs have a view of the same
        // key, the most recent `mutate` broadcast wins (and they should
        // already agree).
        let changed = false;
        for (const [k, v] of Object.entries(msg.state)) {
          if (!this.state[k]) {
            this.state = { ...this.state, [k]: v };
            changed = true;
          }
        }
        if (changed) this.emit();
        break;
      }

      case 'poll-claim': {
        const cur = this.leaders.get(msg.key);
        if (cur?.tabId === this.tabId) {
          // We're already polling. Tiebreak: lexicographically smaller
          // tabId wins. If the peer wins, yield; otherwise re-assert.
          if (msg.from < this.tabId) {
            this.cancelPoller(msg.key);
            this.leaders.set(msg.key, { tabId: msg.from, lastSeen: Date.now() });
          } else {
            this.send({ type: 'poll-active', from: this.tabId, key: msg.key });
          }
        } else {
          this.leaders.set(msg.key, { tabId: msg.from, lastSeen: Date.now() });
          // If we had been about to start polling, we're already deferred
          // because `cancelPoller` was called in `poll()` before claiming.
        }
        break;
      }

      case 'poll-active': {
        const cur = this.leaders.get(msg.key);
        if (cur?.tabId === this.tabId && msg.from < this.tabId) {
          // Peer outranks us — yield leadership.
          this.cancelPoller(msg.key);
        }
        this.leaders.set(msg.key, { tabId: msg.from, lastSeen: Date.now() });
        break;
      }

      case 'poll-release': {
        const cur = this.leaders.get(msg.key);
        if (cur?.tabId === msg.from) this.leaders.delete(msg.key);
        // If we have local opts and the order is still in-flight, take
        // over polling so a closing tab doesn't strand the order.
        const opts = this.localPollOpts.get(msg.key);
        const st   = this.state[msg.key];
        if (opts && st && !TERMINAL_PHASES.has(st.phase)) {
          this.poll(opts);
        }
        break;
      }
    }
  }

  // Convenience filters used by the Live Status tab to show recent
  // autopilot/manual fills without leaking close-position rows.
  bySource(source: ProgressSource): OrderProgress[] {
    return Object.values(this.state).filter(p => p.source === source);
  }
}

export const orderProgress = new OrderProgressStore();
