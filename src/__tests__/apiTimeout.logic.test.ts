// WHIT-198 (folded tech-debt) — the shared api fetch layer now aborts a request after
// REQUEST_TIMEOUT_MS so a dead socket becomes a failed read (→ the screen's "—" + Retry)
// instead of hanging forever. apiFetch is internal, so we drive it through a public reader
// (fetchCategories). fetch + auth mocked; fake timers advance the clock deterministically.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { fetchCategories, generateAiInsights } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

describe('request timeout', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('aborts a hung request after 15s and rejects the read', async () => {
    // A fetch that never settles on its own — it only rejects if its abort signal fires.
    const fetchMock = jest.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = fetchCategories();
    const rejects = expect(pending).rejects.toThrow(); // attach the catch before advancing time
    await jest.advanceTimersByTimeAsync(15_000); // trip the timeout
    await rejects;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(true);
  });

  it('does NOT abort a request that resolves before the timeout', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => [{ id: 'a' }] }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const out = await fetchCategories();
    expect(out).toEqual([{ id: 'a' }]);
    // the timer must have been cleared on resolve — advancing past 15s aborts nothing.
    await jest.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // WHIT-198 GAP (authored by qa) — the existing "resolves before timeout" case only asserts
  // fetch was called once; it does NOT prove the timer is cleared when the request settles with
  // an ERROR. A 500 resolves the fetch (ok:false) and then fetchCategories throws — the finally
  // must still clearTimeout so the controller is never aborted late. Capture the injected signal
  // and prove it stays un-aborted even after we advance well past the 15s deadline.
  // Fail-on-revert: drop `clearTimeout(timer)` in api.ts#apiFetch → the timer fires at 15s and
  // aborts the already-settled controller → signal.aborted flips true → this fails.
  it('a non-timeout error (500) clears the timer — no leaked late abort of a settled request', async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    await expect(fetchCategories()).rejects.toThrow('API error: 500');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false); // not aborted the instant the 500 came back
    await jest.advanceTimersByTimeAsync(20_000); // a leaked timer would abort here
    expect(init.signal?.aborted).toBe(false); // still false → clearTimeout ran in finally
  });

  // WHIT-198 review — the blanket 15s read budget must NOT cap the paid AI generation
  // ("Analyse my spending"), which commonly runs 10–25s. generateAiInsights passes a larger
  // per-call budget (60s), so its request survives past 15s and only aborts near 60s.
  // Fail-on-revert: drop the AI_GENERATE_TIMEOUT_MS arg on generateAiInsights → it inherits the
  // 15s default → the signal aborts at 15s → the "not aborted at 15s" assertion fails.
  it('the paid AI generation gets the longer budget — not aborted at 15s, aborted by 60s', async () => {
    const fetchMock = jest.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = generateAiInsights();
    const rejects = expect(pending).rejects.toThrow(); // attach the catch before advancing time
    await jest.advanceTimersByTimeAsync(0); // flush the awaited buildHeaders → fetch is now called
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    await jest.advanceTimersByTimeAsync(15_000);
    expect(init.signal?.aborted).toBe(false); // survives the 15s read budget

    await jest.advanceTimersByTimeAsync(45_000); // now past the 60s AI budget
    expect(init.signal?.aborted).toBe(true);
    await rejects;
  });
});
