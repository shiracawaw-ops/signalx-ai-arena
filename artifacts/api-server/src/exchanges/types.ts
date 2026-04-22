// ─── Unified Exchange Types ────────────────────────────────────────────────────

export type OrderSide   = 'buy' | 'sell';
export type OrderType   = 'market' | 'limit';
export type OrderStatus = 'open' | 'filled' | 'canceled' | 'rejected' | 'partial';
export type ExchangeMode = 'demo' | 'paper' | 'testnet' | 'real';

// Credentials passed per-request (never stored server-side)
export interface ExchangeCredentials {
  apiKey:      string;
  secretKey:   string;
  passphrase?: string;  // KuCoin, OKX, Bitget, Coinbase
  testnet?:    boolean; // route to exchange sandbox endpoint for all calls
}

export interface Balance {
  asset:     string;
  available: number;
  hold:      number;
  total:     number;
  // Approximate USDT value of this asset. Adapters populate this for
  // stable-coin assets (USDT/USDC/DAI/...) where the value equals total;
  // for other assets it is left undefined so the frontend can render
  // "—" instead of a misleading "$0".
  usdtValue?: number;
  // Which scope this balance came from when the adapter merged across
  // multiple account types (e.g. Bybit "UNIFIED" / "SPOT" / "FUND").
  // Optional — adapters that only have one scope leave it undefined.
  scope?:    string;
}

// Per-scope summary produced by adapters that expose granular balance
// breakdowns (Bybit Unified/Spot/Contract/Funding, OKX trading vs funding,
// etc.). The frontend renders this as a transparent table so the user can
// see exactly how the displayed totals were computed and why on-exchange
// total (e.g. 163.61 USD) differs from app-detected tradable (e.g. 12 USD).
export interface BalanceScope {
  accountType:        string;     // "UNIFIED" | "SPOT" | "CONTRACT" | "FUND" | …
  fetched:            boolean;    // did the call succeed for this scope
  totalEquityUSD?:    number;     // exchange-reported total (incl. UPL & margin)
  walletBalanceUSD?:  number;     // exchange-reported wallet balance
  availableUSD?:      number;     // tradable now (free, not in orders/margin)
  lockedUSD?:         number;     // in open orders or used as margin
  coinCount?:         number;     // # coins surfaced for this scope
  error?:             string;     // why this scope failed (if !fetched)
  note?:              string;     // adapter-provided context
}

export interface BalanceSummary {
  // Aggregate across all successfully-fetched scopes.
  totalEquityUSD:     number;     // what Bybit/exchange shows as "total assets"
  totalWalletUSD:     number;     // sum of wallet balances (no UPL)
  totalAvailableUSD:  number;     // tradable across all scopes
  totalLockedUSD:     number;     // locked in orders / used as margin
  fundingUSD:         number;     // sitting in funding wallet (not yet tradable)
  tradingUSD:         number;     // sitting in trading-side accounts
  externalUSD?:       number;     // outside trading wallets — Earn / Savings / Staking / Copy
  externalBreakdown?: Array<{ source: string; usd: number; coinCount: number; note?: string }>;
  scopes:             BalanceScope[];
  // Free-form notes the UI surfaces verbatim under the breakdown table —
  // e.g. "USDC was found via per-coin usdValue", "Funding wallet contains
  // 151 USDC; transfer to Unified to use it for spot trades".
  notes:              string[];
  // The raw exchange-reported totals so the user can see the same number
  // they see in the Bybit app — independently of how the app sums coins.
  exchangeReported?: {
    totalEquityUSD?:    number;
    totalWalletUSD?:    number;
    totalAvailableUSD?: number;
  };
}

export interface SymbolRules {
  symbol:       string;
  baseCurrency:  string;
  quoteCurrency: string;
  minQty:        number;
  maxQty:        number;
  stepSize:      number;
  minNotional:   number;  // minimum trade value in quote currency
  tickSize:      number;  // price precision
  maxLeverage:   number;
  // Precision fields used to format quantity/price strings sent to the
  // exchange so float-rounding noise (e.g. 5.6000000000001) never trips
  // a LOT_SIZE / PRICE_FILTER rejection. Optional for backwards compat;
  // when omitted, callers derive precision from stepSize/tickSize.
  baseAssetPrecision?:  number;   // # decimal places allowed for quantity
  quoteAssetPrecision?: number;   // # decimal places allowed for quote
  pricePrecision?:      number;   // # decimal places allowed for price
  status?:              string;   // exchange-side trading status (TRADING / BREAK / …)
  isSpotTradingAllowed?: boolean; // whether spot is enabled for this pair on the exchange
  isInnovation?:        boolean;  // bybit innovation-zone listing (stricter rules)
  filterSource?:        'live' | 'cached' | 'stub' | 'binance:exchangeInfo' | 'bybit:instruments-info';
}

// Result of a "test order" probe — validates filters & permissions WITHOUT
// placing the order. Maps directly to Binance /api/v3/order/test and other
// equivalent endpoints (or a synthetic local-only validation).
export interface OrderTestResult {
  ok:            boolean;
  reason?:       string;          // e.g. "LOT_SIZE" / "MIN_NOTIONAL" / "PRICE_FILTER" / "PERCENT_PRICE"
  detail?:       string;          // human-readable explanation
  exchangeCode?: string | number; // exchange's own error code (e.g. -1013)
  httpStatus?:   number;
  rules?:        SymbolRules;     // the rules used for the check
  echo?:         { symbol: string; side: string; quantity: string; price?: string };
  raw?:          unknown;
}

