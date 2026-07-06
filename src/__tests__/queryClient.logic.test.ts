// WHIT-188 — the shared query client's retry policy: a transient 5xx retries up to the
// limit (so a cold-backend read self-heals), but an auth error is terminal (never
// hammer a signed-out / expired session). Pure config, so it runs in the logic project.
import { describe, it, expect } from '@jest/globals';
import { makeQueryClient } from '../queryClient';

const retry = makeQueryClient().getDefaultOptions().queries!.retry as (n: number, e: unknown) => boolean;

describe('query retry policy', () => {
  it('retries a transient 5xx, up to the limit', () => {
    expect(retry(0, new Error('API error: 503'))).toBe(true);
    expect(retry(2, new Error('API error: 503'))).toBe(true);
    expect(retry(3, new Error('API error: 503'))).toBe(false); // stop after 3 tries
  });

  it('never retries an auth error (signed out / 401 / 403)', () => {
    expect(retry(0, new Error('Not signed in'))).toBe(false);
    expect(retry(0, new Error('API error: 401'))).toBe(false);
    expect(retry(0, new Error('API error: 403'))).toBe(false);
  });
});
