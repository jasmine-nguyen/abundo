// The on-demand balance refresh calls the bank live and legitimately runs longer than the 15s
// read budget, so refreshAccountBalances passes BALANCE_REFRESH_TIMEOUT_MS (30s) to BOTH apiFetch
// (the request abort) and readJson (the body read). The 15s default would falsely abort a
// mostly-successful live call. These lock both budgets, each fail-on-revert if the arg is dropped.
// fetch + auth mocked; fake timers advance the clock.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { refreshAccountBalances } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

describe('refreshAccountBalances 30s budget', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  // BODY read budget. Fail-on-revert: drop BALANCE_REFRESH_TIMEOUT_MS from its readJson call and the
  // body falls back to the 15s default, so the "still pending at 15s" assertion reddens.
  it('gives the body read the 30s budget, not the 15s default', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),   // headers arrived; the body never settles
    }));

    const pending = refreshAccountBalances();
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    await jest.advanceTimersByTimeAsync(0);        // flush buildHeaders + the header-resolve
    await jest.advanceTimersByTimeAsync(15_000);   // past the DEFAULT budget...
    expect(settled).toBe(false);                   // ...still waiting on the 30s budget

    const rejects = expect(pending).rejects.toThrow('body read timed out');
    await jest.advanceTimersByTimeAsync(15_000);   // now past 30s total → the body timeout fires
    await rejects;
  }, 3000);

  // REQUEST (headers) budget. apiFetch aborts its own AbortController at timeoutMs. Fail-on-revert:
  // drop the arg from apiFetch and the request aborts at 15s, so "still pending at 15s" reddens.
  it('gives the request the 30s budget before aborting, not the 15s default', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        // Reject only when apiFetch's timer aborts the signal — mimics a hung request.
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      }));

    const pending = refreshAccountBalances();
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
