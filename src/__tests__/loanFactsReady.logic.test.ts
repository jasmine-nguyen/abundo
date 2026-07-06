// WHIT-191a GAPS (authored by qa) — loanFactsReady boundary the implementer's screen
// test skips: it only covers all-null (Set up) and all-set (Edit). A PARTIALLY-filled
// object must be "not ready" (Set up), and an all-zero object must be "ready" (0 is a
// set value, not "unset"). Pure exported production fn — fails on revert.
import { describe, it, expect } from '@jest/globals';
import { loanFactsReady } from '../context';
import type { LoanFacts } from '../api';

const FULL: LoanFacts = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

describe('loanFactsReady boundaries (Settings "Edit" vs "Set up")', () => {
  it('is true only when all six fields are numbers', () => {
    expect(loanFactsReady(FULL)).toBe(true);
  });

  it('is FALSE when any single field is still null (partially filled → "Set up")', () => {
    const fields: (keyof LoanFacts)[] = ['original', 'homeValue', 'lvr', 'ratePct', 'baseRepay', 'extra'];
    for (const f of fields) {
      const partial = { ...FULL, [f]: null } as LoanFacts;
      expect(loanFactsReady(partial)).toBe(false);
    }
  });

  it('is FALSE for the all-null empty shape', () => {
    expect(loanFactsReady({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null })).toBe(false);
  });

  it('treats 0 as a set value (all-zero facts → "ready")', () => {
    expect(loanFactsReady({ original: 0, homeValue: 0, lvr: 0, ratePct: 0, baseRepay: 0, extra: 0 })).toBe(true);
  });
});
