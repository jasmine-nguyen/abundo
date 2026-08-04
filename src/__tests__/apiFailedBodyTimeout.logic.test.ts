// WHIT-441 — a not-OK response whose body never finishes streaming must not hang `failed()`.
// apiFetch clears its abort timer the instant the headers resolve, so the error-body read in
// failed() runs unprotected; withBodyTimeout gives it its own budget. Without it, the failed-save
// writer never settles and the Save button spins forever. `failed()` is internal, so we drive it
// through the public write createCategory. fetch + auth mocked; fake timers advance the clock.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createCategory, ApiError } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

const input = { name: 'Coffee', bucket: 'Lifestyle' as const, icon: 'coffee' };

describe('failed() body-read timeout', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  // Fail-on-revert: replace `withBodyTimeout(response.json(), …)` with a plain `await
  // response.json()` → the read never settles → createCategory never rejects → this hits the
  // explicit 3s test timeout and fails (fast, deterministic) instead of hanging the runner.
  it('rejects with a status-only ApiError when the error body stalls forever', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: () => new Promise(() => {}),   // headers arrived; the body never settles
    }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = createCategory(input);
    const rejects = expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      serverMessage: null,
    });
    await jest.advanceTimersByTimeAsync(0);        // flush buildHeaders + the header-resolve
    await jest.advanceTimersByTimeAsync(15_000);   // trip the body-read timeout
    await rejects;
  }, 3000);

  it('still surfaces the server reason when the body resolves before the timeout', async () => {
    const reason = 'a category can have at most 50 sub-categories';
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: reason }),   // a fast body must not be clipped by the timeout
    }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = createCategory(input);
    const rejects = expect(pending).rejects.toMatchObject({ status: 400, serverMessage: reason });
    await jest.advanceTimersByTimeAsync(0);
    await rejects;
    // The read settled, so nothing is left to fire — advancing past the budget is a no-op.
    await jest.advanceTimersByTimeAsync(20_000);
  });

  it('keeps failed() total when the response has no json() at all', async () => {
    // An HTML gateway 502 with no json method: response.json() throws synchronously inside
    // withBodyTimeout; failed() must still RETURN ApiError(502, null), never throw.
    const fetchMock = jest.fn(async () => ({ ok: false, status: 502 }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = createCategory(input);
    const rejects = expect(pending).rejects.toMatchObject({ status: 502, serverMessage: null });
    await jest.advanceTimersByTimeAsync(0);
    await rejects;
  });
});
