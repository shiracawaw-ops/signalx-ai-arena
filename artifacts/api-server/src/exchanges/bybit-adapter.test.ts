import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BybitAdapter, _resetBybitRulesCache } from './bybit-adapter.js';
import { _resetUsdtPriceCacheForTests } from './exchange-error.js';

beforeEach(() => {
  _resetBybitRulesCache();
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

// Default convert-result-query route that always reports SUCCESS — used by
// tests that aren't specifically exercising the new polling behaviour.
const defaultConvertResultRoute = {
  match: /convert-result-query/,
  handler: () => jsonResponse({ retCode: 0, result: { exchangeStatus: 'SUCCESS' } }),
};

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
      defaultConvertResultRoute,
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
      defaultConvertResultRoute,
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
      defaultConvertResultRoute,
    ]);

    const out = await adapter.sweepDust(creds, ['shib', 'DOGE', 'bonk']);

    expect(out.swept.sort()).toEqual(['BONK', 'DOGE', 'SHIB']);
    expect(out.failed).toEqual([]);
    expect(out.totalReceived).toBeCloseTo(0.5 + 1.25 + 0.1);
    expect(out.receivedAsset).toBe('USDT');
    expect(out.note).toMatch(/coin exchange/i);
  });
});

// ── convert-result-query polling behaviour ────────────────────────────────
// Bybit Coin Exchange settles asynchronously: convert-execute returns 200
// before the USDT lands. The adapter polls /v5/asset/exchange/convert-result-query
// until the venue reports SUCCESS / FAILURE, or until a short timeout elapses.
// These tests cover SUCCESS, mixed swept+pending, all-fail, and explicit FAILURE.
describe('BybitAdapter.sweepDust — convert-result-query polling', () => {
  const creds = { apiKey: 'k', secretKey: 's', testnet: false };

  // BTC sits in both UNIFIED and FUND so each test exercises two slices.
  function unifiedAndFundBalanceRoutes() {
    return [
      {
        match: /wallet-balance\?accountType=UNIFIED/,
        handler: () =>
          jsonResponse({
            retCode: 0,
            result: { list: [{ coin: [{ coin: 'BTC', availableToWithdraw: '0.001', walletBalance: '0.001' }] }] },
          }),
      },
      {
        match: /wallet-balance\?accountType=SPOT/,
        handler: () => jsonResponse({ retCode: 0, result: { list: [{ coin: [] }] } }),
      },
      {
        match: /query-account-coins-balance/,
        handler: () =>
          jsonResponse({
            retCode: 0,
            result: { balance: [{ coin: 'BTC', transferBalance: '0.0005', walletBalance: '0.0005' }] },
          }),
      },
    ];
  }

  it('polls until SUCCESS and credits the settled toAmount', async () => {
    const adapter = new BybitAdapter();
    const pollCounts: Record<string, number> = {};

    installFetchRouter([
      ...unifiedAndFundBalanceRoutes(),
      {
        match: /quote-apply/,
        handler: (_url, init) => {
          const body = JSON.parse(String(init.body ?? '{}'));
          // Tag quoteTxId by accountType so the poll handler can vary behaviour.
          const tag = body.accountType === 'eb_convert_funding' ? 'fund' : 'uta';
          return jsonResponse({ retCode: 0, result: { quoteTxId: `q-${tag}`, toAmount: '60' } });
        },
      },
      { match: /convert-execute/, handler: () => jsonResponse({ retCode: 0, result: {} }) },
      {
        match: /convert-result-query/,
        handler: (url) => {
          const m = /quoteTxId=([^&]+)/.exec(url);
          const id = m?.[1] ?? '';
          pollCounts[id] = (pollCounts[id] ?? 0) + 1;
          // UNIFIED quote needs 3 polls before settling; FUND settles immediately.
          if (id === 'q-uta') {
            const status = pollCounts[id] < 3 ? 'PROCESSING' : 'SUCCESS';
            const toAmount = status === 'SUCCESS' ? '59.5' : undefined;
            return jsonResponse({ retCode: 0, result: { exchangeStatus: status, ...(toAmount ? { toAmount } : {}) } });
          }
          return jsonResponse({ retCode: 0, result: { exchangeStatus: 'SUCCESS', toAmount: '29.8' } });
        },
      },
    ]);

    const r = await adapter.sweepDust(creds, ['BTC']);

    expect(r.swept).toEqual(['BTC']);
    expect(r.failed).toEqual([]);
    expect(r.pending ?? []).toEqual([]);
    expect(r.totalReceived).toBeCloseTo(59.5 + 29.8, 5);
    expect(pollCounts['q-uta']).toBe(3);
    expect(pollCounts['q-fund']).toBe(1);
  }, 15_000);

  it('reports unsettled slices in `pending` (not `failed`) when polling times out', async () => {
    const adapter = new BybitAdapter();

    installFetchRouter([
      ...unifiedAndFundBalanceRoutes(),
      {
        match: /quote-apply/,
        handler: (_url, init) => {
          const body = JSON.parse(String(init.body ?? '{}'));
          const tag = body.accountType === 'eb_convert_funding' ? 'fund' : 'uta';
          return jsonResponse({ retCode: 0, result: { quoteTxId: `q-${tag}`, toAmount: '60' } });
        },
      },
      { match: /convert-execute/, handler: () => jsonResponse({ retCode: 0, result: {} }) },
      {
        match: /convert-result-query/,
        handler: (url) => {
          // UNIFIED settles immediately; FUND stays PENDING forever (until timeout).
          if (/quoteTxId=q-uta/.test(url)) {
            return jsonResponse({ retCode: 0, result: { exchangeStatus: 'SUCCESS', toAmount: '59' } });
          }
          return jsonResponse({ retCode: 0, result: { exchangeStatus: 'PENDING' } });
        },
      },
    ]);

    const r = await adapter.sweepDust(creds, ['BTC']);

    expect(r.swept).toEqual(['BTC']);                  // UNIFIED settled
    expect(r.failed).toEqual([]);                      // not a failure
    expect(r.pending?.length).toBe(1);                 // FUND still settling
    expect(r.pending?.[0]?.asset).toBe('BTC');
    expect(r.pending?.[0]?.quoteTxId).toBe('q-fund');
    expect(r.pending?.[0]?.reason).toMatch(/eb_convert_funding/);
    expect(r.note).toMatch(/still settling/i);
    expect(r.totalReceived).toBeCloseTo(59, 5);
  }, 15_000);

  it('marks asset as failed only when every slice hard-fails (no pending)', async () => {
    const adapter = new BybitAdapter();

    installFetchRouter([
      ...unifiedAndFundBalanceRoutes(),
      {
        match: /quote-apply/,
        handler: () => jsonResponse({ retCode: 10001, retMsg: 'invalid coin', result: {} }),
      },
    ]);

    const r = await adapter.sweepDust(creds, ['BTC']);

    expect(r.swept).toEqual([]);
    expect(r.pending ?? []).toEqual([]);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0]?.asset).toBe('BTC');
    expect(r.failed[0]?.reason).toMatch(/invalid coin/);
  });

  it('treats explicit FAILURE status as a hard failure (not pending)', async () => {
    const adapter = new BybitAdapter();

    installFetchRouter([
      {
        match: /wallet-balance\?accountType=UNIFIED/,
        handler: () =>
          jsonResponse({
            retCode: 0,
            result: { list: [{ coin: [{ coin: 'BTC', availableToWithdraw: '0.001' }] }] },
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
        handler: () => jsonResponse({ retCode: 0, result: { quoteTxId: 'q-x', toAmount: '50' } }),
      },
      { match: /convert-execute/, handler: () => jsonResponse({ retCode: 0, result: {} }) },
      {
        match: /convert-result-query/,
        handler: () => jsonResponse({ retCode: 0, result: { exchangeStatus: 'FAILURE' } }),
      },
    ]);

    const r = await adapter.sweepDust(creds, ['BTC']);

    expect(r.swept).toEqual([]);
    expect(r.pending ?? []).toEqual([]);
    expect(r.failed.length).toBe(1);
    expect(r.failed[0]?.reason).toMatch(/FAILURE/);
  });
});
