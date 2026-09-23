// WHIT-576 — QA gap tests for fetchTransactionsSearch (src/api.ts): [A6] the search box text
// reaches the server intact (every reserved URL character encoded), and [A7] the whole-history
// search gets the long 30s timeout, not the 15s default. fetch is mocked; no network.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { fetchTransactionsSearch } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));
import { getAuthToken } from '../auth';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';
let fetchMock: jest.Mock;

beforeEach(() => {
  mockGetAuthToken.mockReset().mockResolvedValue('test-token');
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => { jest.useRealTimers(); });

it('[A6] encodes & = # + % ? / space and non-ASCII so the server sees exactly what was typed', async () => {
  fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ transactions: [], truncated: false }) }));
  const typed = 'B&W 50%+off #1 a=b?/ café';

  await fetchTransactionsSearch('uncategorized', typed);

  const [url, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
  expect(url.startsWith(`${API}/transactions/search?`)).toBe(true);
  const params = new URL(url).searchParams;
  expect(params.get('q')).toBe(typed); // a raw & or # would cut q short; a raw + would become a space
  expect(params.get('tab')).toBe('uncategorized');
  expect([...params.keys()].sort()).toEqual(['q', 'tab']);
  expect(opts.headers.Authorization).toBe('Bearer test-token');
});

it('[A7] a slow whole-history search is not aborted at 15s (it gets the 30s budget)', async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | undefined;
  fetchMock.mockImplementation((_url: unknown, init: unknown) => {
    signal = (init as { signal: AbortSignal }).signal;
    return new Promise(() => {}); // the server is still scanning
  });

  const pending = fetchTransactionsSearch('all', 'steven');
  pending.catch(() => {});
  await jest.advanceTimersByTimeAsync(0);
  expect(signal).toBeDefined();
  await jest.advanceTimersByTimeAsync(20_000);
  expect(signal!.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(10_001);
  expect(signal!.aborted).toBe(true);
});
