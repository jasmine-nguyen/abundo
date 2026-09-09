// WHIT-508 — the apply-rules endpoint's wire contract.
//
// Two properties carry real risk. First, `dryRun` must ALWAYS be on the wire: the server treats a
// missing key as a preview, so a client that leans on that default turns one dropped field into a
// 300-row write. Second, the call runs long (a whole-history scan + a live BankSync rules read +
// the writes), so the 15s default budget would abort a run that is actually succeeding — it needs
// APPLY_RULES_TIMEOUT_MS on BOTH the request and the body read, like refreshAccountBalances.
// fetch + auth mocked; fake timers advance the clock for the budget cases.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { applyRulesToUncategorized } from '../api';
import type { ApplyRulesResult } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

const FULL_BODY: ApplyRulesResult = {
  dryRun: false,
  rulesConsidered: 4,
  unfiled: 639,
  matched: 512,
  conflicted: 3,
  conflictedSamples: [{ description: 'COLES EXPRESS RICHMOND', categoryIds: ['fuel', 'groceries'] }],
  byCategory: { groceries: 400, fuel: 112 },
  byRule: [{ ruleId: 'r1', value: 'coles', categoryId: 'groceries', count: 400, samples: ['COLES 1234'] }],
  skippedRules: [{ id: 'r9', value: 'uber', reason: 'rule has more than one condition' }],
  filed: [{ id: 't1', category: 'groceries' }],
  vanished: ['t2'],
  failed: ['t3'],
  remaining: 212,
};

function okFetch(body: unknown = FULL_BODY) {
  const mock = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

describe('applyRulesToUncategorized', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('POSTs the apply-rules path with a JSON body', async () => {
    const fetchMock = okFetch();
    await applyRulesToUncategorized(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/transactions/uncategorized/apply-rules');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  // The load-bearing one: an omitted `dryRun` would be read by the server as "preview", so a
  // preview would look fine while a WRITE silently became a no-op — or worse, the reverse if the
  // server default ever changes. Fail-on-revert: send `{}` and both assertions redden.
  it.each([[true], [false]])('always sends dryRun explicitly (%s)', async (dryRun) => {
    const fetchMock = okFetch();
    await applyRulesToUncategorized(dryRun);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ dryRun });
  });

  it('passes the full server report through unchanged', async () => {
    okFetch();
    await expect(applyRulesToUncategorized(false)).resolves.toEqual(FULL_BODY);
  });

  // A zero `remaining` and an empty `filed` are real values the sheet branches on — they must not
  // be collapsed or defaulted away on the way through.
  it('preserves a zero remaining and an empty filed list', async () => {
    okFetch({ ...FULL_BODY, remaining: 0, filed: [], failed: [] });
    const result = await applyRulesToUncategorized(false);

    expect(result.remaining).toBe(0);
    expect(result.filed).toEqual([]);
  });

  it('throws the generic API error on a not-OK response', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch =
      jest.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: 'enrichment service unavailable' }) }));

    await expect(applyRulesToUncategorized(true)).rejects.toThrow('API error: 502');
  });
});

describe('applyRulesToUncategorized 30s budget', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  // BODY read budget. Fail-on-revert: drop APPLY_RULES_TIMEOUT_MS from its readJson call and the
  // body falls back to the 15s default, so "still pending at 15s" reddens.
  it('gives the body read the 30s budget, not the 15s default', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),   // headers arrived; the body never settles
    }));

    const pending = applyRulesToUncategorized(false);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    await jest.advanceTimersByTimeAsync(0);        // flush buildHeaders + the header-resolve
    await jest.advanceTimersByTimeAsync(15_000);   // past the DEFAULT budget...
    expect(settled).toBe(false);                   // ...still waiting on the 30s budget

    const rejects = expect(pending).rejects.toThrow('body read timed out');
    await jest.advanceTimersByTimeAsync(15_000);   // now past 30s total → the body timeout fires
    await rejects;
  }, 3000);

  // REQUEST (headers) budget. Fail-on-revert: drop the arg from apiFetch and the request aborts at
  // 15s, mid-write, leaving the user with an unknown outcome on a run that was going to succeed.
  it('gives the request the 30s budget before aborting, not the 15s default', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      }));

    const pending = applyRulesToUncategorized(false);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    await jest.advanceTimersByTimeAsync(0);        // flush buildHeaders
    await jest.advanceTimersByTimeAsync(15_000);   // past the DEFAULT budget...
    expect(settled).toBe(false);                   // ...the request is still in flight (30s budget)

    const rejects = expect(pending).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(15_000);   // now past 30s → apiFetch aborts the request
    await rejects;
  }, 3000);
});
