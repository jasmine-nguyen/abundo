// SpendingDonut fade/dim behaviour with reduce-motion ON (the springs settle synchronously via
// setValue, so no clock to advance). Merged from the DimEdges/Fold/Reenter/Selection donut suites
// (WHIT-451) — every one mocked useReduceMotion → true, so they share this one file-level mock.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { opacityOf, sl, DIM_CATEGORY } from './support/donut';

const TWO: DonutSlice[] = [
  { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
  { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
];
const ONLY_G: DonutSlice[] = [{ id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 }];

describe('SpendingDonut — selected tail slice folds into __other__ (gap)', () => {
  // [A5] Tapped 'coffee' is individually painted, then a data change pushes it into the tail so it
  // folds into '__other__' — its id LEAVES painted. activeId flips to null → ring un-dims. 'a'
  // existed before, was dimmed, and survives; it must return to 1.
  // FAIL-ON-REVERT: with selectedId (not activeId) in the effect deps/target, the effect never
  // re-runs on this data change (selectedId is still 'coffee'), so 'a' stays stuck dimmed.
  it('[A5] folding the selected slice into __other__ un-dims the ring (coffee → __other__)', () => {
    const before: DonutSlice[] = [
      sl('a', 100), sl('b', 60), sl('c', 50), { id: 'coffee', name: 'Coffee', color: '#E8A87C', value: 40 }, sl('e', 20),
    ]; // 5 painted, coffee individual
    const { rerender } = render(<SpendingDonut slices={before} />);

    fireEvent.press(screen.getByTestId('donut-slice-coffee'));
    expect(opacityOf('a')).toBeCloseTo(DIM_CATEGORY); // a dims while Coffee is popped

    const after: DonutSlice[] = [
      sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 50),
      { id: 'coffee', name: 'Coffee', color: '#E8A87C', value: 1 }, // now smallest → tail → __other__
    ]; // 7 positive, cap 6 → top5 a,b,c,d,e + (f,coffee) folded into __other__
    rerender(<SpendingDonut slices={after} />);

    expect(screen.getByTestId('donut-slice-__other__')).toBeTruthy(); // fold happened
    expect(screen.queryByTestId('donut-slice-coffee')).toBeNull();    // coffee no longer painted
    expect(opacityOf('a')).toBeCloseTo(1);                            // ring un-dimmed, NOT stuck
    expect(screen.getByTestId('donut-center-total').props.children).toBe('$451'); // hole back to the total (nothing popped)
  });
});

describe('SpendingDonut — a cached wedge re-entering must re-target, not keep its stale emphasis', () => {
  // [E2] The load-bearing anchor: a category that LEFT and RETURNS while a selection is held. Its
  // Animated.Value is cached (the map never evicts, the donut never remounts), so init is skipped
  // on return — only the painted-id-set effect dep re-targets it. FAIL-ON-REVERT of that dep: with
  // deps [activeId, reduceMotion] the return rerender doesn't re-run the effect (activeId unchanged)
  // and z reads its stale cached 0 → opacity 1. With paintedKey in the deps → setValue(-1) → its own dimmed opacity.
  it('[E2] a category that leaves then returns while one is selected renders dimmed (not stale-bright)', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />); // z leaves (its value stays cached)
    fireEvent.press(screen.getByTestId('donut-slice-a')); // now select a
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z returns, a still selected

    expect(opacityOf('z')).toBeCloseTo(DIM_CATEGORY); // re-targeted to dim, not the stale cached full-bright
    expect(opacityOf('a')).toBeCloseTo(1);    // a still popped
  });
});

describe('SpendingDonut — selection clears when its category leaves the data', () => {
  // Fail-on-revert anchor for the real fix (activeId in the spring target + effect deps): with the
  // bug, the effect never re-runs when the data changes, so Groceries stays dimmed.
  it('un-dims the ring when the selected category drops out (no stuck all-dimmed ring)', () => {
    const { rerender } = render(<SpendingDonut slices={TWO} />);

    fireEvent.press(screen.getByTestId('donut-slice-c')); // select Coffee → Groceries dims
    expect(opacityOf('g')).toBeCloseTo(DIM_CATEGORY);

    rerender(<SpendingDonut slices={ONLY_G} />); // Coffee leaves the data
    expect(opacityOf('g')).toBeCloseTo(1); // un-dimmed, not stuck
  });
});

