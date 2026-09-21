// WHIT-542 — the "make a rule?" suggestions data: the fetch's wire contract and the select guard.
//
// Two risks, the same two as the merchants fetch it mirrors. First, the endpoint walks all history
// on the server, so it needs APPLY_RULES_TIMEOUT_MS, not the 15s default — a big history would
// otherwise abort a request that is succeeding. Second, the screen maps over `suggestions`, so a
// wrapped/changed shape must surface as a thrown error (the query's error state), not crash a
// downstream .map or silently render "no suggestions" over habits the user really has.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fetchFilingSuggestions } from '../api';
import { selectFilingSuggestions } from '../queries';
import type { FilingSuggestions } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>(async () => 'tok') }));

const fetchMock = jest.fn<() => Promise<Response>>();
beforeEach(() => { fetchMock.mockReset(); (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock; });

const BODY: FilingSuggestions = {
  suggestions: [
    {
      merchant: 'Seddons Eatery', rulePattern: 'SEDDONS EATERY', categoryId: 'dining',
      distinctDays: 5, alsoCatches: [{ merchant: 'Seddons Deli', count: 2 }],
    },
  ],
};

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response);

describe('fetchFilingSuggestions', () => {
  it('GETs the suggestions path and returns the payload unchanged', async () => {
    fetchMock.mockResolvedValue(okJson(BODY));
    const out = await fetchFilingSuggestions();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toContain('/transactions/filing-suggestions');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(out).toEqual(BODY);
  });

  it('throws the generic API error on a not-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'x' }) } as Response);
    await expect(fetchFilingSuggestions()).rejects.toThrow('API error: 502');
  });
});

describe('selectFilingSuggestions', () => {
  it('passes a valid payload through unchanged', () => {
    expect(selectFilingSuggestions(BODY)).toBe(BODY);
  });

  it('passes an empty suggestions list through (a valid "no habits yet")', () => {
    const empty: FilingSuggestions = { suggestions: [] };
    expect(selectFilingSuggestions(empty)).toBe(empty);
  });

  // Fail-on-revert: drop the Array.isArray guard and each of these renders "no suggestions" over
  // real data (or crashes the .map) instead of surfacing as the query's error.
  it('throws (fails loud) on a malformed shape — not a silent empty list', () => {
    expect(() => selectFilingSuggestions({ groups: [] } as unknown as FilingSuggestions)).toThrow(/suggestions/);
    expect(() => selectFilingSuggestions(null as unknown as FilingSuggestions)).toThrow(/suggestions/);
    expect(() => selectFilingSuggestions(undefined as unknown as FilingSuggestions)).toThrow(/suggestions/);
    expect(() => selectFilingSuggestions({ suggestions: 'nope' } as unknown as FilingSuggestions)).toThrow(/suggestions/);
  });
});
