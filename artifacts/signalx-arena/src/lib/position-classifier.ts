// ─── Position Classifier ──────────────────────────────────────────────────────
// Pure, exchange-aware classifier that turns a raw wallet row + (optional)
// tracked bot position + (optional) cached symbol rules into a single
// verdict the UI and the engine both consume. Lives outside React so it can
// be unit-tested and reused by both the Balances tab AND the close-position
// preflight inside the execution engine.
//
// Categories
//   active_position    — bot opened it this session and we still hold most of it
//   partial_position   — bot opened it but qty has been reduced (residual)
//   dust_balance       — we hold something but it's below exchange minimums
//   wallet_holding     — non-stable wallet asset that we did NOT trade for
//   fully_closed       — bot opened then fully flattened (no balance left)
//
// Reasons (controlled vocabulary — also used as toast/log copy):
//   sellable_position  · unsellable_dust · fully_flattened
//   residual_sellable  · residual_unsellable
//   wallet_only_not_trade_position
//   below_min_notional · below_min_sell_qty
//   symbol_rules_unknown
//
// The classifier never touches the network — callers feed it cached rules.

import type { SymbolRules } from './risk-manager.js';

export type PositionCategory =
  | 'active_position'
  | 'partial_position'
  | 'dust_balance'
  | 'wallet_holding'
  | 'fully_closed';

export type PositionReason =
  | 'sellable_position'
  | 'unsellable_dust'
  | 'fully_flattened'
  | 'residual_sellable'
  | 'residual_unsellable'
  | 'wallet_only_not_trade_position'
  | 'below_min_notional'
  | 'below_min_sell_qty'
  | 'symbol_rules_unknown';

export interface ClassifyInput {
  asset:           string;             // base asset, e.g. "BTC"
  available:       number;             // free balance on exchange
  hold?:           number;             // locked balance (optional)
  usdtValue?:      number;             // current USD value of `available` (when known)
  exchange:        string;
  symbolRules?:    SymbolRules;        // cached, may be undefined
  trackedQty?:     number;             // qty the bot opened this session (optional)
  trackedEntry?:   number;             // entry price for residual % computation
  isDustMarked?:   boolean;            // doctor already marked this asset as dust
  /** Optional human-readable reason from the doctor (preferred when present). */
  dustReason?:     string;
  isStable?:       boolean;            // caller already knows USDT/USDC/etc.
  /** Residual considered "partial" when 0 < available/trackedQty <= this. Default 0.95. */
  partialThreshold?: number;
}

export interface ClassifyResult {
  category:       PositionCategory;
  reason:         PositionReason;
  /** True when a SELL of `available` would clear all exchange minimums. */
  sellable:       boolean;
  /** True when the UI should show a "Close Position" button. */
  canClose:       boolean;
  /** Operator-facing one-liner; safe to render directly in chips/toasts. */
  detail:         string;
  /** Numeric thresholds surfaced for diagnostics chips. */
  minNotionalUSD?: number;
  minQty?:         number;
  /** Estimated notional for the available qty (USD), computed when possible. */
  notionalUSD?:    number;
}

const EPSILON = 1e-9;

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1) return n.toFixed(digits);
  return n.toPrecision(Math.max(2, digits));
}

/**
 * Classify one wallet row. Pure: no I/O, no store reads.
 * Order matters: stable → fully closed → dust mark → wallet vs tracked → rules.
 */
