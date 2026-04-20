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
import { exchangeEvents } from './exchange-events.js';

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
  // True while a poller is actively working this key. Used by the UI to
  // show a "Resume polling" affordance only on rows that genuinely timed
  // out and aren't already being retried.
  resumable?: boolean;
  // Set while the poller is in an error-backoff cycle (consecutive transient
  // `getOrderStatus` failures). Cleared on the next successful response.
  // Lets the UI surface "Retrying in 6s — exchange unreachable" so users
  // know the app is still working rather than silently stuck on "Pending".
  retry?: { consecutiveErrors: number; nextDelayMs: number };
}

export const TERMINAL_PHASES: ReadonlySet<ProgressPhase> = new Set<ProgressPhase>([
  'filled', 'canceled', 'rejected', 'timeout', 'error',
]);

// Base interval between successful polls.
const POLL_INTERVAL_MS = 1500;

// Backoff schedule applied after consecutive transient `getOrderStatus`
// errors (network blip, exchange 5xx, rate-limit). Reset on the next
// successful response so a single hiccup doesn't permanently slow us down.
// Sequence: 1.5s → 3s → 6s, capped at 6s thereafter so we keep retrying
// without spamming the exchange.
const ERROR_BACKOFF_MS = [1500, 3000, 6000] as const;

// Per-source hard cap on how long the poller will keep asking before
// surfacing a "Resume polling" affordance. Limit orders that sit on the
// book legitimately take longer than market closes, so AutoPilot gets
// more headroom by default. Mutate via `setPollTimeout` if needed.
export const POLL_TIMEOUTS_MS: Record<ProgressSource, number> = {
  close:     60_000,
  manual:    60_000,
  autopilot: 120_000,
};

export function setPollTimeout(source: ProgressSource, ms: number): void {
  if (Number.isFinite(ms) && ms > 0) POLL_TIMEOUTS_MS[source] = ms;
}

// Cross-tab channel name. Bumping the suffix invalidates any in-flight
// messages in older tabs after a deploy that changes the wire format.
const CHANNEL_NAME = 'signalx-order-progress-v1';
// How long a remote leader's last heartbeat is considered fresh. After this
// window with no `poll-active` from the leader, another tab may take over.
const LEADER_STALE_MS = 5_000;

// localStorage key for persisting non-terminal progress rows so the panel
// survives a page refresh while an order is still working on the exchange.
// Only non-terminal rows (no filled/canceled/rejected/timeout/error) are
// stored — terminal/dismissed rows must NOT reappear after reload.
const STORAGE_KEY = 'sx_order_progress_v1';

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

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch { return null; }
}

function loadPersisted(): Record<string, OrderProgress> {
  const ls = safeLocalStorage();
  if (!ls) return {};
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, OrderProgress>;
    if (!parsed || typeof parsed !== 'object') return {};
    // Defensive filter: drop any terminal rows that may have leaked into
    // storage from an older build so they cannot reappear.
    const out: Record<string, OrderProgress> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !TERMINAL_PHASES.has(v.phase)) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

export class OrderProgressStore {
  private state: Record<string, OrderProgress> = loadPersisted();
  private listeners = new Set<Listener>();
  private pollers   = new Map<string, ReturnType<typeof setTimeout>>();
  // Remembers the last `poll()` opts per key so `resume()` can restart
  // tracking after a timeout without the UI having to plumb creds back in.
  private pollOpts  = new Map<string, PollOpts>();

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

