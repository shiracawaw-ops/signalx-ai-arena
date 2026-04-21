// ─── Internal Positions Ledger ────────────────────────────────────────────────
// Local, in-process record of what we BOUGHT but the exchange hasn't yet
// reflected in /balances (Bybit takes 1-3s to settle a market fill, and our
// balance cache layer holds stale numbers for ~5s). Without this, a SELL
// fired right after a successful BUY is rejected with INSUFFICIENT_BALANCE
// even though we DO own the asset on the exchange.
//
// Used by the engine + rejection-shield to compute
//     effectiveOwned = max(exchangeReportedFreeBase, ledgerOwnedBase)
// for SELL-side risk and pre-flight checks.

export interface LedgerEntry {
  exchange:     string;
  baseAsset:    string;     // e.g. "BTC"
  qty:          number;     // base units owned (sum across this session)
  avgEntry:     number;     // VWAP entry price
  lastFilledAt: number;     // ms timestamp of last fill that touched this entry
}

const LEDGER = new Map<string, LedgerEntry>();
function key(exchange: string, baseAsset: string) {
  return `${exchange.toLowerCase()}:${baseAsset.toUpperCase()}`;
}

export function recordBuy(exchange: string, baseAsset: string, qty: number, price: number): void {
  if (!exchange || !baseAsset || !(qty > 0)) return;
  const k = key(exchange, baseAsset);
  const prev = LEDGER.get(k);
  if (prev) {
    const newQty = prev.qty + qty;
    const newAvg = newQty > 0 ? (prev.avgEntry * prev.qty + price * qty) / newQty : price;
    LEDGER.set(k, { exchange, baseAsset, qty: newQty, avgEntry: newAvg, lastFilledAt: Date.now() });
  } else {
    LEDGER.set(k, { exchange, baseAsset, qty, avgEntry: price, lastFilledAt: Date.now() });
  }
}

export function recordSell(exchange: string, baseAsset: string, qty: number): void {
  if (!exchange || !baseAsset || !(qty > 0)) return;
  const k = key(exchange, baseAsset);
  const prev = LEDGER.get(k);
  if (!prev) return;
  const remaining = prev.qty - qty;
  if (remaining <= 1e-12) {
    LEDGER.delete(k);
  } else {
    LEDGER.set(k, { ...prev, qty: remaining, lastFilledAt: Date.now() });
  }
}

/** Owned qty according to our local ledger (0 if we never traded it here). */
export function getOwned(exchange: string, baseAsset: string): number {
  return LEDGER.get(key(exchange, baseAsset))?.qty ?? 0;
}

/** Has this position been opened in-session within the freshness window? */
export function isFreshlyOpened(exchange: string, baseAsset: string, withinMs = 30_000): boolean {
  const e = LEDGER.get(key(exchange, baseAsset));
  if (!e) return false;
  return Date.now() - e.lastFilledAt < withinMs;
}

/** Snapshot for diagnostics/UI. */
export function listInternalPositions(): LedgerEntry[] {
  return [...LEDGER.values()];
}

/** Test helper. */
export function _resetInternalPositions(): void { LEDGER.clear(); }
