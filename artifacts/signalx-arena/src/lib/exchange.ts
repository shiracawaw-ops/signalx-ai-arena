
// ─── Exchange Adapter — Multi-Exchange Mock Integration ───────────────────────

export type OrderSide   = 'BUY' | 'SELL';
export type OrderType   = 'MARKET' | 'LIMIT' | 'STOP_LOSS';
export type OrderStatus = 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'PARTIAL';

export interface ExchangeOrder {
  orderId:      string;
  symbol:       string;
  side:         OrderSide;
  type:         OrderType;
  quantity:     number;
  price:        number;
  filledQty:    number;
  status:       OrderStatus;
  fee:          number;
  feeCurrency:  string;
  timestamp:    number;
  botId?:       string;
}

export interface ExchangeBalance {
  asset:     string;
  free:      number;
  locked:    number;
  usdtValue: number;
}

export interface ExchangePosition {
  symbol:         string;
  qty:            number;
  avgEntryPrice:  number;
  currentPrice:   number;
  unrealizedPnl:  number;
  realizedPnl:    number;
}

export interface ApiKeyConfig {
  apiKey:      string;
  secretKey:   string;
  exchange:    string;
  mode:        'demo' | 'testnet' | 'live';
  permissions: string[];
}

export interface ExchangeAdapter {
  name:        string;
  mode:        'demo' | 'testnet' | 'live';
  isConnected: boolean;
  connect(config: ApiKeyConfig): Promise<boolean>;
  disconnect(): void;
  getBalances(): Promise<ExchangeBalance[]>;
  placeOrder(order: Omit<ExchangeOrder, 'orderId' | 'filledQty' | 'status' | 'fee' | 'feeCurrency' | 'timestamp'>): Promise<ExchangeOrder>;
  cancelOrder(orderId: string): Promise<boolean>;
  getOrderHistory(symbol?: string, limit?: number): Promise<ExchangeOrder[]>;
  getPositions(): Promise<ExchangePosition[]>;
  ping(): Promise<number>;
}

// ── Known Exchanges ──────────────────────────────────────────────────────────
export interface ExchangeMeta {
  id:          string;
  name:        string;
  shortName:   string;
  website:     string;
  logo:        string;      // color for the logo dot
  accent:      string;      // tailwind color name
  makerFee:    number;      // %
  takerFee:    number;      // %
  description: string;
  hasTestnet:  boolean;
  markets:     string[];
}

export const KNOWN_EXCHANGES: ExchangeMeta[] = [
  {
    id: 'binance', name: 'Binance', shortName: 'Binance', website: 'binance.com',
    logo: '#F0B90B', accent: 'amber',
    makerFee: 0.10, takerFee: 0.10,
    description: "World's largest crypto exchange by volume",
    hasTestnet: true,
    markets: ['Crypto', 'Futures', 'Margin'],
  },
  {
    id: 'coinbase', name: 'Coinbase Advanced', shortName: 'Coinbase', website: 'coinbase.com',
    logo: '#0052FF', accent: 'blue',
    makerFee: 0.40, takerFee: 0.60,
    description: "US-regulated exchange, ideal for institutional access",
    hasTestnet: false,
    markets: ['Crypto', 'Spot'],
  },
  {
    id: 'kraken', name: 'Kraken', shortName: 'Kraken', website: 'kraken.com',
    logo: '#5741D9', accent: 'violet',
    makerFee: 0.16, takerFee: 0.26,
    description: "Trusted European exchange, strong security record",
    hasTestnet: false,
    markets: ['Crypto', 'Futures', 'Margin', 'NFT'],
  },
  {
    id: 'okx', name: 'OKX', shortName: 'OKX', website: 'okx.com',
    logo: '#000000', accent: 'zinc',
    makerFee: 0.08, takerFee: 0.10,
    description: "Global exchange with advanced derivatives & DeFi",
    hasTestnet: true,
    markets: ['Crypto', 'Futures', 'Options', 'Margin'],
  },
  {
    id: 'bybit', name: 'Bybit', shortName: 'Bybit', website: 'bybit.com',
    logo: '#F7A600', accent: 'yellow',
    makerFee: 0.01, takerFee: 0.06,
    description: "Leading derivatives exchange, very low fees",
    hasTestnet: true,
    markets: ['Crypto', 'Futures', 'Perpetuals', 'Spot'],
  },
  {
    id: 'kucoin', name: 'KuCoin', shortName: 'KuCoin', website: 'kucoin.com',
    logo: '#23AF91', accent: 'teal',
    makerFee: 0.10, takerFee: 0.10,
    description: "People's exchange — wide altcoin selection",
    hasTestnet: false,
    markets: ['Crypto', 'Futures', 'Margin', 'NFT'],
  },
  {
    id: 'bitfinex', name: 'Bitfinex', shortName: 'Bitfinex', website: 'bitfinex.com',
    logo: '#16B157', accent: 'emerald',
    makerFee: 0.10, takerFee: 0.20,
    description: "Veteran exchange, large BTC OTC market",
    hasTestnet: false,
    markets: ['Crypto', 'Margin', 'Lending'],
  },
  {
    id: 'mexc', name: 'MEXC Global', shortName: 'MEXC', website: 'mexc.com',
    logo: '#2485EA', accent: 'sky',
    makerFee: 0.00, takerFee: 0.05,
    description: "Zero maker fee, 2,000+ trading pairs",
    hasTestnet: false,
    markets: ['Crypto', 'Futures'],
  },
  {
    id: 'gate', name: 'Gate.io', shortName: 'Gate.io', website: 'gate.io',
    logo: '#E66A1B', accent: 'orange',
    makerFee: 0.20, takerFee: 0.20,
    description: "1,700+ listed tokens including early-stage projects",
    hasTestnet: false,
    markets: ['Crypto', 'Futures', 'Margin', 'NFT'],
  },
  {
    id: 'htx', name: 'HTX (Huobi)', shortName: 'HTX', website: 'htx.com',
    logo: '#1B78E0', accent: 'blue',
    makerFee: 0.20, takerFee: 0.20,
    description: "Formerly Huobi, global tier-1 exchange",
    hasTestnet: false,
    markets: ['Crypto', 'Futures', 'Margin'],
  },
  {
    id: 'bitget', name: 'Bitget', shortName: 'Bitget', website: 'bitget.com',
    logo: '#00E0CC', accent: 'cyan',
    makerFee: 0.02, takerFee: 0.06,
    description: "Top copy-trading platform, low derivative fees",
    hasTestnet: true,
    markets: ['Crypto', 'Futures', 'Copy Trading'],
  },
  {
    id: 'deribit', name: 'Deribit', shortName: 'Deribit', website: 'deribit.com',
    logo: '#E53B3B', accent: 'red',
    makerFee: -0.01, takerFee: 0.03,
    description: "Bitcoin & ETH options market leader",
    hasTestnet: true,
    markets: ['Options', 'Futures', 'Perpetuals'],
  },
];