  // Write the current non-terminal rows to localStorage. Terminal rows
  // are intentionally excluded so a refresh after a fill/cancel/reject
  // does not bring the closed panel back.
  private persist(): void {
    const ls = safeLocalStorage();
    if (!ls) return;
    const out: Record<string, OrderProgress> = {};
    for (const [k, v] of Object.entries(this.state)) {
      if (!TERMINAL_PHASES.has(v.phase)) out[k] = v;
    }
    try {
      if (Object.keys(out).length === 0) ls.removeItem(STORAGE_KEY);
      else ls.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch { /* storage full / denied */ }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    this.persist();
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

  // Re-attach pollers for non-terminal rows that were rehydrated from
  // localStorage on construction. Called once on page mount with a
  // credential lookup so the live status keeps advancing after a refresh.
  // Rows missing an orderId (still in `submitting`) or whose credentials
  // are no longer in the in-memory store are left as-is — they'll show
  // their last known phase but won't poll. Cross-tab leadership is honoured
  // via `poll()` so a tab that already polls a given key keeps doing so.
  resume(getCreds: (exchange: string) => ExchangeCredentials | null): void {
    for (const p of Object.values(this.state)) {
      if (TERMINAL_PHASES.has(p.phase)) continue;
      if (!p.orderId) continue;
      if (this.pollers.has(p.key)) continue;
      const creds = getCreds(p.exchange);
      if (!creds) continue;
      this.poll({
        key: p.key, orderId: p.orderId, exchange: p.exchange,
        symbol: p.symbol, creds,
      });
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
    this.pollOpts.delete(opts.key);
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
      resumable: false,
    }, true);
  }

  update(key: string, patch: Partial<Omit<OrderProgress, 'key'>>): void {
    const prev = this.state[key];
    if (!prev) return;
    this.applyMutation(key, { ...prev, ...patch, updatedAt: Date.now() }, true);
  }

  // Begin polling getOrderStatus until terminal or the per-source timeout
  // elapses. Safe to re-call on the same key — any existing poller is
  // cancelled first. Transient API errors apply an exponential backoff
  // (1.5s → 3s → 6s) instead of hammering the exchange every 1.5s.
  // If another tab is already polling this key (its leadership heartbeat is
  // still fresh), this tab defers — it will receive state updates over the
  // BroadcastChannel without issuing duplicate `getOrderStatus` requests.
  poll(opts: PollOpts): void {
    this.localPollOpts.set(opts.key, opts);
    this.pollOpts.set(opts.key, opts);
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
    // Anchor the timeout budget to "now" so a resume() after a timeout
    // gets a fresh window rather than inheriting the original startedAt.
    const pollStartedAt = Date.now();
    const cur = this.state[opts.key];
    const source: ProgressSource = cur?.source ?? 'manual';
    const timeoutMs = POLL_TIMEOUTS_MS[source];
    let consecutiveErrors = 0;
    let lastLoggedDelay = 0;

    if (cur?.resumable) this.update(opts.key, { resumable: false });

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

      const elapsed = Date.now() - pollStartedAt;
      if (elapsed > timeoutMs) {
        const c = this.state[opts.key];
        if (c && !TERMINAL_PHASES.has(c.phase)) {
          const secs = Math.round(timeoutMs / 1000);
          this.update(opts.key, {
            phase:     'timeout',
            message:   `Stopped polling after ${secs}s — the order may still be live. Click Resume to keep checking, or open the order history.`,
            resumable: true,
          });
        }
        this.stopHeartbeat(opts.key);
        this.pollers.delete(opts.key);
        this.send({ type: 'poll-release', from: this.tabId, key: opts.key });
        return;
      }
      let nextDelay = POLL_INTERVAL_MS;
      let errorReason: string | undefined;
      try {
        const r = await apiClient.getOrderStatus(opts.exchange, opts.creds, opts.orderId, opts.symbol);
        if (r.ok && r.data.order) {
          if (consecutiveErrors > 0) {
            exchangeEvents.log('fetch-balance', opts.exchange,
              `Order poll recovered for ${opts.symbol} after ${consecutiveErrors} retry attempt(s)`,
              { data: { key: opts.key, orderId: opts.orderId } });
          }
          consecutiveErrors = 0;
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
            retry:     undefined,
          });
          if (TERMINAL_PHASES.has(phase)) {
            this.stopHeartbeat(opts.key);
            this.pollers.delete(opts.key);
            // Drop saved poll opts: filled / canceled / rejected rows are
            // genuinely terminal and shouldn't be resumable. Only timeout
            // (handled above) keeps its opts so resume() can re-poll.
            this.pollOpts.delete(opts.key);
            this.send({ type: 'poll-release', from: this.tabId, key: opts.key });
            return;
          }
        } else {
          // API responded but not OK — treat as transient.
          consecutiveErrors += 1;
          nextDelay = ERROR_BACKOFF_MS[
            Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)
          ];
          errorReason = !r.ok ? (r.error ?? 'exchange error') : 'no order returned';
        }
      } catch (e) {
        consecutiveErrors += 1;
        nextDelay = ERROR_BACKOFF_MS[
          Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)
        ];
        errorReason = e instanceof Error ? e.message : 'network error';
      }
      if (consecutiveErrors > 0) {
        // Surface the backoff cycle to the UI so users see "Retrying in Ns"
        // instead of a stale "Pending". Also emit a diagnostics entry on
        // every escalation so recurring exchange issues are debuggable.
        const cur2 = this.state[opts.key];
        if (cur2 && !TERMINAL_PHASES.has(cur2.phase)) {
          this.update(opts.key, {
            retry: { consecutiveErrors, nextDelayMs: nextDelay },
          });
        }
        // Log only on backoff escalations (delay just increased) to keep
        // the diagnostics tab readable when the exchange is flapping.
        if (nextDelay !== lastLoggedDelay) {
          exchangeEvents.log('fetch-balance', opts.exchange,
            `Order poll error #${consecutiveErrors} for ${opts.symbol} — retrying in ${Math.round(nextDelay / 1000)}s`,
            {
              level: consecutiveErrors >= ERROR_BACKOFF_MS.length ? 'error' : 'warn',
              data: { key: opts.key, orderId: opts.orderId, nextDelayMs: nextDelay, reason: errorReason },
            });
          lastLoggedDelay = nextDelay;
        }
      }
      this.pollers.set(opts.key, setTimeout(tick, nextDelay));
    };

    this.pollers.set(opts.key, setTimeout(tick, POLL_INTERVAL_MS));
  }

  // Restart polling for a row that previously timed out, using the same
  // opts as the original poll() call. Returns true if a poll was resumed.
  // Guarded to only act on timed-out + resumable rows so callers can't
  // accidentally restart a poller on top of a row that's already filled
  // / canceled / rejected (and therefore had its pollOpts intentionally
  // discarded by the lifecycle).
  resume(key: string): boolean {
    const opts = this.pollOpts.get(key);
    if (!opts) return false;
    const cur = this.state[key];
    if (!cur) return false;
    if (cur.phase !== 'timeout' || !cur.resumable) return false;
    // Flip phase back to pending so the panel stops looking terminal.
    this.update(key, { phase: 'pending', message: undefined, resumable: false, retry: undefined });
    this.poll(opts);
    return true;
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
    this.pollOpts.delete(key);
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
          this.pollOpts.delete(msg.key);
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
