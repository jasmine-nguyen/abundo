// WHIT-448 — a SUCCESS (2xx) response whose body never finishes streaming must not hang the read.
// apiFetch clears its abort timer the instant the headers resolve, so every `return readJson(...)`
// success read runs unprotected without its own budget; withBodyTimeout (via readJson) gives it one.
// Without it, the query/writer behind the read never settles and the Save button spins forever — the
// success-path twin of the WHIT-441 failed-body bug. readJson is internal, so we drive it through the
// public readers createCategory (default 15s budget) and generateAiInsights (the 60s paid budget).
// fetch + auth mocked; fake timers advance the clock.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createCategory, generateAiInsights } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

const input = { name: 'Coffee', bucket: 'Lifestyle' as const, icon: 'coffee' };

describe('readJson success body-read timeout', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  // Fail-on-revert: swap any `return readJson(response)` back to a bare `return response.json()` →
  // the read never settles → createCategory never rejects → this hits the explicit 3s test timeout
  // and fails fast/deterministically instead of hanging the runner.
  it('rejects when a 2xx body stalls forever, on the default read budget', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),   // headers arrived; the body never settles
    }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = createCategory(input);
    const rejects = expect(pending).rejects.toThrow('body read timed out');
    await jest.advanceTimersByTimeAsync(0);        // flush buildHeaders + the header-resolve
    await jest.advanceTimersByTimeAsync(15_000);   // trip the body-read timeout
    await rejects;
  }, 3000);

  it('passes a fast 2xx body straight through, unclipped by the timeout', async () => {
    const body = { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee' };
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,   // a fast body must reach the caller unchanged
    }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = createCategory(input);
    await jest.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual(body);   // the read arm won the race, value intact
    // The read settled, so nothing is left to fire — advancing past the budget is a no-op.
    await jest.advanceTimersByTimeAsync(20_000);
  });

  // The paid generation gets AI_GENERATE_TIMEOUT_MS (60s) on its BODY read, not just its headers.
  // Fail-on-revert: drop the AI_GENERATE_TIMEOUT_MS arg from generateAiInsights' readJson and its
  // body falls back to the 15s default, so the "still pending at 15s" assertion reddens.
  it('gives generateAiInsights the longer 60s body budget, not the 15s default', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),   // body never settles
    }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = generateAiInsights();
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    await jest.advanceTimersByTimeAsync(0);        // flush headers
    await jest.advanceTimersByTimeAsync(15_000);   // past the DEFAULT budget...
    expect(settled).toBe(false);                   // ...but the AI read is still waiting (60s budget)

    const rejects = expect(pending).rejects.toThrow('body read timed out');
    await jest.advanceTimersByTimeAsync(45_000);   // now past 60s total → the body timeout fires
    await rejects;
  }, 3000);
});
