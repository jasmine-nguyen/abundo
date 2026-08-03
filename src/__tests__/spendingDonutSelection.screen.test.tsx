// Donut selection must clear when the tapped category leaves the data, so the ring never gets stuck
// all-dimmed. react-native-svg is stubbed to Views in jest, so the dimming isn't visible as a real
// opacity — but it lives on each wedge group's animated `opacity` node, which we read live off the
// rendered node. reduce-motion is forced ON so the effect's `setValue` is synchronous (no spring to
// wait on). Also pins the pure `activeSelection` helper.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, activeSelection, OTHER_SLICE_ID, type DonutSlice } from '../components/SpendingDonut';
import { opacityOf, DIM_BLUE, DIM_GREEN, DIM_OTHER } from './support/donut';

const TWO: DonutSlice[] = [
  { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
  { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
];
const ONLY_G: DonutSlice[] = [{ id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 }];

describe('activeSelection (pure)', () => {
  it('keeps the id while its category is still painted', () => {
    expect(activeSelection('c', TWO)).toBe('c');
  });
  it('drops to null when the id is no longer painted', () => {
    expect(activeSelection('c', ONLY_G)).toBeNull();
  });
  it('is null when nothing is selected', () => {
    expect(activeSelection(null, TWO)).toBeNull();
  });
});

describe('SpendingDonut — selection clears when its category leaves the data', () => {
  // Fail-on-revert anchor for the real fix (activeId in the spring target + effect deps): with the
  // bug, the effect never re-runs when the data changes, so Groceries stays dimmed.
  it('un-dims the ring when the selected category drops out (no stuck all-dimmed ring)', () => {
    const { rerender } = render(<SpendingDonut slices={TWO} />);

    fireEvent.press(screen.getByTestId('donut-slice-c')); // select Coffee → Groceries dims
    expect(opacityOf('g')).toBeCloseTo(DIM_GREEN);

    rerender(<SpendingDonut slices={ONLY_G} />); // Coffee leaves the data
    expect(opacityOf('g')).toBeCloseTo(1); // un-dimmed, not stuck
  });
});

describe('SpendingDonut — the fold bucket fades on its own floor (WHIT-425)', () => {
  // The grey "Other" needs far more opacity than a category to reach the same visibility, because
  // it starts far darker. [A10] covers the bucket APPEARING mid-selection; this covers the ordinary
  // case — it is already on screen when you tap a category.
  // FAIL-ON-REVERT: give every wedge one shared fade and Other lands at a category's 0.561, where
  // it measures 1.9:1 and is the wedge WHIT-425 was filed about.
  it('a category selection dims the real peers and the bucket, each to its own value', () => {
    const seven: DonutSlice[] = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`, name: `s${i}`, color: '#7aa2f7', value: 100 - i * 10,
    })); // 7 positive, cap 6 → the tail folds into __other__
    render(<SpendingDonut slices={seven} />);
    expect(screen.getByTestId(`donut-slice-${OTHER_SLICE_ID}`)).toBeTruthy();

    fireEvent.press(screen.getByTestId('donut-slice-s0'));
    expect(opacityOf('s0')).toBeCloseTo(1);                      // the picked wedge leads
    expect(opacityOf('s1')).toBeCloseTo(DIM_BLUE);               // a real peer steps back
    expect(opacityOf(OTHER_SLICE_ID)).toBeCloseTo(DIM_OTHER);    // so does the bucket, further up
    expect(opacityOf(OTHER_SLICE_ID)).toBeLessThan(1);           // it really does fade
  });
});
