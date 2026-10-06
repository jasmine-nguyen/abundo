// WHIT-759 (QA) — the grey "Other" fade on the ANIMATED path (reduce-motion off, the phone's
// default). spendingDonutDimMotion only springs category wedges; the grey's own 0.85 target is a
// separate branch of wedgeDim and was only ever seen on the instant path. Own file because
// jest.mock is module-scoped.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => false }));

import { SpendingDonut } from '../components/SpendingDonut';
import { opacityOf, sl, DIM_CATEGORY, DIM_OTHER, settleSpring as settle } from './support/donut';

describe('SpendingDonut — the grey "Other" springs to its own fade', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.runOnlyPendingTimers(); jest.useRealTimers(); });

  // [A6] Every frame of the spring stays at or above 0.85 for the grey, and it settles there.
  it('[A6] with motion on, "Other" never dips below 0.85 while fading and rests on it', () => {
    const seven = [sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 50), sl('g', 40)];
    render(<SpendingDonut slices={seven} />);
    settle();

    fireEvent.press(screen.getByTestId('donut-slice-a'));
    const frames: number[] = [];
    for (let i = 0; i < 120; i++) {
      act(() => { jest.advanceTimersByTime(16); });
      frames.push(opacityOf('__other__')!);
    }
    expect(Math.min(...frames)).toBeCloseTo(DIM_OTHER, 3);
    expect(frames.some((f) => f > DIM_OTHER + 0.02 && f < 0.99)).toBe(true);

    settle();
    expect(opacityOf('__other__')).toBeCloseTo(DIM_OTHER, 3);
    expect(opacityOf('b')).toBeCloseTo(DIM_CATEGORY, 3);
  });
});
