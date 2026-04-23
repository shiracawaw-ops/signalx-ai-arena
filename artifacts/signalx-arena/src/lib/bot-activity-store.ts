// ─── Bot Activity Store ───────────────────────────────────────────────────────
// Tracks per-bot real-trading activity for the transparency panel:
//   - eligibility (in fleet allow-list this round)
//   - actively executed today
//   - currently in standby and why
//   - currently blocked and why (last reject code + detail)
//   - per-bot realized PnL (mirrored from real-profit-store via syncFromProfit)
//   - per-bot rejection rate (recent window)
//
// State is purely in-memory + localStorage so it survives reload but not
// session reset. Updated by the execution-engine on every attempt.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'sx_bot_activity_v1';
const WINDOW_MS    = 24 * 60 * 60 * 1000; // 24h rolling window for "today"

export type ActivityKind = 'attempt' | 'success' | 'reject' | 'skip';

export type RealEligibilityState =
  | 'real_eligible'
  | 'real_ineligible'
  | 'standby'
  | 'paper_only'
  | 'benched'
  | 'degraded'
  | 'blocked';

export type RealGateReason =
  | 'rejected_low_profit_after_fees'
  | 'rejected_unhealthy_bot'
  | 'rejected_lower_rank_than_active_bots'
  | 'rejected_high_reject_rate'
  | 'rejected_poor_recent_performance'
  | 'rejected_market_regime_mismatch'
  | 'approved_for_real_trade';

export interface AttemptRecord {
  ts:       number;
  kind:     ActivityKind;
  symbol?:  string;
  reason?:  string;   // reject code / skip reason
  detail?:  string;   // human-readable explanation
}

export interface BotActivity {
  botId:           string;
  name?:           string;
  eligibleNow:     boolean;
  realState?:      RealEligibilityState;
  realGateReason?: RealGateReason;
  executionQualityScore?: number; // 0..100 higher is cleaner fills
  invalidAttemptRate?:    number; // 0..1
  doctorHealthStatus?:    'healthy' | 'watch' | 'critical' | 'benched';
  lastAttemptTs:   number;
  lastSuccessTs:   number;
  lastRejectTs:    number;
  lastRejectCode?: string;
  lastRejectDetail?: string;
  recent:          AttemptRecord[];   // capped at 30 most recent
}

export interface BotActivityState {
  bots: Record<string, BotActivity>;
  // Roll-up counters for the summary panel.
  totals: {
    totalBots:           number;
    eligibleForReal:     number;
    activeNow:           number;          // bot had a successful trade in last 5 min
    executedRealToday:   number;          // bot had at least one success in the 24h window
    standby:             number;          // eligible but no recent attempt
    blocked:             number;          // last attempt was a reject
  };
  lastUpdated: number;
}

function emptyState(): BotActivityState {
  return {
    bots: {},
    totals: { totalBots: 0, eligibleForReal: 0, activeNow: 0, executedRealToday: 0, standby: 0, blocked: 0 },
    lastUpdated: 0,
  };
}

class BotActivityStore {
  private state: BotActivityState = emptyState();
  private listeners = new Set<(s: BotActivityState) => void>();

  constructor() { this.load(); }

  private load() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<BotActivityState>;
        this.state = { ...emptyState(), ...parsed };
        if (!this.state.bots || typeof this.state.bots !== 'object') this.state.bots = {};
        if (!this.state.totals) this.state.totals = emptyState().totals;
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

  snapshot(): BotActivityState {
    return JSON.parse(JSON.stringify(this.state)) as BotActivityState;
  }

