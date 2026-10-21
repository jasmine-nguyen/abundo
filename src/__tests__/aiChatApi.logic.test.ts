// Card 609 — the Ask Abundo wire contract: checking a chat job, and the drill-in's date-range
// request. fetch + auth mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { stubFetch } from './support/fetchStub';
import { fetchCategoryTransactions, getAiChatJob } from '../api';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule('test-token'));

function mockFetch(body: unknown, status = 200) {
  return stubFetch(async () => ({ ok: status < 400, status, json: async () => body }));
}

function call(mock: ReturnType<typeof mockFetch>) {
  return mock.mock.calls[0] as unknown as [string, RequestInit];
}

beforeEach(() => { jest.clearAllMocks(); });

describe('getAiChatJob', () => {
  it('GETs the job by its encoded id', async () => {
    const fetchMock = mockFetch({ jobId: 'a/b', status: 'running', toolStatus: 'Checking your budgets…' });
    const job = await getAiChatJob('a/b');
    expect(call(fetchMock)[0]).toMatch(/\/ai\/chat\/jobs\/a%2Fb$/);
    expect(job.toolStatus).toBe('Checking your budgets…');
  });
});

describe('fetchCategoryTransactions — date range (the chat deep link)', () => {
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
});
