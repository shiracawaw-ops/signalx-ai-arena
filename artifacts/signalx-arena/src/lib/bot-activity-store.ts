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
          };
        } else {
          this.state.bots[b.id].name        = b.name ?? this.state.bots[b.id].name;
          this.state.bots[b.id].eligibleNow = elig.has(b.id);
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
          };
        }
      }
    }
    this.recomputeTotals(input.totalBots);
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
    cur.lastAttemptTs = now;
    if (input.kind === 'success') cur.lastSuccessTs = now;
    if (input.kind === 'reject') {
      cur.lastRejectTs     = now;
      cur.lastRejectCode   = input.reason;
      cur.lastRejectDetail = input.detail;
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
      if (b.eligibleNow) eligible++;
      if (b.lastSuccessTs > 0 && now - b.lastSuccessTs < ACTIVE_WINDOW) activeNow++;
      if (b.lastSuccessTs > 0 && now - b.lastSuccessTs < WINDOW_MS) executedToday++;
      // standby = eligible but no recent attempt at all
      if (b.eligibleNow && b.lastAttemptTs === 0) standby++;
      // blocked = last attempt was a reject AND no success since
      if (b.lastRejectTs > 0 && b.lastRejectTs > b.lastSuccessTs) blocked++;
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
