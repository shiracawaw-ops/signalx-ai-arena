import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BybitAdapter } from './bybit-adapter.js';
import { _resetUsdtPriceCacheForTests } from './exchange-error.js';

beforeEach(() => {
  _resetUsdtPriceCacheForTests();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function installFetchRouter(routes: Array<{ match: RegExp; handler: Handler }>) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      for (const r of routes) {
        if (r.match.test(url)) return r.handler(url, init ?? {});
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
}

describe('BybitAdapter.sweepDust', () => {
  const creds = { apiKey: 'k', secretKey: 's', testnet: false };

  it('short-circuits on testnet without hitting the network', async () => {
    const adapter = new BybitAdapter();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await adapter.sweepDust(
      { ...creds, testnet: true },
      ['shib', 'doge'],
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.exchange).toBe('bybit');
    expect(out.swept).toEqual([]);
    expect(out.failed).toEqual([
      { asset: 'SHIB', reason: 'TESTNET_UNSUPPORTED' },
      { asset: 'DOGE', reason: 'TESTNET_UNSUPPORTED' },
    ]);
    expect(out.note).toMatch(/testnet/i);
  });

  it('skips USDT with an explanatory reason and never calls quote-apply for it', async () => {
    const adapter = new BybitAdapter();
    const quoteApplyCalls: string[] = [];
    installFetchRouter([
      { match: /wallet-balance/, handler: () => jsonResponse({ retCode: 0, result: { list: [{ coin: [] }] } }) },
      { match: /query-account-coins-balance/, handler: () => jsonResponse({ retCode: 0, result: { balance: [] } }) },
      {
        match: /quote-apply/,
        handler: (url) => {
          quoteApplyCalls.push(url);
          return jsonResponse({ retCode: 0, result: { quoteTxId: 'should-not-happen', toAmount: '1' } });
        },
      },
      { match: /convert-execute/, handler: () => jsonResponse({ retCode: 0, result: {} }) },
    ]);

    const out = await adapter.sweepDust(creds, ['USDT']);

    expect(quoteApplyCalls).toEqual([]);
    expect(out.swept).toEqual([]);
    expect(out.failed).toEqual([
      { asset: 'USDT', reason: expect.stringMatching(/already usdt/i) },
    ]);
  });

  it('falls back to SPOT when UNIFIED returns a "wallet not exist" retMsg', async () => {
    const adapter = new BybitAdapter();
    const quoteApplyBodies: string[] = [];

    installFetchRouter([
      {
        match: /wallet-balance\?accountType=UNIFIED/,
        handler: () => jsonResponse({ retCode: 10001, retMsg: 'wallet not exist', result: {} }),
      },
      {
        match: /wallet-balance\?accountType=SPOT/,
        handler: () =>
          jsonResponse({
            retCode: 0,
            result: { list: [{ coin: [{ coin: 'SHIB', availableToWithdraw: '1000000' }] }] },
          }),
      },
      {
        match: /query-account-coins-balance/,
        handler: () => jsonResponse({ retCode: 0, result: { balance: [] } }),
      },
      {
        match: /quote-apply/,
        handler: (_url, init) => {
          quoteApplyBodies.push(String(init.body ?? ''));
          return jsonResponse({
            retCode: 0,
            result: { quoteTxId: 'tx-shib-1', toAmount: '0.42' },
          });
        },
      },
      {
        match: /convert-execute/,
        handler: () => jsonResponse({ retCode: 0, result: { exchangeStatus: 'success' } }),
      },
    ]);

    const out = await adapter.sweepDust(creds, ['SHIB']);

    expect(quoteApplyBodies).toHaveLength(1);
    const body = JSON.parse(quoteApplyBodies[0]);
    expect(body.fromCoin).toBe('SHIB');
    expect(body.accountType).toBe('eb_convert_spot');
    expect(body.requestAmount).toBe('1000000');
    expect(out.swept).toEqual(['SHIB']);
    expect(out.failed).toEqual([]);
    expect(out.totalReceived).toBeCloseTo(0.42);
    expect(out.receivedAsset).toBe('USDT');
  });

  it('surfaces the venue retMsg when quote-apply returns retCode != 0', async () => {
    const adapter = new BybitAdapter();
    installFetchRouter([
      {
        match: /wallet-balance\?accountType=UNIFIED/,
        handler: () =>
          jsonResponse({
            retCode: 0,
            result: { list: [{ coin: [{ coin: 'SHIB', availableToWithdraw: '1000000' }] }] },
          }),
      },
      {
        match: /wallet-balance\?accountType=SPOT/,
        handler: () => jsonResponse({ retCode: 0, result: { list: [{ coin: [] }] } }),
      },
      {
        match: /query-account-coins-balance/,
        handler: () => jsonResponse({ retCode: 0, result: { balance: [] } }),
      },
      {
        match: /quote-apply/,
        handler: () =>
          jsonResponse({ retCode: 181017, retMsg: 'Convert amount is below the minimum', result: {} }),
      },
    ]);

    const out = await adapter.sweepDust(creds, ['SHIB']);

    expect(out.swept).toEqual([]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].asset).toBe('SHIB');
    expect(out.failed[0].reason).toMatch(/181017/);
    expect(out.failed[0].reason).toMatch(/below the minimum/i);
  });

  it('happy-path: sums totalReceived across multiple assets', async () => {
    const adapter = new BybitAdapter();
    const quoteAmounts: Record<string, number> = { SHIB: 0.5, DOGE: 1.25, BONK: 0.1 };

    installFetchRouter([
      {
        match: /wallet-balance\?accountType=UNIFIED/,
        handler: () =>
          jsonResponse({
            retCode: 0,
            result: {
              list: [{
                coin: [
                  { coin: 'SHIB', availableToWithdraw: '1000000' },
                  { coin: 'DOGE', availableToWithdraw: '12.5' },
                  { coin: 'BONK', availableToWithdraw: '7777' },
                ],
              }],
            },
          }),
      },
      {
        match: /wallet-balance\?accountType=SPOT/,
        handler: () => jsonResponse({ retCode: 0, result: { list: [{ coin: [] }] } }),
      },
      {
        match: /query-account-coins-balance/,
        handler: () => jsonResponse({ retCode: 0, result: { balance: [] } }),
      },
      {
        match: /quote-apply/,
        handler: (_url, init) => {
          const body = JSON.parse(String(init.body ?? '{}'));
          const amt = quoteAmounts[body.fromCoin] ?? 0;
          return jsonResponse({
            retCode: 0,
            result: { quoteTxId: `tx-${body.fromCoin}`, toAmount: String(amt) },
          });
        },
      },
      {
        match: /convert-execute/,
        handler: () => jsonResponse({ retCode: 0, result: { exchangeStatus: 'success' } }),
      },
    ]);

    const out = await adapter.sweepDust(creds, ['shib', 'DOGE', 'bonk']);

    expect(out.swept.sort()).toEqual(['BONK', 'DOGE', 'SHIB']);
    expect(out.failed).toEqual([]);
    expect(out.totalReceived).toBeCloseTo(0.5 + 1.25 + 0.1);
    expect(out.receivedAsset).toBe('USDT');
    expect(out.note).toMatch(/coin exchange/i);
  });
});
