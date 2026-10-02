// WHIT-697 — the "wait until one query has loaded" step lives once, as loaded() in
// support/renderWithQueries; no suite keeps a written-out copy of it.
import { describe, it, expect } from '@jest/globals';
import path from 'path';
import { findOffenders } from './support/sourceScan';

const allowed = new Set(['support/renderWithQueries.tsx', path.basename(__filename)]);

const needles = [
  ['wait', 'For('].join(''),
  ['queryClient', '.getQueryState('].join(''),
  [".toBe('success'", ')'].join(''),
];

describe('shared "one query has loaded" wait', () => {
  it('no suite keeps its own written-out copy of the wait — they all use loaded()', () => {
    expect(findOffenders((line) => needles.every((needle) => line.includes(needle)), allowed)).toEqual([]);
  });
});
