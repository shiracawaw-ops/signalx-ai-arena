// ─── Exchange Compliance Engine + Smart Symbol Unification (Systems #2 & #3) ──
// Decides whether a given asset is tradable on a given exchange and, if so,
// what the canonical exchange-side symbol should be.
//
// The frontend ASSETS list mixes Crypto + Stocks + Metals + Forex, but real
// crypto exchanges only list crypto pairs. This module is the single source
// of truth for "can bot X trade on exchange Y" — used by the rejection
// shield, autopilot, and the pipeline UI.

import { ASSET_MAP, type AssetCategory } from './storage';

export type ExchangeId =
  | 'binance' | 'bybit'   | 'okx'      | 'kucoin'   | 'mexc'
  | 'gate'    | 'bitget'  | 'kraken'   | 'coinbase' | 'htx'
  | 'bitfinex'| 'deribit';

// Which asset categories does each exchange support natively?
// All listed exchanges are crypto-only — stocks/metals/forex are filtered out.
const EX_CATEGORIES: Record<ExchangeId, AssetCategory[]> = {
  binance:  ['Crypto'], bybit:   ['Crypto'], okx:      ['Crypto'],
  kucoin:   ['Crypto'], mexc:    ['Crypto'], gate:     ['Crypto'],
  bitget:   ['Crypto'], kraken:  ['Crypto'], coinbase: ['Crypto'],
  htx:      ['Crypto'], bitfinex:['Crypto'], deribit:  ['Crypto'],
};

// Per-exchange unsupported tokens (small denylist for known delistings).
// Adapters will reject unknown symbols via `getSymbolRules` regardless,
// but this keeps the UI honest for assets we already know don't list.
const EX_DENYLIST: Partial<Record<ExchangeId, string[]>> = {
  coinbase: ['BNB'],   // Binance Coin not on Coinbase
  kraken:   ['BNB'],
  deribit:  ['ADA', 'DOGE', 'XRP', 'LINK', 'LTC', 'DOT', 'ATOM', 'AVAX'], // mostly BTC/ETH options
};

// Quote conventions per exchange.
type QuoteFormat = (base: string, quote: string) => string;
const FORMATS: Record<ExchangeId, { quote: string; fmt: QuoteFormat }> = {
  binance:  { quote: 'USDT', fmt: (b, q) => `${b}${q}`        },
  bybit:    { quote: 'USDT', fmt: (b, q) => `${b}${q}`        },
  okx:      { quote: 'USDT', fmt: (b, q) => `${b}-${q}`       },
  kucoin:   { quote: 'USDT', fmt: (b, q) => `${b}-${q}`       },
  mexc:     { quote: 'USDT', fmt: (b, q) => `${b}${q}`        },
  gate:     { quote: 'USDT', fmt: (b, q) => `${b}_${q}`       },
  bitget:   { quote: 'USDT', fmt: (b, q) => `${b}${q}`        },
  kraken:   { quote: 'USD',  fmt: (b, q) => `${b}/${q}`       },
  coinbase: { quote: 'USD',  fmt: (b, q) => `${b}-${q}`       },
  htx:      { quote: 'USDT', fmt: (b, q) => `${b}${q}`.toLowerCase() },
  bitfinex: { quote: 'USD',  fmt: (b, q) => `t${b}${q}`       },
  deribit:  { quote: 'USDC', fmt: (b, q) => `${b}_${q}-PERPETUAL` },
};

// Stable-coin substitutions per exchange (some don't list USDT, only USDC/USD).
const QUOTE_OVERRIDE: Partial<Record<ExchangeId, string>> = {
  coinbase: 'USD', kraken: 'USD', bitfinex: 'USD',
};

export interface ComplianceVerdict {
  ok:               boolean;
  base:             string;
  quote:            string;
  exchangeSymbol:   string;
  category:         AssetCategory;
  reason?:          string;          // when ok=false
  recommendedQuote: string;
}

/**
 * Resolve an arena symbol (e.g. "BTC", "AAPL", "EURUSD") to its tradable form
 * on a given exchange — or refuse it with a clear reason.
 */
export function resolveCompliance(arenaSymbol: string, exchange: ExchangeId): ComplianceVerdict {
  const meta     = ASSET_MAP[arenaSymbol];
  const category: AssetCategory = meta?.category ?? 'Crypto';
  const fmt      = FORMATS[exchange];
  const recommendedQuote = QUOTE_OVERRIDE[exchange] ?? fmt?.quote ?? 'USDT';

  if (!meta) {
    return {
      ok: false, base: arenaSymbol, quote: recommendedQuote,
      exchangeSymbol: arenaSymbol, category,
      reason: `Asset "${arenaSymbol}" is not in the catalog.`, recommendedQuote,
    };
  }

  const cats = EX_CATEGORIES[exchange];
  if (!cats || !cats.includes(category)) {
    return {
      ok: false, base: meta.symbol, quote: recommendedQuote,
      exchangeSymbol: meta.symbol, category,
      reason: `${exchange.toUpperCase()} does not list ${category} assets — try a Crypto symbol.`,
      recommendedQuote,
    };
  }

  if (EX_DENYLIST[exchange]?.includes(meta.symbol)) {
    return {
      ok: false, base: meta.symbol, quote: recommendedQuote,
      exchangeSymbol: meta.symbol, category,
      reason: `${meta.symbol} is not listed on ${exchange.toUpperCase()}.`,
      recommendedQuote,
    };
  }

  const exchangeSymbol = fmt.fmt(meta.symbol, recommendedQuote);
  return {
    ok: true, base: meta.symbol, quote: recommendedQuote,
    exchangeSymbol, category, recommendedQuote,
  };
}

/** Convenience: just give me the exchange-side symbol (or null if non-tradable). */
export function toExchangeSymbol(arenaSymbol: string, exchange: ExchangeId): string | null {
  const v = resolveCompliance(arenaSymbol, exchange);
  return v.ok ? v.exchangeSymbol : null;
}

/** Build a matrix of {exchange: tradableCount} for the diagnostics panel. */
export function complianceMatrix(symbols: string[]): Record<ExchangeId, { ok: number; blocked: number; symbols: string[] }> {
  const exchanges: ExchangeId[] = Object.keys(EX_CATEGORIES) as ExchangeId[];
  const out = {} as Record<ExchangeId, { ok: number; blocked: number; symbols: string[] }>;
  for (const ex of exchanges) {
    const okList: string[] = [];
    let blocked = 0;
    for (const s of symbols) {
      if (resolveCompliance(s, ex).ok) okList.push(s); else blocked++;
    }
    out[ex] = { ok: okList.length, blocked, symbols: okList };
  }
  return out;
}

export const SUPPORTED_EXCHANGES: ExchangeId[] = Object.keys(EX_CATEGORIES) as ExchangeId[];
