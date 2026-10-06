// Card 609 — the Ask Abundo wire contract: starting a chat job, checking it, and the drill-in's
// date-range request. fetch + auth mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fetchCategoryTransactions, getAiChatJob, startAiChat } from '../api';
import { ApiError } from '../apiError';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule('test-token'));

function mockFetch(body: unknown, status = 200) {
  const mock = jest.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

function call(mock: ReturnType<typeof mockFetch>) {
  return mock.mock.calls[0] as unknown as [string, RequestInit];
}

beforeEach(() => { jest.clearAllMocks(); });

describe('startAiChat', () => {
  it('POSTs the conversation to /ai/chat and returns the job', async () => {
    const fetchMock = mockFetch({ jobId: 'j1', status: 'running' });
    const turns = [{ role: 'user' as const, text: 'Average eating out?' }];

    const job = await startAiChat(turns);

    const [url, init] = call(fetchMock);
    expect(url).toMatch(/\/ai\/chat$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ messages: turns });
    expect(job).toEqual({ jobId: 'j1', status: 'running' });
  });

  it('throws an ApiError carrying the status', async () => {
    mockFetch({ error: 'bad' }, 400);
    await expect(startAiChat([{ role: 'user', text: 'x' }])).rejects.toEqual(new ApiError(400, null));
  });
});

describe('getAiChatJob', () => {
  it('GETs the job by its encoded id', async () => {
    const fetchMock = mockFetch({ jobId: 'a/b', status: 'running', toolStatus: 'Checking your budgets…' });
    const job = await getAiChatJob('a/b');
    expect(call(fetchMock)[0]).toMatch(/\/ai\/chat\/jobs\/a%2Fb$/);
    expect(job.toolStatus).toBe('Checking your budgets…');
  });

  it('a gone job is a 404 ApiError', async () => {
    mockFetch({}, 404);
    await expect(getAiChatJob('old')).rejects.toMatchObject({ status: 404 });
  });
});

describe('fetchCategoryTransactions — date range (the chat deep link)', () => {
  it('sends from/to instead of the cycle', async () => {
    const fetchMock = mockFetch([]);
    await fetchCategoryTransactions('eatingout', 0, { from: '2026-06-12', to: '2026-09-11' });
    expect(call(fetchMock)[0]).toMatch(/\/categories\/eatingout\/transactions\?from=2026-06-12&to=2026-09-11$/);
  });

  it('without a range the cycle request is unchanged', async () => {
    const fetchMock = mockFetch([]);
    await fetchCategoryTransactions('eatingout', 1);
    expect(call(fetchMock)[0]).toMatch(/\/categories\/eatingout\/transactions\?cycle=1$/);
  });
});

describe('fetchCategoryTransactions — QA edges (card 609)', () => {
  // [A24] the server 400s a request carrying BOTH cycle and from/to, so a range must replace
  // the cycle even when the caller still passes cycle 1.
  it('a range with cycle 1 still sends only from/to', async () => {
    const fetchMock = mockFetch([]);
    await fetchCategoryTransactions('eatingout', 1, { from: '2026-06-12', to: '2026-09-11' });
    const url = call(fetchMock)[0];
    expect(url).toMatch(/\?from=2026-06-12&to=2026-09-11$/);
    expect(url).not.toMatch(/cycle=/);
  });

  // [A24] the uncategorized bucket id is URL-encoded in the path, range in the query.
  it('encodes the category id in the path', async () => {
    const fetchMock = mockFetch([]);
    await fetchCategoryTransactions('a/b', 0, { from: '2026-06-12', to: '2026-09-11' });
    expect(call(fetchMock)[0]).toMatch(/\/categories\/a%2Fb\/transactions\?from=/);
  });
});
