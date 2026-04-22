// Pure helpers + state machine for the per-asset "Confirm close position"
// dialog shown on the Balances tab in Real mode. Extracted out of the giant
// exchange.tsx page so the open / cancel / confirm transitions and the
// per-asset preview calculation can be unit tested without rendering React.
//
// Mirrors the shape of `sweep-dust-dialog.ts` so the two Balances-tab
// confirmation dialogs share a consistent pattern. The dialog itself lives
// in pages/exchange.tsx and matches the styling of the cancel-all and
// sweep-dust dialogs.

export interface ClosePositionPlan {
  exchangeId:   string;
  exchangeName: string;
  asset:        string;
  available:    number;
  usdValue?:    number;
}

export interface ClosePositionBalanceLite {
  asset:     string;
  available: number;
  usdtValue?: number;
}

// Build the preview the dialog renders for the given asset. The asset
// is normalised to upper-case so the dialog never shows a mixed-case
// symbol. Available qty and USDT value are looked up from the live
// balance list when present; if the asset isn't in `balances` the
// dialog still renders (with no qty/value) so the user can see exactly
// what action they're confirming.
export function buildClosePositionPlan(args: {
  exchangeId:   string;
  exchangeName: string;
  asset:        string;
  balances:     ReadonlyArray<ClosePositionBalanceLite>;
}): ClosePositionPlan {
  const asset = args.asset.toUpperCase();
  const row = args.balances.find(b => b.asset.toUpperCase() === asset);
  const available = row && Number.isFinite(row.available) ? row.available : 0;
  const usdValue =
    row && typeof row.usdtValue === 'number' && Number.isFinite(row.usdtValue)
      ? row.usdtValue
      : undefined;
  return {
    exchangeId:   args.exchangeId,
    exchangeName: args.exchangeName,
    asset,
    available,
    ...(usdValue !== undefined ? { usdValue } : {}),
  };
}

// ── Tiny state machine for the dialog ───────────────────────────────────────
// Modeled as plain transitions so unit tests can step through the open /
// cancel / confirm paths without React. The page wires the `asset` straight
// into the actual close call when `confirm` resolves.

export interface ClosePositionDialogState {
  open:  boolean;
  asset: string;
}

export const initialClosePositionDialogState: ClosePositionDialogState = {
  open:  false,
  asset: '',
};

export function openClosePositionDialog(asset: string): ClosePositionDialogState {
  const cleaned = (asset ?? '').trim().toUpperCase();
  return { open: cleaned.length > 0, asset: cleaned };
}

export function cancelClosePositionDialog(): ClosePositionDialogState {
  return { open: false, asset: '' };
}

// Returns the asset to close, plus the cleared dialog state. The page
// passes `asset` straight into its existing close-position call.
export function confirmClosePositionDialog(
  state: ClosePositionDialogState,
): { asset: string; next: ClosePositionDialogState } {
  return { asset: state.asset, next: { open: false, asset: '' } };
}
