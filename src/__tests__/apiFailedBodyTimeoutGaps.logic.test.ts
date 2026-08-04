// WHIT-441 item 3 (gaps) — withBodyTimeout, the guard failed() reads the error body under. The
// implementer's apiFailedBodyTimeout suite covers stall-forever / fast-resolve / no-json(). These
// pin two claims the doc-comment makes but that suite doesn't check:
//   (1) a body that REJECTS fast (non-JSON) settles immediately — it does NOT wait out the timeout;
//   (2) the timeout timer is CLEARED on both arms (.finally) — no real-timer leak / lingering handle.
// failed() is internal, so it's driven through the public write createCategory. auth + fetch mocked.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createCategory } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

const input = { name: 'Coffee', bucket: 'Lifestyle' as const, icon: 'coffee' };

describe('withBodyTimeout — fast reject + timer hygiene', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('yields a status-only ApiError the instant the body rejects — without waiting the timeout', async () => {
    // A fast async reject (non-JSON / truncated stream). If withBodyTimeout waited on the timer,
    // this would only settle after 15s; it must settle at t=0. We advance the clock by ZERO past
    // the reject and expect it already resolved — never touching the 15s timeout.
    const fetchMock = jest.fn(async () => ({
      ok: false, status: 400,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const rejects = expect(createCategory(input)).rejects.toMatchObject({ status: 400, serverMessage: null });
    await jest.advanceTimersByTimeAsync(0);   // flush the header resolve + the fast body reject only
    await rejects;
    // The read lost/settled first; the timeout timer must have been cleared by .finally — no leak.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the timeout timer after a fast SUCCESSFUL body — no lingering handle', async () => {
    // Fail-on-revert: drop `.finally(() => clearTimeout(timer))` in withBodyTimeout → the 15s timer
    // stays pending after the body resolves → getTimerCount() is 1, not 0 → this reddens.
    const fetchMock = jest.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: 'nope' }),
    }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const rejects = expect(createCategory(input)).rejects.toMatchObject({ status: 400, serverMessage: 'nope' });
    await jest.advanceTimersByTimeAsync(0);
    await rejects;
    expect(jest.getTimerCount()).toBe(0);     // the body-read timer was cleared, none left pending
  });
});