  subscribe(fn: (s: BotActivityState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called by the bot-fleet sync to update the eligible set. */
  setFleet(input: { totalBots: number; eligibleBotIds: string[]; allBotsHint?: { id: string; name?: string }[] }): void {
    const elig = new Set(input.eligibleBotIds);
    // Ensure every known bot has a record so the panel can list standby ones.
    if (input.allBotsHint) {
      for (const b of input.allBotsHint) {
        if (!this.state.bots[b.id]) {
          this.state.bots[b.id] = {
            botId: b.id, name: b.name, eligibleNow: elig.has(b.id),
            lastAttemptTs: 0, lastSuccessTs: 0, lastRejectTs: 0, recent: [],
            realState: elig.has(b.id) ? 'real_eligible' : 'standby',
            realGateReason: elig.has(b.id) ? 'approved_for_real_trade' : 'rejected_lower_rank_than_active_bots',
            executionQualityScore: 100,
            invalidAttemptRate: 0,
            doctorHealthStatus: 'healthy',
          };
        } else {
          this.state.bots[b.id].name        = b.name ?? this.state.bots[b.id].name;
          this.state.bots[b.id].eligibleNow = elig.has(b.id);
          // Keep fleet eligibility synchronized with explicit real-state if
          // no stricter gate has set it yet.
          if (!this.state.bots[b.id].realState || this.state.bots[b.id].realState === 'standby') {
            this.state.bots[b.id].realState = elig.has(b.id) ? 'real_eligible' : 'standby';
            this.state.bots[b.id].realGateReason = elig.has(b.id)
              ? 'approved_for_real_trade'
              : 'rejected_lower_rank_than_active_bots';
          }
        }
      }
    } else {
      for (const id of Object.keys(this.state.bots)) {
        this.state.bots[id].eligibleNow = elig.has(id);
      }
      for (const id of input.eligibleBotIds) {
        if (!this.state.bots[id]) {
          this.state.bots[id] = {
            botId: id, eligibleNow: true,
            lastAttemptTs: 0, lastSuccessTs: 0, lastRejectTs: 0, recent: [],
            realState: 'real_eligible',
            realGateReason: 'approved_for_real_trade',
            executionQualityScore: 100,
            invalidAttemptRate: 0,
            doctorHealthStatus: 'healthy',
          };
        }
      }
    }
    this.recomputeTotals(input.totalBots);
    this.save();
    this.notify();
  }

  /** Called by fleet gate logic to publish strict real-mode eligibility. */
  setRealEligibility(input: {
    byBot: Record<string, {
      state: RealEligibilityState;
      reason: RealGateReason;
      executionQualityScore?: number;
      invalidAttemptRate?: number;
      doctorHealthStatus?: 'healthy' | 'watch' | 'critical' | 'benched';
    }>;
  }): void {
    for (const [botId, gate] of Object.entries(input.byBot)) {
      const cur = this.state.bots[botId] ?? {
        botId, eligibleNow: false,
        lastAttemptTs: 0, lastSuccessTs: 0, lastRejectTs: 0, recent: [],
      } as BotActivity;
      cur.realState      = gate.state;
      cur.realGateReason = gate.reason;
      cur.eligibleNow    = gate.state === 'real_eligible';
      if (gate.executionQualityScore !== undefined) cur.executionQualityScore = gate.executionQualityScore;
      if (gate.invalidAttemptRate !== undefined)    cur.invalidAttemptRate    = gate.invalidAttemptRate;
      if (gate.doctorHealthStatus)                  cur.doctorHealthStatus    = gate.doctorHealthStatus;
      this.state.bots[botId] = cur;
    }
    this.recomputeTotals(this.state.totals.totalBots);
    this.save();
    this.notify();
  }

  /** Called from the execution-engine on every real-mode attempt. */
  recordAttempt(input: {
    botId: string; kind: ActivityKind; symbol?: string;
    reason?: string; detail?: string;
  }): void {
    const cur = this.state.bots[input.botId] ?? {
      botId: input.botId, eligibleNow: true,
      lastAttemptTs: 0, lastSuccessTs: 0, lastRejectTs: 0, recent: [],
    };
    const now = Date.now();
    // Suppress repeated identical reject spam (same reason+symbol in a short
    // burst) so diagnostics stay truthful and readable in bad conditions.
    const last = cur.recent[0];
    if (
      input.kind === 'reject' &&
      last &&
      last.kind === 'reject' &&
      last.reason === input.reason &&
      last.symbol === input.symbol &&
      now - last.ts < 15_000
    ) {
      cur.lastAttemptTs = now;
      this.state.bots[input.botId] = cur;
      this.recomputeTotals(this.state.totals.totalBots);
      this.save();
      this.notify();
      return;
    }
    cur.lastAttemptTs = now;
    if (input.kind === 'success') cur.lastSuccessTs = now;
    if (input.kind === 'reject') {
      cur.lastRejectTs     = now;
      cur.lastRejectCode   = input.reason;
      cur.lastRejectDetail = input.detail;
      const submitted = cur.recent.filter(x => x.kind === 'attempt' || x.kind === 'success' || x.kind === 'reject').length + 1;
      const rejects   = cur.recent.filter(x => x.kind === 'reject').length + 1;
      const rejectRate = submitted > 0 ? rejects / submitted : 0;
      cur.invalidAttemptRate    = rejectRate;
      cur.executionQualityScore = Math.max(0, Math.min(100, 100 - rejectRate * 100));
    }
    cur.recent = [
      { ts: now, kind: input.kind, symbol: input.symbol, reason: input.reason, detail: input.detail },
      ...cur.recent,
    ].slice(0, 30);
    this.state.bots[input.botId] = cur;
    this.recomputeTotals(this.state.totals.totalBots);
    this.save();
    this.notify();
  }

  /** Per-bot rejection rate over the recent window (0..1). */
  rejectionRate(botId: string): number {
    const cur = this.state.bots[botId];
    if (!cur || cur.recent.length === 0) return 0;
    const r = cur.recent;
    const rejects   = r.filter(x => x.kind === 'reject').length;
    const submitted = r.filter(x => x.kind === 'attempt' || x.kind === 'success' || x.kind === 'reject').length;
    if (submitted === 0) return 0;
    return rejects / submitted;
  }

  private recomputeTotals(totalBots: number) {
    const now = Date.now();
    const ACTIVE_WINDOW = 5 * 60 * 1000;
    let eligible = 0, activeNow = 0, executedToday = 0, standby = 0, blocked = 0;
    for (const b of Object.values(this.state.bots)) {
      if (b.eligibleNow || b.realState === 'real_eligible') eligible++;
      if (b.lastSuccessTs > 0 && now - b.lastSuccessTs < ACTIVE_WINDOW) activeNow++;
      if (b.lastSuccessTs > 0 && now - b.lastSuccessTs < WINDOW_MS) executedToday++;
      // standby = eligible but no recent attempt at all
      if (b.realState === 'standby' || ((b.eligibleNow || b.realState === 'real_eligible') && b.lastAttemptTs === 0)) standby++;
      // blocked = last attempt was a reject AND no success since
      if (
        b.realState === 'blocked' ||
        b.realState === 'benched' ||
        (b.lastRejectTs > 0 && b.lastRejectTs > b.lastSuccessTs)
      ) blocked++;
    }
    this.state.totals = {
      totalBots: Math.max(totalBots, Object.keys(this.state.bots).length),
      eligibleForReal: eligible,
      activeNow,
      executedRealToday: executedToday,
      standby,
      blocked,
    };
    this.state.lastUpdated = now;
  }

  reset(): void { this.state = emptyState(); this.save(); this.notify(); }
}

export const botActivityStore = new BotActivityStore();

export function useBotActivity(): BotActivityState {
  const [s, setS] = useState<BotActivityState>(() => botActivityStore.snapshot());
  useEffect(() => botActivityStore.subscribe(setS), []);
  return s;
}
