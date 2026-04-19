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
  trade:    boolean;
  withdraw: boolean;
  futures:  boolean;
}

export interface ConnectResult {
  success:     boolean;
  permissions: Permission;
  uid?:        string;
  error?:      string;
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
