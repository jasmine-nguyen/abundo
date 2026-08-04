// WHIT-448 (adversarial gaps) — the implementer's behavioural suite drives only createCategory +
// generateAiInsights (2 of 33 success readers). These lock the gaps that suite leaves open:
//   [A4] source guard: no bare `return response.json()` may survive — a single-site revert of any of
//        the other 31 endpoints back to an un-timed-out read is invisible to a behavioural test.
//   [A5] a malformed-JSON 2xx body whose json() rejects BEFORE the timer must propagate that JSON
//        error to the caller, not be masked by / swallowed into the timeout machinery.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createCategory } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

const input = { name: 'Coffee', bucket: 'Lifestyle' as const, icon: 'coffee' };

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
