// ─── Bot Fleet Control (advanced bot-count + real-balance gating) ─────────────
// Manages how many bots may trade with REAL balance and what happens to the
// remaining bots (standby / paper / disabled). Wires into capital-allocator
// so non-real bots never receive real capital, and into autopilot so non-real
// bots are excluded from real execution.
//
// All state is persisted to localStorage. A subscribe() hook lets React panels
// re-render on changes. validateFleet() returns warnings the UI can surface.

import { useEffect, useState } from 'react';

export const FLEET_MAX_BOTS = 50;
export const FLEET_MIN_BOTS = 1;

export type RemainingMode = 'standby' | 'paper' | 'disabled';

export interface FleetConfig {
  maxBots:        number;          // 1..50
  activeRealBots: number;          // 0..maxBots
  remainingMode:  RemainingMode;
  /** Ordered bot IDs (top-N is "real"). Recomputed when bot list changes. */
  realBotIds:     string[];
}

export interface FleetSummary {
  maxBots:           number;
  totalBots:         number;       // bots that exist right now
  activeRealBots:    number;       // requested real count (may exceed totalBots)
  effectiveRealBots: number;       // min(activeRealBots, totalBots)
  remainingBots:     number;       // totalBots - effectiveRealBots
  remainingMode:     RemainingMode;
  allocationPerBot:  number;       // realBalance / effectiveRealBots
  warnings:          string[];
  blocking:          boolean;      // true → config invalid, can't trade
}

export interface BotLite { id: string; name?: string }

const STORAGE_KEY = 'sx_bot_fleet_v1';

function clampInt(n: unknown, lo: number, hi: number, fb: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fb;
  return Math.min(hi, Math.max(lo, v));
}

function defaultConfig(): FleetConfig {
  return { maxBots: 20, activeRealBots: 5, remainingMode: 'paper', realBotIds: [] };
}

function normalize(raw: Partial<FleetConfig> | null | undefined): FleetConfig {
  const d = defaultConfig();
  if (!raw || typeof raw !== 'object') return d;
  const maxBots        = clampInt(raw.maxBots, FLEET_MIN_BOTS, FLEET_MAX_BOTS, d.maxBots);
  const activeRealBots = clampInt(raw.activeRealBots, 0, maxBots, Math.min(d.activeRealBots, maxBots));
  const mode: RemainingMode =
    raw.remainingMode === 'standby' || raw.remainingMode === 'disabled' ? raw.remainingMode : 'paper';
  const realBotIds = Array.isArray(raw.realBotIds)
    ? raw.realBotIds.filter(x => typeof x === 'string').slice(0, FLEET_MAX_BOTS)
    : [];
  return { maxBots, activeRealBots, remainingMode: mode, realBotIds };
}

type Listener = (cfg: FleetConfig) => void;

class BotFleetManager {
  private cfg: FleetConfig = defaultConfig();
  private listeners = new Set<Listener>();

  constructor() { this.load(); }

  private load() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      this.cfg = normalize(raw ? JSON.parse(raw) as Partial<FleetConfig> : null);
    } catch { this.cfg = defaultConfig(); }
  }

  private save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cfg)); } catch { /* storage full */ }
  }

  private notify() {
    const snap = { ...this.cfg, realBotIds: [...this.cfg.realBotIds] };
    this.listeners.forEach(fn => { try { fn(snap); } catch { /* swallow */ } });
  }

  get(): FleetConfig {
    return { ...this.cfg, realBotIds: [...this.cfg.realBotIds] };
  }

  set(patch: Partial<FleetConfig>) {
    this.cfg = normalize({ ...this.cfg, ...patch });
    // Cascade: shrink activeRealBots if maxBots dropped below it.
    if (this.cfg.activeRealBots > this.cfg.maxBots) this.cfg.activeRealBots = this.cfg.maxBots;
    // Drop real-bot IDs that would exceed the new active count.
    if (this.cfg.realBotIds.length > this.cfg.activeRealBots) {
      this.cfg.realBotIds = this.cfg.realBotIds.slice(0, this.cfg.activeRealBots);
    }
    this.save();
    this.notify();
  }

  reset() { this.cfg = defaultConfig(); this.save(); this.notify(); }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Recompute the canonical real-bot ID list from the live bot fleet, in the
   * order callers provide (typically performance-sorted). Picks the first
   * `activeRealBots` IDs that still exist. Pure relative to inputs.
   */
  pickRealBots(allBots: BotLite[]): string[] {
    const alive = new Set(allBots.map(b => b.id));
    const previous = this.cfg.realBotIds.filter(id => alive.has(id));
    const need = Math.min(this.cfg.activeRealBots, allBots.length);
    if (previous.length >= need) return previous.slice(0, need);
    const picked = [...previous];
    for (const b of allBots) {
      if (picked.length >= need) break;
      if (!picked.includes(b.id)) picked.push(b.id);
    }
    return picked;
  }

  /** Persist the picked list so the same bots keep their "real" slot. */
  syncRealBotIds(allBots: BotLite[]) {
    const next = this.pickRealBots(allBots);
    const same =
      next.length === this.cfg.realBotIds.length &&
      next.every((id, i) => id === this.cfg.realBotIds[i]);
    if (!same) {
      this.cfg = { ...this.cfg, realBotIds: next };
      this.save();
      this.notify();
    }
    return next;
  }
}

