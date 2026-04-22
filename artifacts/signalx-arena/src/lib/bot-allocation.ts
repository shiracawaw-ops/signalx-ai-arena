// ─── Per-Bot Capital Allocation Tracker ───────────────────────────────────────
// Tracks how much real-mode USD each bot has currently committed to open
// positions (Phase 4 of the profitability brief, Option 3: fixed cap per bot).
//
// Cap formula: capUSD = tradeAmountUSD * maxOpenPositions
//   - maxOpenPositions = 0  → unlimited (preserves prior behavior)
//   - committed[botId] tracks per-symbol amount so that a closing-SELL can
//     release exactly what the matching BUY committed.
//
// This module is pure side-effect on a process-local Map. It is used by the
// execution engine before the risk check (to deny over-allocation) and after
// a successful BUY/SELL (to commit/release). Tests reset it via
// `resetBotAllocation()`.

interface BotCommitments {
  /** symbol → committed USD amount for that symbol's open position. */
  bySymbol: Map<string, number>;
  totalUSD: number;
}

const COMMITMENTS = new Map<string, BotCommitments>();

export interface BotAllocationConfig {
  tradeAmountUSD:   number;
  maxOpenPositions: number;
}

export interface BotAllocationCheckInput {
  botId?:   string;
  symbol:   string;
  amountUSD: number;
  config:   BotAllocationConfig;
}

export type BotAllocationResult =
  | { ok: true;  capUSD: number; committedUSD: number; remainingUSD: number }
  | { ok: false; capUSD: number; committedUSD: number; remainingUSD: number; reason: string };

/** capUSD = tradeAmountUSD * maxOpenPositions; 0 → Infinity (unlimited). */
export function computeBotCap(config: BotAllocationConfig): number {
  if (!Number.isFinite(config.tradeAmountUSD) || config.tradeAmountUSD <= 0) return 0;
  if (!Number.isFinite(config.maxOpenPositions) || config.maxOpenPositions <= 0) return Infinity;
  return config.tradeAmountUSD * config.maxOpenPositions;
}

export function getCommittedUSD(botId: string | undefined): number {
  if (!botId) return 0;
  return COMMITMENTS.get(botId)?.totalUSD ?? 0;
}

export function getCommittedForSymbol(botId: string | undefined, symbol: string): number {
  if (!botId) return 0;
  return COMMITMENTS.get(botId)?.bySymbol.get(symbol) ?? 0;
}

/**
 * Pre-trade check. If `botId` is missing, allocation is not enforced (signal
 * came from a manual order or a legacy path); the engine still runs its other
 * gates. Returns `{ ok: false }` only when adding `amountUSD` would exceed
 * the bot's cap.
 */
export function checkBotAllocation(input: BotAllocationCheckInput): BotAllocationResult {
  const cap = computeBotCap(input.config);
  const committed = getCommittedUSD(input.botId);
  const remaining = cap === Infinity ? Infinity : Math.max(0, cap - committed);

  if (!input.botId || cap === Infinity) {
    return { ok: true, capUSD: cap, committedUSD: committed, remainingUSD: remaining };
  }
  if (input.amountUSD > remaining + 0.01) {
    return {
      ok: false,
      capUSD: cap,
      committedUSD: committed,
      remainingUSD: remaining,
      reason:
        `Bot allocation cap reached: $${committed.toFixed(2)} of $${cap.toFixed(2)} ` +
        `committed; this $${input.amountUSD.toFixed(2)} order would exceed it. ` +
        `Either close an existing position or raise tradeAmountUSD × maxOpenPositions.`,
    };
  }
  return { ok: true, capUSD: cap, committedUSD: committed, remainingUSD: remaining };
}

/** Record a successful BUY: commits `amountUSD` to (botId, symbol). */
export function commitBotAllocation(
  botId: string | undefined,
  symbol: string,
  amountUSD: number,
): void {
  if (!botId || !Number.isFinite(amountUSD) || amountUSD <= 0) return;
  let entry = COMMITMENTS.get(botId);
  if (!entry) {
    entry = { bySymbol: new Map(), totalUSD: 0 };
    COMMITMENTS.set(botId, entry);
  }
  const prev = entry.bySymbol.get(symbol) ?? 0;
  entry.bySymbol.set(symbol, prev + amountUSD);
  entry.totalUSD += amountUSD;
}

/**
 * Release commitment for a closing-SELL. Releases the FULL amount currently
 * tracked for (botId, symbol) — partial exits are released proportionally
 * by `qtyRatio` (1 = full close, 0.5 = half).
 */
export function releaseBotAllocation(
  botId: string | undefined,
  symbol: string,
  qtyRatio = 1,
): number {
  if (!botId) return 0;
  const entry = COMMITMENTS.get(botId);
  if (!entry) return 0;
  const current = entry.bySymbol.get(symbol) ?? 0;
  if (current <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, qtyRatio));
  const release = current * ratio;
  const remaining = current - release;
  if (remaining <= 0.0001) {
    entry.bySymbol.delete(symbol);
  } else {
    entry.bySymbol.set(symbol, remaining);
  }
  entry.totalUSD = Math.max(0, entry.totalUSD - release);
  if (entry.totalUSD <= 0.0001 && entry.bySymbol.size === 0) {
    COMMITMENTS.delete(botId);
  }
  return release;
}

/** Test/dev helper: wipe all per-bot commitments. */
export function resetBotAllocation(botId?: string): void {
  if (botId) COMMITMENTS.delete(botId);
  else COMMITMENTS.clear();
}

export interface BotAllocationSnapshot {
  botId:        string;
  totalUSD:     number;
  positions:    Array<{ symbol: string; amountUSD: number }>;
}

export function snapshotBotAllocations(): BotAllocationSnapshot[] {
  const out: BotAllocationSnapshot[] = [];
  for (const [botId, entry] of COMMITMENTS) {
    out.push({
      botId,
      totalUSD: Math.round(entry.totalUSD * 100) / 100,
      positions: Array.from(entry.bySymbol.entries()).map(([symbol, amt]) => ({
        symbol,
        amountUSD: Math.round(amt * 100) / 100,
      })),
    });
  }
  return out;
}
