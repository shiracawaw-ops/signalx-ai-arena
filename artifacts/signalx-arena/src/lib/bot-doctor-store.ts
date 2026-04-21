// ─── Bot Doctor Store ─────────────────────────────────────────────────────────
// Source of truth for the Doctor's operating mode and the per-bot bench list
// (auto-quarantine for misbehaving bots in real mode).
//
// Modes:
//   OFF         — doctor inactive; bench list ignored.
//   MONITOR     — observe + classify only; never modify execution.
//   AUTO_FIX    — bench bots for safe, well-defined causes (high reject rate,
//                 cooldown spam, dust). Restores automatically after expiry.
//   FULL_ACTIVE — AUTO_FIX + benches under-performing bots (negative net real
//                 PnL after enough trades) and inactive-eligible standby bots
//                 that consume a slot without producing volume.
//
// The bench list is an in-memory + localStorage map of botId → { reason,
// expiresAt, code }. bot-fleet reads it to exclude benched bots from the
// real-eligible set; execution-engine writes to it via observe() on real
// rejects. Listeners get notified on every change so the Doctor UI stays
// in sync without any prop drilling.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'sx_bot_doctor_v1';

export type DoctorMode = 'OFF' | 'MONITOR' | 'AUTO_FIX' | 'FULL_ACTIVE';

export type BenchCode =
  | 'high_reject_rate'
  | 'cooldown_spam'
  | 'dust_unsellable'
  | 'adapter_not_ready'
  | 'underperforming_real'
  | 'inactive_eligible'
  | 'manual';

export interface BenchEntry {
  botId:     string;
  code:      BenchCode;
  reason:    string;        // human-readable explanation
  benchedAt: number;
  expiresAt: number;        // 0 = permanent (manual)
}

export interface DustMark {
  exchange:  string;
  baseAsset: string;
  reason:    string;
  markedAt:  number;
}

export interface DoctorDecision {
  ts:     number;
  type:   'bench' | 'unbench' | 'dust' | 'mode_change';
  botId?: string;
  detail: string;
}

export interface DoctorState {
  mode:      DoctorMode;
  bench:     Record<string, BenchEntry>;
  dust:      Record<string, DustMark>;     // key = `exchange:baseAsset`
  decisions: DoctorDecision[];             // last 50, most-recent-first
  lastUpdated: number;
}

const DEFAULT_BENCH_MS    = 30 * 60 * 1000;   // 30 min
const HIGH_REJECT_BENCH_MS = 15 * 60 * 1000;  // shorter — give it another chance
const MAX_DECISIONS        = 50;

function emptyState(): DoctorState {
  return {
    mode: 'MONITOR',
    bench: {},
    dust: {},
    decisions: [],
    lastUpdated: 0,
  };
}

function dustKey(exchange: string, baseAsset: string): string {
  return `${exchange}:${baseAsset.toUpperCase()}`;
}

class BotDoctorStore {
  private state: DoctorState = emptyState();
  private listeners = new Set<(s: DoctorState) => void>();

  constructor() { this.load(); }

  private load() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<DoctorState>;
        this.state = { ...emptyState(), ...parsed };
        if (!this.state.bench || typeof this.state.bench !== 'object') this.state.bench = {};
        if (!this.state.dust  || typeof this.state.dust  !== 'object') this.state.dust  = {};
        if (!Array.isArray(this.state.decisions)) this.state.decisions = [];
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

  private logDecision(d: Omit<DoctorDecision, 'ts'>) {
    this.state.decisions = [{ ts: Date.now(), ...d }, ...this.state.decisions].slice(0, MAX_DECISIONS);
  }

  snapshot(): DoctorState {
    // Deep-clone so subscribers can never mutate live state.
    return JSON.parse(JSON.stringify(this.state)) as DoctorState;
  }