export function classifyHolding(input: ClassifyInput): ClassifyResult {
  const {
    asset, available, usdtValue,
    symbolRules, trackedQty = 0, isDustMarked, isStable,
    partialThreshold = 0.95,
  } = input;

  const minQty       = symbolRules?.minQty       ?? 0;
  const minNotional  = symbolRules?.minNotional  ?? 0;

  // ── Stable coin — never tradable as a "position", but never dust either ──
  if (isStable) {
    return {
      category: 'wallet_holding',
      reason:   'wallet_only_not_trade_position',
      sellable: false,
      canClose: false,
      detail:   `${asset} is a stable settlement asset — not a position.`,
    };
  }

  // ── Fully closed — bot tracked it, and now nothing left ──
  if (trackedQty > 0 && available <= EPSILON) {
    return {
      category: 'fully_closed',
      reason:   'fully_flattened',
      sellable: false,
      canClose: false,
      detail:   `${asset} fully closed by the bot (no remaining balance).`,
    };
  }

  // ── Doctor already marked this asset as dust ──
  // Treat as authoritative even if we have no rules cached yet. Prefer the
  // doctor's recorded reason text (which carries the precise minNotional /
  // minQty math from when the dust was first observed) so the UI chip and
  // the engine reject use the same wording.
  if (isDustMarked && available > EPSILON) {
    const valueText = typeof usdtValue === 'number' ? `≈ $${fmt(usdtValue)}` : `${fmt(available, 6)} ${asset}`;
    const fallback  = trackedQty > 0
      ? `Residual ${valueText} of ${asset} is below the exchange minimum and was marked dust.`
      : `${valueText} of ${asset} is below the exchange minimum and was marked dust.`;
    const detailText = (input.dustReason && input.dustReason.trim().length > 0)
      ? `Marked dust: ${input.dustReason}`
      : fallback;
    return {
      category: trackedQty > 0 ? 'partial_position' : 'dust_balance',
      reason:   trackedQty > 0 ? 'residual_unsellable' : 'unsellable_dust',
      sellable: false,
      canClose: false,
      detail:   detailText,
      ...(minNotional > 0 ? { minNotionalUSD: minNotional } : {}),
      ...(minQty > 0      ? { minQty }                     : {}),
      ...(typeof usdtValue === 'number' ? { notionalUSD: usdtValue } : {}),
    };
  }

  // ── No balance and no tracked qty → nothing to show ──
  if (available <= EPSILON && trackedQty <= EPSILON) {
    return {
      category: 'fully_closed',
      reason:   'fully_flattened',
      sellable: false,
      canClose: false,
      detail:   `${asset} has no available balance.`,
    };
  }

  // ── Compute notional and decide active vs partial vs wallet ──
  const notional = typeof usdtValue === 'number' && Number.isFinite(usdtValue) ? usdtValue : undefined;

  // Determine ratio of remaining qty vs what the bot opened.
  let category: PositionCategory;
  if (trackedQty > 0) {
    const ratio = available / trackedQty;
    category = ratio >= partialThreshold ? 'active_position' : 'partial_position';
  } else {
    category = 'wallet_holding';
  }

  // ── Without symbol rules we can't be sure it's tradable; warn and allow ──
  if (!symbolRules) {
    if (category === 'wallet_holding') {
      return {
        category: 'wallet_holding',
        reason:   'wallet_only_not_trade_position',
        sellable: false,
        canClose: false,
        detail:   `${asset} sits in your wallet but no bot opened it on ${input.exchange}. Use the manual order form to trade it.`,
        ...(notional !== undefined ? { notionalUSD: notional } : {}),
      };
    }
    return {
      category,
      reason:   'symbol_rules_unknown',
      sellable: false,
      canClose: false,
      detail:   `Exchange rules for ${asset} are not cached yet — refresh symbol rules before closing.`,
      ...(notional !== undefined ? { notionalUSD: notional } : {}),
    };
  }

  // ── Apply min-qty / min-notional gates ──
  if (minQty > 0 && available < minQty) {
    const isResidual = trackedQty > 0;
    return {
      category: isResidual ? 'partial_position' : 'dust_balance',
      reason:   isResidual ? 'residual_unsellable' : 'below_min_sell_qty',
      sellable: false,
      canClose: false,
      detail:   `${asset} qty ${fmt(available, 6)} is below ${input.exchange} minQty ${fmt(minQty, 6)} — too small to close on this venue.`,
      minNotionalUSD: minNotional,
      minQty,
      ...(notional !== undefined ? { notionalUSD: notional } : {}),
    };
  }

  if (minNotional > 0 && notional !== undefined && notional < minNotional) {
    const isResidual = trackedQty > 0;
    return {
      category: isResidual ? 'partial_position' : 'dust_balance',
      reason:   isResidual ? 'residual_unsellable' : 'below_min_notional',
      sellable: false,
      canClose: false,
      detail:   `${asset} value $${fmt(notional)} is below ${input.exchange} minNotional $${fmt(minNotional)} — close on a venue with a smaller minimum or top up.`,
      minNotionalUSD: minNotional,
      minQty,
      notionalUSD: notional,
    };
  }

  // ── Wallet-only assets with rules but no tracked qty: surface but don't auto-close ──
  if (category === 'wallet_holding') {
    return {
      category: 'wallet_holding',
      reason:   'wallet_only_not_trade_position',
      sellable: true,
      // Wallet-only sells should NOT be one-clickable from the Open Positions
      // section — they were not opened by the bot, so closing them is a
      // manual decision. Use the manual order form instead.
      canClose: false,
      detail:   `${asset} sits in your wallet but no bot opened it on ${input.exchange}. Use the manual order form to sell it.`,
      minNotionalUSD: minNotional,
      minQty,
      ...(notional !== undefined ? { notionalUSD: notional } : {}),
    };
  }

  // ── Active or partial — sellable ──
  return {
    category,
    reason:   category === 'partial_position' ? 'residual_sellable' : 'sellable_position',
    sellable: true,
    canClose: true,
    detail:   category === 'partial_position'
      ? `Residual ${fmt(available, 6)} ${asset} (${notional !== undefined ? `≈ $${fmt(notional)}` : 'value unknown'}) — close to flatten.`
      : `Active ${asset} position (${notional !== undefined ? `≈ $${fmt(notional)}` : `${fmt(available, 6)} ${asset}`}).`,
    minNotionalUSD: minNotional,
    minQty,
    ...(notional !== undefined ? { notionalUSD: notional } : {}),
  };
}

export const POSITION_CATEGORY_LABELS: Record<PositionCategory, string> = {
  active_position:  'Active Position',
  partial_position: 'Partial Position',
  dust_balance:     'Dust',
  wallet_holding:   'Wallet Holding',
  fully_closed:     'Fully Closed',
};

export const POSITION_CATEGORY_ORDER: PositionCategory[] = [
  'active_position', 'partial_position', 'dust_balance', 'wallet_holding', 'fully_closed',
];
