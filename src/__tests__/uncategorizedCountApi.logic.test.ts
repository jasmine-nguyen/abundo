// WHIT-501 GAP — the implementer's apiCore test locks fetchUncategorizedCount for a POSITIVE count
// (7) and the not-OK throw. The value the WHOLE feature pivots on, though, is a resolved 0 — the
// only thing that trips "All caught up". This locks that the { count } unwrap passes a real 0
// through as 0 (not mangled to undefined/NaN by a truthy `|| fallback`), so the empty state fires —
// and that a MALFORMED / stringified count throws (so the hook stays undefined and consumers fall
// back to the local count) rather than feeding a bad value into the badge and the `=== 0` gate.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fetchUncategorizedCount } from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>(async () => 'tok') }));

const fetchMock = jest.fn<() => Promise<Response>>();
beforeEach(() => { fetchMock.mockReset(); (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock; });

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response);

describe('fetchUncategorizedCount boundary', () => {
  // A resolved server 0 must come back as the number 0 — this is the "All caught up" trigger.
  it('returns 0 (a real number, not falsy-collapsed) for { count: 0 }', async () => {
    fetchMock.mockResolvedValue(okJson({ count: 0 }));
    const out = await fetchUncategorizedCount();
    expect(out).toBe(0);
    expect(Object.is(out, 0)).toBe(true); // exactly 0, not undefined/NaN/-0
  });

  // A large whole-history tally passes through unchanged (no clamping to a 2-digit badge etc).
  it('passes a large count through unchanged', async () => {
    fetchMock.mockResolvedValue(okJson({ count: 4211 }));
    expect(await fetchUncategorizedCount()).toBe(4211);
  });

  // WHIT-501 hardening: a malformed envelope must THROW, not flow through. A stringified "0" is the
  // dangerous case — it would render as the badge and defeat the `=== 0` "All caught up" gate.
  // Fail-on-revert: remove the type guard in api.ts → these return the bad value instead of throwing.
  it.each([
    ['a stringified count', { count: '0' }],
    ['a missing count', {}],
    ['a null count', { count: null }],
  ])('throws on %s (hook stays undefined → local fallback)', async (_label, body) => {
    fetchMock.mockResolvedValue(okJson(body));
    await expect(fetchUncategorizedCount()).rejects.toThrow(/numeric count/);
  });
});