export const botFleet = new BotFleetManager();

/** React hook — re-renders on every fleet config change. */
export function useBotFleet(): FleetConfig {
  const [cfg, setCfg] = useState<FleetConfig>(() => botFleet.get());
  useEffect(() => botFleet.subscribe(setCfg), []);
  return cfg;
}

export interface ValidateInput {
  cfg:             FleetConfig;
  totalBots:       number;
  realBalanceUSD:  number;
  minNotionalUSD?: number;   // exchange minimum order size (default 10)
  feeBufferPct?:   number;   // % of allocation reserved for fees (default 0.5)
  safetyReservePct?: number; // % of balance held back (default 10)
}

export function summarizeFleet(input: ValidateInput): FleetSummary {
  const { cfg, totalBots, realBalanceUSD } = input;
  const minNotional   = Math.max(1, input.minNotionalUSD   ?? 10);
  const feeBuffer     = Math.max(0, input.feeBufferPct     ?? 0.5) / 100;
  const safetyReserve = Math.max(0, Math.min(50, input.safetyReservePct ?? 10)) / 100;

  const effectiveRealBots = Math.max(0, Math.min(cfg.activeRealBots, totalBots));
  const remainingBots     = Math.max(0, totalBots - effectiveRealBots);

  const deployable     = Math.max(0, realBalanceUSD * (1 - safetyReserve));
  const perBotGross    = effectiveRealBots > 0 ? deployable / effectiveRealBots : 0;
  const perBotNet      = perBotGross * (1 - feeBuffer);
  const allocationPerBot = Math.round(perBotNet * 100) / 100;

  const warnings: string[] = [];
  let blocking = false;

  if (cfg.activeRealBots > cfg.maxBots) {
    warnings.push(`Active real bots (${cfg.activeRealBots}) exceeds total bots (${cfg.maxBots}).`);
    blocking = true;
  }
  if (cfg.maxBots > FLEET_MAX_BOTS) {
    warnings.push(`Total bots (${cfg.maxBots}) exceeds platform limit of ${FLEET_MAX_BOTS}.`);
    blocking = true;
  }
  if (cfg.activeRealBots > totalBots && totalBots > 0) {
    warnings.push(`You requested ${cfg.activeRealBots} real bots but only ${totalBots} exist. Trading will use ${effectiveRealBots}.`);
  }
  if (effectiveRealBots > 0 && realBalanceUSD <= 0) {
    warnings.push(`Real balance is $0. Fund your account before activating real bots.`);
    blocking = true;
  }
  if (effectiveRealBots > 0 && allocationPerBot < minNotional) {
    warnings.push(
      `Per-bot allocation ($${allocationPerBot.toFixed(2)}) is below exchange minimum ($${minNotional.toFixed(2)}). ` +
      `Reduce active real bots or add capital.`,
    );
    blocking = true;
  }
  if (effectiveRealBots === 0 && cfg.activeRealBots > 0) {
    warnings.push(`No bots exist yet — create bots in the Arena before activating real trading.`);
  }

  return {
    maxBots:        cfg.maxBots,
    totalBots,
    activeRealBots: cfg.activeRealBots,
    effectiveRealBots,
    remainingBots,
    remainingMode:  cfg.remainingMode,
    allocationPerBot,
    warnings,
    blocking,
  };
}
