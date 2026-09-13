// WHIT-517 — the "file by shop" data: the merchants fetch's wire contract and the select guard.
//
// Two risks. First, the endpoint walks all history + groups on the server, so like the count and
// the apply-rules call it needs APPLY_RULES_TIMEOUT_MS, not the 15s default — a big history would
// otherwise abort a request that is succeeding. Second, the screen maps over `groups`, so a
// wrapped/changed shape must surface as the screen's error card, not crash a downstream .map or
// silently render an empty list over shops the user really has (the selectRules lesson).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fetchUncategorizedMerchants } from '../api';
import { selectUncategorizedMerchants } from '../queries';
import type { UncategorizedMerchants } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>(async () => 'tok') }));

const fetchMock = jest.fn<() => Promise<Response>>();
beforeEach(() => { fetchMock.mockReset(); (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock; });

const BODY: UncategorizedMerchants = {
  unfiled: 42,
  groups: [
    {
      merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20,
      samples: ['COLES 1234 RICHMOND'], firstDate: '2026-06-01', lastDate: '2026-08-01',
      alsoCatches: [{ merchant: 'Coles Express', count: 3 }],
    },
  ],
  ungrouped: { count: 2, samples: ['ONE OFF PURCHASE'] },
};

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response);

describe('fetchUncategorizedMerchants', () => {
  it('GETs the merchants path and returns the payload unchanged', async () => {
    fetchMock.mockResolvedValue(okJson(BODY));
    const out = await fetchUncategorizedMerchants();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toContain('/transactions/uncategorized/merchants');
    // A GET: no method (defaults to GET) or an explicit GET, and never a POST body.
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(out).toEqual(BODY);
  });

  it('throws the generic API error on a not-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'x' }) } as Response);
    await expect(fetchUncategorizedMerchants()).rejects.toThrow('API error: 502');
  });
});

describe('selectUncategorizedMerchants', () => {
  it('passes a valid payload through unchanged', () => {
    expect(selectUncategorizedMerchants(BODY)).toBe(BODY);
  });

  it('passes an empty groups list through (a valid "nothing to file by shop")', () => {
    const empty: UncategorizedMerchants = { unfiled: 0, groups: [], ungrouped: { count: 0, samples: [] } };
    expect(selectUncategorizedMerchants(empty)).toBe(empty);
  });

  // Fail-on-revert: drop the Array.isArray guard and each of these renders "no shops" over real
  // data (or crashes the .map), instead of the screen's error card.
  it('throws (fails loud) on a malformed shape — not a silent empty list', () => {
    expect(() => selectUncategorizedMerchants({ merchants: [] } as unknown as UncategorizedMerchants)).toThrow(/groups/);
    expect(() => selectUncategorizedMerchants(null as unknown as UncategorizedMerchants)).toThrow(/groups/);
    expect(() => selectUncategorizedMerchants(undefined as unknown as UncategorizedMerchants)).toThrow(/groups/);
    expect(() => selectUncategorizedMerchants({ unfiled: 1, groups: 'nope' } as unknown as UncategorizedMerchants)).toThrow(/groups/);
  });
});
