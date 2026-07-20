// WHIT-304 — [A5][A6][A7] donut selection un-sticks / persists correctly across DATA changes.
// Adversarial gaps beyond spendingDonut / spendingDonutGaps / spendingDonutSelection.
// react-native-svg is stubbed to Views in jest, so dimming isn't a visible opacity — it lives on
// each wedge group's animated `opacity`, which resolves to a plain NUMBER on the rendered node.
// reduce-motion is forced ON so the effect's setValue is synchronous (no spring to await).
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { opacityOf, sl } from './support/donut';

describe('SpendingDonut — selected tail slice folds into __other__ (gap)', () => {
  // [A5] Tapped 'coffee' is individually painted, then a data change pushes it into the tail so it
  // folds into '__other__' — its id LEAVES painted. activeId flips to null → ring un-dims. 'a'
  // existed before, was dimmed to 0.22, and survives; it must return to 1.
  // FAIL-ON-REVERT: with selectedId (not activeId) in the effect deps/target, the effect never
  // re-runs on this data change (selectedId is still 'coffee'), so 'a' stays stuck at 0.22.
  it('[A5] folding the selected slice into __other__ un-dims the ring (coffee → __other__)', () => {
    const before: DonutSlice[] = [
      sl('a', 100), sl('b', 60), sl('c', 50), { id: 'coffee', name: 'Coffee', color: '#E8A87C', value: 40 }, sl('e', 20),
    ]; // 5 painted, coffee individual
    const { rerender } = render(<SpendingDonut slices={before} />);

    fireEvent.press(screen.getByTestId('donut-slice-coffee'));
    expect(opacityOf('a')).toBeCloseTo(0.22); // a dims while Coffee is popped

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

describe('SpendingDonut — selecting __other__ then its composition changes (gap)', () => {
  // [A6] '__other__' persists across the change, so the (deliberately unreset) selection is kept:
  // Other stays popped, siblings stay dimmed, and the hole total re-reads the new Other sum.
  // CHARACTERIZATION: buggy and fixed code behave identically here (id persists), so this does NOT
  // fail on revert — it guards that the fix did not accidentally drop a still-valid selection.
  it('[A6] Other stays popped and the hole total updates when its members change', () => {
    const seven: DonutSlice[] = [
      sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 30), sl('g', 20),
    ]; // __other__ = f+g = 50
    const { rerender } = render(<SpendingDonut slices={seven} />);

    fireEvent.press(screen.getByTestId('donut-slice-__other__'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$50');
    expect(opacityOf('__other__')).toBeCloseTo(1);   // Other popped
    expect(opacityOf('a')).toBeCloseTo(0.22);        // siblings dimmed

    const seven2: DonutSlice[] = [
      sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 30), sl('g', 45),
    ]; // tail still f+g, now = 75
    rerender(<SpendingDonut slices={seven2} />);

    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$75'); // hole re-reads Other sum
    expect(opacityOf('__other__')).toBeCloseTo(1);   // still popped (selection preserved)
    expect(opacityOf('a')).toBeCloseTo(0.22);        // siblings still dimmed
  });
});

describe('SpendingDonut — data change that spares the selection (gap)', () => {
  // [A7] Only a NON-selected slice changes; the selected 'c' remains painted → selection + dimming
  // must be untouched. REGRESSION GUARD against an over-eager reset (e.g. if activeSelection ever
  // nulled on any data change). Does not fail on reverting THIS fix (both keep it popped).
  it('[A7] changing a non-selected slice does not disturb the popped/dimmed state', () => {
    const three: DonutSlice[] = [
      { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
      { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
      sl('x', 40),
    ];
    const { rerender } = render(<SpendingDonut slices={three} />);

    fireEvent.press(screen.getByTestId('donut-slice-c'));
    expect(opacityOf('c')).toBeCloseTo(1);    // Coffee popped
    expect(opacityOf('g')).toBeCloseTo(0.22); // Groceries dimmed

    rerender(
      <SpendingDonut slices={[
        { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
        { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
        sl('x', 99), // only x changes
      ]} />,
    );

    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$25'); // still Coffee
    expect(opacityOf('c')).toBeCloseTo(1);    // still popped
    expect(opacityOf('g')).toBeCloseTo(0.22); // still dimmed
  });
});
