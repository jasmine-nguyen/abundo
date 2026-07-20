// Donut selection must clear when the tapped category leaves the data, so the ring never gets stuck
// all-dimmed. react-native-svg is stubbed to Views in jest, so the dimming isn't visible as a real
// opacity — but it lives on each wedge group's animated `opacity` node, which we read live off the
// rendered node. reduce-motion is forced ON so the effect's `setValue` is synchronous (no spring to
// wait on). Also pins the pure `activeSelection` helper.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, activeSelection, type DonutSlice } from '../components/SpendingDonut';
import { opacityOf } from './support/donut';

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
  // bug, the effect never re-runs when the data changes, so Groceries stays dimmed at 0.4.
  it('un-dims the ring when the selected category drops out (no stuck all-dimmed ring)', () => {
    const { rerender } = render(<SpendingDonut slices={TWO} />);

    fireEvent.press(screen.getByTestId('donut-slice-c')); // select Coffee → Groceries dims
    expect(opacityOf('g')).toBeCloseTo(0.4); // DIM

    rerender(<SpendingDonut slices={ONLY_G} />); // Coffee leaves the data
    expect(opacityOf('g')).toBeCloseTo(1); // un-dimmed, not stuck
  });
});
