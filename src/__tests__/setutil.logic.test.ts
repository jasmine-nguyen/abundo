// WHIT-796 — toggleIn is the one "toggle an id in a Set" helper (category tree folding,
// Transactions multi-select, Insights expanded rows). It adds a missing id, removes a present
// one, and never mutates the Set it was given (React state updates rely on a new Set).
import { it, expect } from '@jest/globals';
import { toggleIn } from '../setutil';

it.each([
  ['adds a missing id', ['a'], 'b', ['a', 'b']],
  ['removes a present id', ['a', 'b'], 'a', ['b']],
  ['adds to an empty set', [], 'x', ['x']],
])('%s and leaves the input Set unchanged', (_label, start, id, expected) => {
  const prev = new Set<string>(start);
  const next = toggleIn(prev, id);
  expect(next).not.toBe(prev);
  expect([...next].sort()).toEqual(expected);
  expect([...prev].sort()).toEqual(start);
});