export interface OrderRequest {
  symbol:   string;
  side:     OrderSide;
  type:     OrderType;
  quantity: number;
  price?:   number;    // required for limit orders
  clientId?: string;
  testnet?:  boolean;  // route to exchange sandbox endpoint when true
}

export interface OrderResult {
  orderId:    string;
  clientId?:  string;
  symbol:     string;
  side:       OrderSide;
  type:       OrderType;
  status:     OrderStatus;
  quantity:   number;
  filledQty:  number;
  price:      number;
  avgPrice:   number;
  fee:        number;
  feeCurrency: string;
  timestamp:  number;
  exchange:   string;
  raw?:       unknown;  // raw exchange response for debugging
}

export interface Permission {
  read:     boolean;
  trade:    boolean;       // canonical "can place ANY order" — primary trading flag
  withdraw: boolean;
  futures:  boolean;
  // Optional granular flags for richer diagnostics in the UI. Adapters that
  // can detect them populate these; older adapters may leave them undefined.
  spot?:     boolean;       // spot trading specifically
  margin?:   boolean;       // cross/iso margin
  options?:  boolean;       // options trading
  accountType?: string;     // e.g. "SPOT", "MARGIN", "UNIFIED"
}

export interface ConnectResult {
  success:     boolean;
  permissions: Permission;
  uid?:        string;
  error?:      string;
  // Raw account snapshot kept for the diagnostics panel. Adapters MUST NOT
  // include secrets here; this is account metadata only (canTrade flags,
  // accountType, permissions array, etc.).
  raw?:        Record<string, unknown>;
}

// ── Diagnostic types ─────────────────────────────────────────────────────────
// Exposed by the `runDiagnostic` and `runSelfTest` adapter methods so the
// frontend can render a transparent "what does the exchange actually say"
// panel without having to ship credentials around for ad-hoc curl tests.

export interface DiagnosticStep {
  step:       string;        // human-readable step name
  ok:         boolean;
  detail?:    string;        // pass message OR error explanation
  code?:      string | number;
  httpStatus?: number;
  raw?:       unknown;       // raw response excerpt (NEVER includes secrets)
  durationMs?: number;
}

export interface ExchangeDiagnostic {
  exchange:        string;
  apiKeyMasked:    string;
  testnet:         boolean;
  outboundIp?:     string;          // public IP the api-server is reaching the exchange from
  permissions:     Permission;
  accountType?:    string;
  steps:           DiagnosticStep[];
  recommendation?: string;          // human guidance e.g. "IP whitelist mismatch likely"
  timestamp:       number;
}

export interface SelfTestResult {
  exchange:     string;
  apiKeyMasked: string;
  testnet:      boolean;
  pass:         boolean;
  steps:        DiagnosticStep[];   // ping → signed account → test order
  summary:      string;
  timestamp:    number;
}

export interface ExchangeError {
  code:     string | number;
  message:  string;
  exchange: string;
  status?:  number;
}

export interface ExchangeAdapter {
  readonly id:   string;
  readonly name: string;

  validateCredentials(creds: ExchangeCredentials): Promise<ConnectResult>;
  getPermissions(creds: ExchangeCredentials): Promise<Permission>;
  getBalances(creds: ExchangeCredentials): Promise<Balance[]>;
  /**
   * Optional: return balances WITH a per-scope breakdown so the UI can show
   * exactly how the displayed totals were assembled (Bybit Unified vs Spot
   * vs Contract vs Funding, etc.). Adapters that don't implement this fall
   * back to plain getBalances().
   */
  getBalanceBreakdown?(creds: ExchangeCredentials): Promise<{ balances: Balance[]; summary: BalanceSummary }>;
  getSymbolRules(creds: ExchangeCredentials, symbol: string): Promise<SymbolRules>;
  placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult>;
  /**
   * Validate an order against the exchange's filters & permissions WITHOUT
   * placing it.  Optional — adapters that don't implement it default to a
   * synthetic local-only check in the API route.
   */
  testOrder?(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderTestResult>;
  cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean>;
  getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit?: number): Promise<OrderResult[]>;
  getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null>;
  getPrice(symbol: string): Promise<number>;  // public ticker price (no auth required)
  normalizeSymbol(symbol: string): string;  // e.g. "BTC" → "BTCUSDT" for Binance
  ping(): Promise<number>;  // latency ms
  /**
   * Optional: convert tiny "dust" leftovers into a stable settlement asset
   * using the venue's native dust-conversion endpoint (e.g. Binance
   * /sapi/v1/asset/dust). Adapters that don't implement this fall back to
   * a copy-paste explanation in the route handler so the UI can still
   * point the user at the exchange's own converter UI.
   */
  sweepDust?(creds: ExchangeCredentials, assets: string[]): Promise<DustSweepResult>;
}

// Result of a dust-sweep call. Adapters report which assets were converted,
// which failed (with a per-asset reason), and an optional aggregate stable-coin
// amount the user received from the conversion.
export interface DustSweepResult {
  exchange:        string;
  swept:           string[];                                // base assets successfully converted
  failed:          Array<{ asset: string; reason: string }>;
  /** Total stable-coin (e.g. BNB or USDT, depending on venue) credited. */
  totalReceived?:  number;
  /** Asset symbol the venue paid out in (e.g. "BNB" for Binance dust→BNB). */
  receivedAsset?:  string;
  /** Free-form note shown verbatim under the toast (e.g. fee disclosures). */
  note?:           string;
  /**
   * Conversions that the venue accepted but were still settling when we gave
   * up polling. The UI should show these as "still settling" rather than as
   * failures — the funds will land in the wallet shortly.
   */
  pending?:        Array<{ asset: string; reason: string; quoteTxId?: string }>;
  raw?:            unknown;
}
