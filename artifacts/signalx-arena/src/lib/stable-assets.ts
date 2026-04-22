// ─── Stable Assets ────────────────────────────────────────────────────────────
// Single source of truth for the set of "stable settlement assets" recognised
// across the app (UI balances summary, position classifier preflight, real
// profit equity computation, automated dust sweeps, etc.).
//
// Keep this list authoritative. When an exchange lists a new stablecoin we
// want to treat as a settlement asset, add it here and every call site picks
// it up automatically.

export const STABLE_ASSETS: ReadonlySet<string> = new Set<string>([
  'USDT',
  'USDC',
  'USD',
  'BUSD',
  'TUSD',
  'USDP',
  'DAI',
  'FDUSD',
  'USDD',
  'USDE',
  'PYUSD',
  'GUSD',
]);

/**
 * Case-insensitive check: is `asset` one of the recognised stable settlement
 * coins? Returns false for empty / non-string inputs so call sites can pass
 * raw wallet rows without pre-validation.
 */
export function isStable(asset: string | null | undefined): boolean {
  if (typeof asset !== 'string' || asset.length === 0) return false;
  return STABLE_ASSETS.has(asset.toUpperCase());
}

// Sort longest-first so e.g. `FDUSD` matches before `USD` and `BTCUSDT`
// strips `USDT` rather than `USD`.
const STABLE_SUFFIX_RE = new RegExp(
  `[-_/]?(${[...STABLE_ASSETS].sort((a, b) => b.length - a.length).join('|')})$`,
  'u',
);

/**
 * Strip any recognised stable-settlement suffix from a pair symbol and
 * return the upper-cased base ticker. Tolerates common separators
 * (`-`, `_`, `/`). Examples:
 *   BTCUSDT  -> BTC
 *   BTC-USD  -> BTC
 *   ETH_FDUSD -> ETH
 *   SOLDAI   -> SOL
 * Returns the input upper-cased unchanged if no known suffix is present.
 */
export function stripStableSuffix(symbol: string | null | undefined): string {
  return String(symbol ?? '').toUpperCase().replace(STABLE_SUFFIX_RE, '');
}
