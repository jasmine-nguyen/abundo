// WHIT-425 (QA gap) — [A61][A62], the ANIMATED branch. Every one of the thirteen donut screen
// suites mocks useReduceMotion to `true`, so the per-colour fade has only ever been observed on the
// instant `v.setValue(target)` path (SpendingDonut.tsx:189). On a real phone, reduce-motion is OFF
// by default and the fade arrives through Animated.spring instead — a different line, a different
// clamp, and the one the on-device check will actually see.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// The ONLY donut suite that runs with motion ON. Kept in its own file because jest.mock is
// module-scoped and every sibling suite needs the opposite value.
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => false }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { opacityOf, ancestorProp, sl, DIM_BLUE, DIM_GREEN } from './support/donut';

const slice = (id: string, color: string, value: number): DonutSlice => ({ id, name: id, color, value });

// Drive the JS-driven spring (useNativeDriver: false) to rest. Fake timers, never a real sleep:
// react-native's requestAnimationFrame polyfill is a setTimeout, so advancing the clock advances
// the animation deterministically.
const settle = () => act(() => { jest.advanceTimersByTime(4000); });

describe('SpendingDonut — the fade lands on the derived value with motion ON (WHIT-425)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.runOnlyPendingTimers(); jest.useRealTimers(); });

  // [A61] The spring's rest position. friction 7 / tension 120 OVERSHOOTS, so the emphasis value
  // swings past -1 before settling; `extrapolate: 'clamp'` (SpendingDonut.tsx:244) is what stops
  // that overshoot painting a wedge BELOW its contrast floor mid-animation. Nothing pinned that
  // clamp on the opacity side — flattening it to the default 'extend' leaves every reduce-motion
  // suite green because setValue never overshoots.
  it('[A61] springing to dim settles on each wedge\'s own floor, and never undershoots it', () => {
    render(<SpendingDonut slices={[
      slice('blue', '#7aa2f7', 50), slice('green', '#7FD49B', 30),
    ]} />);
    settle();
    expect(opacityOf('green')).toBeCloseTo(1); // at rest, nothing faded

    fireEvent.press(screen.getByTestId('donut-slice-blue'));

    // Sweep EVERY frame of the fade, not a single sample: the spring undershoots past -1 around
    // frame 16 and sits there for several frames, so a one-off reading lands on the smooth part of
    // the curve and would never see it. The minimum across the whole animation is the assertion.
    const frames: number[] = [];
    for (let i = 0; i < 60; i++) {
      act(() => { jest.advanceTimersByTime(16); });
      frames.push(opacityOf('green')!);
    }
    expect(Math.min(...frames)).toBeCloseTo(DIM_GREEN, 3);  // never dips BELOW its contrast floor
    expect(Math.max(...frames)).toBeLessThanOrEqual(1);
    // ...and it really did animate rather than jumping — some frame sits strictly between.
    expect(frames.some((f) => f > DIM_GREEN + 0.05 && f < 0.95)).toBe(true);

    settle();
    expect(opacityOf('green')).toBeCloseTo(DIM_GREEN, 3);  // its own floor, reached by spring
    expect(opacityOf('blue')).toBeCloseTo(1);
    expect(ancestorProp('donut-band-blue', 'scale')).toBeGreaterThan(1);

    fireEvent.press(screen.getByTestId('donut-center-reset'));
    settle();
    expect(opacityOf('green')).toBeCloseTo(1, 3);          // and springs all the way back
    expect(opacityOf('blue')).toBeCloseTo(1, 3);
  });

  // [A62] The frame-one guard, on the branch that has one. A wedge appearing while a selection is
  // held is BORN at its target (SpendingDonut.tsx:174) rather than springing up from 0 — that is
  // what stops a new category flashing full-bright for a frame. With the fade now derived, "its
  // target" means ITS OWN colour's floor, so a birth value taken from a shared constant (or from
  // the wrong slice) would show up here and nowhere else. No timers needed: the assertion is the
  // value before the spring has had a chance to run.
  it('[A62] a wedge entering mid-selection is BORN at its own colour\'s floor, pre-spring', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />);
    settle();
    fireEvent.press(screen.getByTestId('donut-slice-a'));
    settle();

    // Two brand-new wedges, two different colours, arriving while 'a' is still selected.
    rerender(<SpendingDonut slices={[
      sl('a', 75), sl('b', 25), slice('newGreen', '#7FD49B', 40), slice('newBlue', '#7aa2f7', 35),
    ]} />);

    expect(opacityOf('newGreen')).toBeCloseTo(DIM_GREEN);  // NOT a shared constant...
    expect(opacityOf('newBlue')).toBeCloseTo(DIM_BLUE);    // ...the two differ by their hue
    expect(opacityOf('a')).toBeCloseTo(1);                 // the held selection still leads

    settle();  // and the spring does not move them off it
    expect(opacityOf('newGreen')).toBeCloseTo(DIM_GREEN, 3);
    expect(opacityOf('newBlue')).toBeCloseTo(DIM_BLUE, 3);
  });
});
