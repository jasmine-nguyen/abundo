// WHIT-198 — the shared api fetch layer aborts a request after REQUEST_TIMEOUT_MS so a dead
// socket becomes a failed read (→ the screen's "—" + Retry) instead of hanging forever.
// WHIT-441/448 — request() clears its abort timer the instant the headers resolve, so the body
// read (success and failure) gets its own budget via withBodyTimeout. request() and failed() are
// internal, so we drive them through public readers. fetch + auth mocked; fake timers advance the clock.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { fetchCategories, createCategory } from '../api';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule('test-token'));

const input = { name: 'Coffee', bucket: 'Lifestyle' as const, icon: 'coffee' };

function stalledBody(ok: boolean, status: number) {
  return jest.fn(async () => ({
    ok,
    status,
    json: () => new Promise(() => {}),   // headers arrived; the body never settles
  }));
}

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

  // Fail-on-revert (both below): swap the timed body read for a bare `response.json()` → the read
  // never settles → createCategory never rejects → this hits the explicit 3s test timeout.
  it('rejects when a 2xx body stalls forever, on the default read budget', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = stalledBody(true, 200);

    const pending = createCategory(input);
    const rejects = expect(pending).rejects.toThrow('body read timed out');
    await jest.advanceTimersByTimeAsync(0);        // flush the awaited auth token + the header-resolve
    await jest.advanceTimersByTimeAsync(15_000);   // trip the body-read timeout
    await rejects;
  }, 3000);

  it('rejects with a status-only ApiError when the error body stalls forever', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = stalledBody(false, 400);

    const pending = createCategory(input);
    const rejects = expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      serverMessage: null,
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(15_000);
    await rejects;
  }, 3000);
});
