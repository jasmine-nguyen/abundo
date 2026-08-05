// WHIT-448 — a SUCCESS (2xx) response whose body never finishes streaming must not hang the read.
// apiFetch clears its abort timer the instant the headers resolve, so every `return readJson(...)`
// success read runs unprotected without its own budget; withBodyTimeout (via readJson) gives it one.
// Without it, the query/writer behind the read never settles and the Save button spins forever — the
// success-path twin of the WHIT-441 failed-body bug. readJson is internal, so we drive it through the
// public readers createCategory (default 15s budget) and generateAiInsights (the 60s paid budget).
// fetch + auth mocked; fake timers advance the clock.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
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

// WHIT-448 (adversarial gaps) — the behavioural suite above drives 2 of 33 success readers. These
// lock the gaps it leaves open: [A4] a static source guard so a single-endpoint revert can't slip
// past a behavioural test, and [A5] a pre-timeout body rejection propagating unmasked.

// [A4] (P0) Static guard — reads the REAL src/api.ts and fails if ANY success reader still ends in a
// bare `return response.json()`. This is the only check that catches a single-endpoint revert; the
// behavioural suite exercises 2 of 33 call sites. The two legitimate json() sites — readJson's own
// `withBodyTimeout(response.json())` and failed()'s `await withBodyTimeout(response.json())` — are
// not a `return response.json(` shape, so the regex leaves them alone.
describe('WHIT-448 source guard: every success body read is timeout-bounded', () => {
  const src = readFileSync(join(__dirname, '..', 'api.ts'), 'utf8');

  it('has no bare `return response.json()` left among the success readers', () => {
    const bare = src.match(/return\s+response\.json\s*\(/g) ?? [];
    expect(bare).toEqual([]);
  });

  // Robust invariant: EVERY raw `response.json(` in the file must be immediately wrapped by
  // `withBodyTimeout(` — the only two legitimate reads (readJson + failed) both are. This also
  // guards the awaited-untimed shape a plain `return response.json()` regex would miss, e.g.
  // `const b = await response.json();` (gap #5): its preceding token is `await `, not `withBodyTimeout(`.
  it('wraps every response.json() call in withBodyTimeout (no un-timed read anywhere)', () => {
    // Strip block + line comments first — the docstrings quote `response.json()` in prose.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const calls = [...code.matchAll(/response\.json\s*\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(2);   // readJson + failed, at least
    for (const m of calls) {
      const before = code.slice(Math.max(0, (m.index ?? 0) - 16), m.index);
      expect(before).toMatch(/withBodyTimeout\(\s*$/);
    }
  });
});

// [A5] (P0) A malformed JSON body rejects json() BEFORE the 15s timer. The caller must see THAT
// error, not "body read timed out" and not a silent hang. Fail-on-revert: if readJson/withBodyTimeout
// ever swallowed or rewrote the read arm's rejection, this would flip to a timeout error / resolve.
describe('WHIT-448 gap: a pre-timeout body rejection propagates unmasked', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('propagates a malformed-JSON 2xx body error to the caller (not the timeout message)', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

    const pending = createCategory(input);
    const rejects = expect(pending).rejects.toThrow('Unexpected token');
    await jest.advanceTimersByTimeAsync(0);   // flush headers; let the json() rejection win the race
    await rejects;
  }, 3000);
});