  subscribe(fn: (s: DoctorState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Mode ────────────────────────────────────────────────────────────────────
  getMode(): DoctorMode { return this.state.mode; }

  setMode(mode: DoctorMode): void {
    if (mode === this.state.mode) return;
    this.state.mode = mode;
    this.logDecision({ type: 'mode_change', detail: `Doctor mode → ${mode}` });
    this.state.lastUpdated = Date.now();
    this.save(); this.notify();
  }

  /** Doctor is allowed to take active corrective actions. */
  canAutoAct(): boolean {
    return this.state.mode === 'AUTO_FIX' || this.state.mode === 'FULL_ACTIVE';
  }

  /** Doctor is allowed to bench under-performing or inactive bots. */
  canDeepAct(): boolean {
    return this.state.mode === 'FULL_ACTIVE';
  }

  // ── Bench list ──────────────────────────────────────────────────────────────

  /** Removes expired bench entries (called lazily on every read). */
  private pruneExpired(): boolean {
    const now = Date.now();
    let changed = false;
    for (const [id, e] of Object.entries(this.state.bench)) {
      if (e.expiresAt > 0 && e.expiresAt <= now) {
        delete this.state.bench[id];
        this.logDecision({ type: 'unbench', botId: id, detail: `Auto-restore: bench expired (was ${e.code})` });
        changed = true;
      }
    }
    return changed;
  }

  isBenched(botId: string): boolean {
    if (this.pruneExpired()) { this.save(); this.notify(); }
    return !!this.state.bench[botId];
  }

  benchEntry(botId: string): BenchEntry | undefined {
    if (this.pruneExpired()) { this.save(); this.notify(); }
    return this.state.bench[botId];
  }

  bench(botId: string, code: BenchCode, reason: string, durationMs?: number): void {
    const dur = durationMs ?? (code === 'high_reject_rate' ? HIGH_REJECT_BENCH_MS : DEFAULT_BENCH_MS);
    const expiresAt = code === 'manual' ? 0 : Date.now() + dur;
    this.state.bench[botId] = { botId, code, reason, benchedAt: Date.now(), expiresAt };
    this.logDecision({ type: 'bench', botId, detail: `${code}: ${reason}` });
    this.state.lastUpdated = Date.now();
    this.save(); this.notify();
  }

  unbench(botId: string): void {
    if (!this.state.bench[botId]) return;
    const e = this.state.bench[botId];
    delete this.state.bench[botId];
    this.logDecision({ type: 'unbench', botId, detail: `Manual restore (was ${e.code})` });
    this.state.lastUpdated = Date.now();
    this.save(); this.notify();
  }

  benchList(): BenchEntry[] {
    if (this.pruneExpired()) { this.save(); this.notify(); }
    return Object.values(this.state.bench).sort((a, b) => b.benchedAt - a.benchedAt);
  }

  // ── Dust map (positions too small to sell) ──────────────────────────────────

  markDust(exchange: string, baseAsset: string, reason: string): void {
    const key = dustKey(exchange, baseAsset);
    if (this.state.dust[key]) return; // already marked
    this.state.dust[key] = { exchange, baseAsset: baseAsset.toUpperCase(), reason, markedAt: Date.now() };
    this.logDecision({ type: 'dust', detail: `${exchange}:${baseAsset} marked dust — ${reason}` });
    this.state.lastUpdated = Date.now();
    this.save(); this.notify();
  }

  isDust(exchange: string, baseAsset: string): boolean {
    return !!this.state.dust[dustKey(exchange, baseAsset)];
  }

  clearDust(exchange: string, baseAsset: string): void {
    const key = dustKey(exchange, baseAsset);
    if (!this.state.dust[key]) return;
    delete this.state.dust[key];
    this.state.lastUpdated = Date.now();
    this.save(); this.notify();
  }

  dustList(): DustMark[] {
    return Object.values(this.state.dust).sort((a, b) => b.markedAt - a.markedAt);
  }

  // ── Observe — called from execution-engine on every real reject ────────────

  /**
   * Classifies a real-mode reject reason and, when the mode permits, takes
   * an auto-bench action. Returns the bench code applied (if any) so the
   * caller can record it in the activity log.
   */
  observe(input: {
    botId?:        string;
    rejectReason?: string;
    rejectDetail?: string;
    rejectionRate: number;   // current rolling reject rate for this bot (0..1)
    submittedRecent: number; // recent attempt count (gate threshold)
    exchange?:     string;
    baseAsset?:    string;
  }): BenchCode | null {
    if (this.state.mode === 'OFF' || this.state.mode === 'MONITOR') return null;
    if (!this.canAutoAct()) return null;
    const { botId, rejectReason, rejectDetail, rejectionRate, submittedRecent } = input;

    // Dust: persistent under-min-notional or unsellable size. Mark immediately
    // so subsequent attempts skip the symbol — does not require a botId.
    if (rejectReason && /min_notional|owned_qty_below|insufficient_qty|filter_min/i.test(rejectReason)) {
      if (input.exchange && input.baseAsset) {
        this.markDust(input.exchange, input.baseAsset, rejectDetail || rejectReason);
      }
      if (botId) {
        this.bench(botId, 'dust_unsellable',
          `${input.exchange ?? 'exchange'}:${input.baseAsset ?? 'asset'} below minimum order size`);
        return 'dust_unsellable';
      }
      return null;
    }

    if (!botId) return null;

    // Adapter not ready repeatedly — bench briefly so the user sees clear
    // signal, and so we stop hammering the same bot until the adapter heals.
    if (rejectReason && /adapter_not_ready/i.test(rejectReason)) {
      if (submittedRecent >= 3) {
        this.bench(botId, 'adapter_not_ready', 'Adapter unavailable — bot paused while it heals');
        return 'adapter_not_ready';
      }
      return null;
    }

    // Cooldown spam — too many attempts hitting the cooldown shield.
    if (rejectReason && /cooldown|stale_price|duplicate_signal/i.test(rejectReason)) {
      if (submittedRecent >= 5 && rejectionRate >= 0.6) {
        this.bench(botId, 'cooldown_spam', 'Repeated cooldown / duplicate / stale signals');
        return 'cooldown_spam';
      }
      return null;
    }

    // Generic high reject rate (any cause) — only after a meaningful sample.
    if (submittedRecent >= 8 && rejectionRate >= 0.7) {
      this.bench(botId, 'high_reject_rate',
        `${Math.round(rejectionRate * 100)}% of recent attempts rejected`);
      return 'high_reject_rate';
    }
    return null;
  }

  reset(): void {
    this.state = emptyState();
    this.save(); this.notify();
  }
}

export const botDoctorStore = new BotDoctorStore();

export function useBotDoctor(): DoctorState {
  const [s, setS] = useState<DoctorState>(() => botDoctorStore.snapshot());
  useEffect(() => botDoctorStore.subscribe(setS), []);
  return s;
}

export const DOCTOR_MODE_LABELS: Record<DoctorMode, string> = {
  OFF:         'Off',
  MONITOR:     'Monitor only',
  AUTO_FIX:    'Auto-fix safe issues',
  FULL_ACTIVE: 'Full active monitoring',
};

export const DOCTOR_MODE_DESCRIPTIONS: Record<DoctorMode, string> = {
  OFF:         'Doctor inactive. No diagnostics, no actions.',
  MONITOR:     'Doctor observes and classifies issues only — does not change execution.',
  AUTO_FIX:    'Doctor benches bots for clear safety issues (high rejects, dust, cooldown spam).',
  FULL_ACTIVE: 'Doctor also benches under-performing or inactive eligible bots automatically.',
};