export const EXCHANGE_MAP: Record<string, ExchangeMeta> = Object.fromEntries(
  KNOWN_EXCHANGES.map(e => [e.id, e]),
);

// ── Mock / Demo Adapter ───────────────────────────────────────────────────────
const ORDERS_KEY = 'sx_exchange_orders';

function loadOrders(): ExchangeOrder[] {
  try { return JSON.parse(localStorage.getItem(ORDERS_KEY) ?? '[]'); }
  catch { return []; }
}

function saveOrders(orders: ExchangeOrder[]) {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders.slice(-500)));
}

export class MockExchangeAdapter implements ExchangeAdapter {
  name:        string;
  mode:        'demo' | 'testnet' | 'live' = 'demo';
  isConnected: boolean = false;

  private _balances: ExchangeBalance[];

  constructor(exchangeId: string) {
    const meta = EXCHANGE_MAP[exchangeId] ?? EXCHANGE_MAP['binance'];
    this.name = `${meta.name} (Demo)`;
    // Balances use current April 2026 BTC price of $84,000
    this._balances = [
      { asset: 'USDT', free: 50000, locked: 0,   usdtValue: 50000  },
      { asset: 'BTC',  free: 0.5,   locked: 0,   usdtValue: 42000  },
      { asset: 'ETH',  free: 10,    locked: 0,   usdtValue: 19500  },
      { asset: 'SOL',  free: 100,   locked: 0,   usdtValue: 13500  },
      { asset: 'BNB',  free: 20,    locked: 0,   usdtValue: 12300  },
      { asset: 'XRP',  free: 5000,  locked: 0,   usdtValue: 11000  },
    ];
  }

  async connect(_config: ApiKeyConfig): Promise<boolean> {
    await new Promise(r => setTimeout(r, 600));
    this.isConnected = true;
    return true;
  }

  disconnect() { this.isConnected = false; }

  async getBalances(): Promise<ExchangeBalance[]> {
    await new Promise(r => setTimeout(r, 80));
    return this._balances.map(b => ({
      ...b, usdtValue: b.usdtValue * (0.99 + Math.random() * 0.02),
    }));
  }

  async placeOrder(req: Omit<ExchangeOrder, 'orderId' | 'filledQty' | 'status' | 'fee' | 'feeCurrency' | 'timestamp'>): Promise<ExchangeOrder> {
    await new Promise(r => setTimeout(r, 40 + Math.random() * 60));
    const fee   = req.quantity * req.price * 0.001;
    const order: ExchangeOrder = {
      ...req,
      orderId:     `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      filledQty:   req.quantity,
      status:      'FILLED',
      fee, feeCurrency: 'USDT',
      timestamp:   Date.now(),
    };
    const orders = loadOrders();
    orders.push(order);
    saveOrders(orders);
    return order;
  }

  async cancelOrder(_orderId: string): Promise<boolean> { return true; }

  async getOrderHistory(symbol?: string, limit = 50): Promise<ExchangeOrder[]> {
    const orders   = loadOrders();
    const filtered = symbol ? orders.filter(o => o.symbol === symbol) : orders;
    return filtered.slice(-limit).reverse();
  }

  async getPositions(): Promise<ExchangePosition[]> { return []; }

  async ping(): Promise<number> {
    const start = Date.now();
    await new Promise(r => setTimeout(r, 12 + Math.random() * 20));
    return Date.now() - start;
  }
}

// Singleton per exchange
const _adapters: Record<string, MockExchangeAdapter> = {};
export function getExchangeAdapter(exchangeId = 'binance'): MockExchangeAdapter {
  if (!_adapters[exchangeId]) {
    _adapters[exchangeId] = new MockExchangeAdapter(exchangeId);
    _adapters[exchangeId].isConnected = true;
  }
  return _adapters[exchangeId];
}

// Permission checker
export function checkTradingPermission(
  permissions: string[],
  mode: string,
): { allowed: boolean; reason: string } {
  if (mode === 'demo')    return { allowed: true,  reason: 'Demo mode — no real funds at risk' };
  if (mode === 'paper')   return { allowed: true,  reason: 'Paper mode — simulated fills, no real orders' };
  if (!permissions.includes('trade')) return { allowed: false, reason: 'API key missing TRADE permission' };
  if (mode === 'testnet') return { allowed: true,  reason: 'Testnet mode — sandbox orders only' };
  if (mode === 'real')    return { allowed: true,  reason: 'Real mode — live funds active' };
  return { allowed: false, reason: 'Unknown mode' };
}
