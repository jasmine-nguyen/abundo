// WHIT-305 — isolating anchor for the INIT half of the fix: a first-seen wedge's Animated.Value is
// BORN at its current emphasis target (−1 while another category is selected), not at 0. This is the
// part [E1] can't prove — under RTL the effect flushes before assertions, so the born-dimmed frame
// isn't observable via opacity; instead we intercept the Animated.Value constructor and read the
// birth arg directly. Reverting the init (back to `new Animated.Value(0)`) reddens this test.
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import React from 'react';
import { Animated } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut } from '../components/SpendingDonut';
import { sl } from './support/donut';

// spyOn's default impl calls a class as a plain function (breaks `new`), so wrap it: record the arg
// and construct via the real class. Typed loosely — this is test plumbing around a class constructor.
const spyValueBirths = (): any => {
  const Real = Animated.Value;
  const spy: any = jest.spyOn(Animated, 'Value');
  spy.mockImplementation((v: number) => new Real(v));
  return spy;
};

afterEach(() => { jest.restoreAllMocks(); });

describe('SpendingDonut — a first-seen wedge is born at its emphasis target', () => {
  it('[E4] births a new wedge at −1 (dimmed) while a category is selected, not at 0', () => {
    const spy = spyValueBirths();
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />);
    fireEvent.press(screen.getByTestId('donut-slice-a')); // select a

    spy.mockClear(); // ignore the a/b births from the first render
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z is first-seen

    // a and b are cached (no re-construction); only z is newly born this render, and it must be
    // born dimmed (−1), matching its already-dimmed peers — not at 0 (which would flash full).
    expect(spy.mock.calls.map((c: number[]) => c[0])).toEqual([-1]);
  });

  it('[E5] births a new wedge at 0 (rest) while nothing is selected', () => {
    const spy = spyValueBirths();
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />); // no selection

    spy.mockClear();
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);

    expect(spy.mock.calls.map((c: number[]) => c[0])).toEqual([0]); // born at rest, not dimmed
  });
});
