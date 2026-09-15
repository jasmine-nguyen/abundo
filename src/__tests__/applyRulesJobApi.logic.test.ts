// WHIT-560 — the async apply-rules job endpoints' wire contract.
//
// Properties that carry real risk: the plain sweep must send a byte-identical `{}` (a stray field
// could be misread), the inline variant sends `{rule}`; both throw an ApiError carrying the STATUS
// so the sheet can tell a 409 clash / 400 bad-rule / 502 dispatch-fail apart; and the status GET
// must carry the auth header and throw ApiError(404) for an expired id (distinct from a network
// throw, which the poll loop tolerates). fetch + auth mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { startApplyRulesJob, getApplyRulesJob } from '../api';
import type { ApplyRulesJob } from '../api';
import { ApiError } from '../apiError';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

const JOB: ApplyRulesJob = {
  jobId: 'abc123', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null,
};

function okFetch(body: unknown = JOB, status = 202) {
  const mock = jest.fn(async () => ({ ok: true, status, json: async () => body }));
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

function notOkFetch(status: number) {
  const mock = jest.fn(async () => ({ ok: false, status, json: async () => ({}) }));
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('startApplyRulesJob', () => {
  it('POSTs the jobs path with an empty body for the plain sweep', async () => {
    const fetchMock = okFetch();
    await startApplyRulesJob();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/transactions/uncategorized/apply-rules/jobs');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    // Byte-identical {} — no dryRun, no rule.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('sends {rule} for the inline "file this shop / add rule" variant', async () => {
    const fetchMock = okFetch();
    await startApplyRulesJob({ value: 'COLES', categoryId: 'groceries', budgetExcluded: true });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ rule: { value: 'COLES', categoryId: 'groceries', budgetExcluded: true } });
  });

  it('returns the job on a 202', async () => {
    okFetch(JOB, 202);
    await expect(startApplyRulesJob()).resolves.toEqual(JOB);
  });

  it.each([[400], [409], [502]])('throws an ApiError carrying the status on %s', async (status) => {
    notOkFetch(status);
    await expect(startApplyRulesJob()).rejects.toMatchObject({ status });
    await expect(startApplyRulesJob()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getApplyRulesJob', () => {
  it('GETs the job by id with the auth header', async () => {
    const fetchMock = okFetch(JOB, 200);
    await getApplyRulesJob('abc123');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/transactions/uncategorized/apply-rules/jobs/abc123');
    expect(init.method).toBeUndefined(); // a plain GET
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('url-encodes the job id', async () => {
    const fetchMock = okFetch(JOB, 200);
    await getApplyRulesJob('a/b c');

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/jobs/a%2Fb%20c');
  });

  it('throws ApiError(404) for an expired/unknown id', async () => {
    notOkFetch(404);
    await expect(getApplyRulesJob('gone')).rejects.toMatchObject({ status: 404 });
  });
});
