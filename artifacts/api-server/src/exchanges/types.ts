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
  getSymbolRules(creds: ExchangeCredentials, symbol: string): Promise<SymbolRules>;
  placeOrder(creds: ExchangeCredentials, order: OrderRequest): Promise<OrderResult>;
  cancelOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<boolean>;
  getOrderHistory(creds: ExchangeCredentials, symbol?: string, limit?: number): Promise<OrderResult[]>;
  getOrder(creds: ExchangeCredentials, orderId: string, symbol?: string): Promise<OrderResult | null>;
  getPrice(symbol: string): Promise<number>;  // public ticker price (no auth required)
  normalizeSymbol(symbol: string): string;  // e.g. "BTC" → "BTCUSDT" for Binance
  ping(): Promise<number>;  // latency ms
}
