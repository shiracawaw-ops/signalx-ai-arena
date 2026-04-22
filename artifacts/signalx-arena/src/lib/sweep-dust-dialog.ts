// Pure helpers + state machine for the per-asset "Confirm dust sweep" dialog
// shown on the Balances tab in Real mode. Extracted out of the giant
// exchange.tsx page so the open / cancel / confirm transitions and the
// per-asset payout calculation can be unit tested without rendering React.
//
// The dialog itself lives in pages/exchange.tsx and mirrors the styling of
// the existing "Cancel ALL open orders" dialog.

export interface SweepDustRow {
  asset:     string;
  usdValue?: number;
}

export interface SweepDustPlan {
  exchangeId:   string;
  exchangeName: string;
  payoutToken:  string;
  rows:         SweepDustRow[];
  totalUsd:     number;
}

// Per-exchange dust-payout token. Binance pays out the converted dust in BNB
// (NOT USDT). Other adapters either route through their own payout token or
// have no native dust API at all (handled at the API layer with
// `notSupported: true`); for those we fall back to a generic label so the
// dialog still renders something honest.
const PAYOUT_TOKEN_BY_EXCHANGE: Record<string, string> = {
  binance: 'BNB',
};

export function getDustPayoutToken(exchangeId: string): string {
  return PAYOUT_TOKEN_BY_EXCHANGE[exchangeId.toLowerCase()] ?? 'the venue\u2019s payout token';
}

export interface BalanceLite {
  asset:     string;
  usdtValue?: number;
}

// Build the per-asset plan the dialog renders. Targets are normalised to
// upper-case and de-duplicated so the dialog never shows the same asset
// twice even if the caller passed mixed case. USDT values are looked up
// from the live balance list when available; rows for assets that aren't
// in `balances` still render (with no value) so the user can see exactly
// what will be sent to the exchange.
export function buildSweepDustPlan(args: {
  exchangeId:   string;
  exchangeName: string;
  targets:      string[];
  balances:     ReadonlyArray<BalanceLite>;
}): SweepDustPlan {
  const targets = Array.from(
    new Set(args.targets.map(t => t.toUpperCase()).filter(Boolean)),
  );
  const valueByAsset = new Map<string, number>();
  for (const b of args.balances) {
    if (typeof b.usdtValue === 'number' && Number.isFinite(b.usdtValue)) {
      valueByAsset.set(b.asset.toUpperCase(), b.usdtValue);
    }
  }
  const rows: SweepDustRow[] = targets.map(a => {
    const v = valueByAsset.get(a);
    return v === undefined ? { asset: a } : { asset: a, usdValue: v };
  });
  const totalUsd = rows.reduce((s, r) => s + (r.usdValue ?? 0), 0);
  return {
    exchangeId:   args.exchangeId,
    exchangeName: args.exchangeName,
    payoutToken:  getDustPayoutToken(args.exchangeId),
    rows,
    totalUsd,
  };
}

// ── Tiny state machine for the dialog ───────────────────────────────────────
// Modeled as plain transitions so unit tests can step through the open /
// cancel / confirm paths without React. The page wires the `targets` list
// straight into the actual sweep call when `confirm` resolves.

export interface SweepDustDialogState {
  open:    boolean;
  targets: string[];
}

export const initialSweepDustDialogState: SweepDustDialogState = {
  open:    false,
  targets: [],
};

export function openSweepDustDialog(targets: string[]): SweepDustDialogState {
  const cleaned = Array.from(
    new Set(targets.map(t => t.toUpperCase()).filter(Boolean)),
  );
  return { open: cleaned.length > 0, targets: cleaned };
}

export function cancelSweepDustDialog(): SweepDustDialogState {
  return { open: false, targets: [] };
}

// Returns the targets that should be swept, plus the cleared dialog state.
// The page passes `targets` straight into its existing `executeSweep` call.
export function confirmSweepDustDialog(
  state: SweepDustDialogState,
): { targets: string[]; next: SweepDustDialogState } {
  return { targets: state.targets, next: { open: false, targets: [] } };
}
