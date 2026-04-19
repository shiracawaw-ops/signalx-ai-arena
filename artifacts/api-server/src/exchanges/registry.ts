// ─── Exchange Registry — factory for all 12 adapters ─────────────────────────
import type { ExchangeAdapter } from './types.js';
import { BinanceAdapter }  from './binance-adapter.js';
import { OkxAdapter }      from './okx-adapter.js';
import { BybitAdapter }    from './bybit-adapter.js';
import { KuCoinAdapter }   from './kucoin-adapter.js';
import { KrakenAdapter }   from './kraken-adapter.js';
import { CoinbaseAdapter } from './coinbase-adapter.js';
import { BitfinexAdapter } from './bitfinex-adapter.js';
import { MexcAdapter }     from './mexc-adapter.js';
import { GateAdapter }     from './gate-adapter.js';
import { HtxAdapter }      from './htx-adapter.js';
import { BitgetAdapter }   from './bitget-adapter.js';
import { DeribitAdapter }  from './deribit-adapter.js';

const adapters = new Map<string, ExchangeAdapter>([
  ['binance',  new BinanceAdapter()],
  ['okx',      new OkxAdapter()],
  ['bybit',    new BybitAdapter()],
  ['kucoin',   new KuCoinAdapter()],
  ['kraken',   new KrakenAdapter()],
  ['coinbase', new CoinbaseAdapter()],
  ['bitfinex', new BitfinexAdapter()],
  ['mexc',     new MexcAdapter()],
  ['gate',     new GateAdapter()],
  ['htx',      new HtxAdapter()],
  ['bitget',   new BitgetAdapter()],
  ['deribit',  new DeribitAdapter()],
]);

export function getAdapter(exchange: string): ExchangeAdapter | null {
  return adapters.get(exchange.toLowerCase()) ?? null;
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}

export function isSupported(exchange: string): boolean {
  return adapters.has(exchange.toLowerCase());
}
