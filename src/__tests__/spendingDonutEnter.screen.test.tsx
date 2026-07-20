// WHIT-305 — a category ENTERING the donut while another is highlighted must render dimmed (0.4)
// like its peers, not at full opacity until the next tap. Two fix parts, one anchor each:
//   • init a first-seen wedge at its current target (kills the frame-1 bright flash)
//   • re-run the emphasis effect when the painted id-set changes (covers re-appearing ids whose
//     Animated.Value is cached — the effect deps otherwise only fire on selection change)
// react-native-svg is stubbed to Views in jest; the emphasis opacity resolves to a plain NUMBER on
// the wedge group node. reduce-motion is forced ON so the effect's setValue is synchronous.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut } from '../components/SpendingDonut';
import { opacityOf, sl } from './support/donut';

describe('SpendingDonut — a category entering mid-highlight is dimmed', () => {
  // [E1] Brand-new (never-seen) category appears while 'a' is selected → it must be dimmed, not
  // bright. END-STATE guard: goes red only if BOTH fix parts are reverted (value born at 0 AND the
  // effect not re-run). The paintedKey dep alone already dims it by assert time, so this does not
  // isolate the init — the init's payoff is that frame ONE is dimmed (no bright flash), which RTL
  // can't see (effects flush before assertions); that's a device check. [E2] isolates the dep.
  it('[E1] a brand-new category appearing while one is selected renders dimmed', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />);
    fireEvent.press(screen.getByTestId('donut-slice-a')); // select a → b dims
    expect(opacityOf('b')).toBeCloseTo(0.4);

    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z is new
    expect(opacityOf('z')).toBeCloseTo(0.4); // dimmed like its peers, not full-bright
    expect(opacityOf('a')).toBeCloseTo(1);    // a still popped
    expect(opacityOf('b')).toBeCloseTo(0.4); // b untouched
  });

  // [E2] The load-bearing anchor: a category that LEFT and RETURNS while a selection is held. Its
  // Animated.Value is cached (the map never evicts, the donut never remounts), so init is skipped
  // on return — only the painted-id-set effect dep re-targets it. FAIL-ON-REVERT of that dep: with
  // deps [activeId, reduceMotion] the return rerender doesn't re-run the effect (activeId unchanged)
  // and z reads its stale cached 0 → opacity 1. With paintedKey in the deps → setValue(-1) → 0.4.
  it('[E2] a category that leaves then returns while one is selected renders dimmed (not stale-bright)', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />); // z leaves (its value stays cached)
    fireEvent.press(screen.getByTestId('donut-slice-a')); // now select a
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z returns, a still selected

    expect(opacityOf('z')).toBeCloseTo(0.4); // re-targeted to dim, not the stale cached full-bright
    expect(opacityOf('a')).toBeCloseTo(1);    // a still popped
  });

  // [E3] Guard (characterization, not fail-on-revert): a new category while NOTHING is selected must
  // stay full-bright — the init/effect target is 0 (rest), so no accidental over-dimming.
  it('[E3] a new category while nothing is selected stays full-bright', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />);
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);
    expect(opacityOf('z')).toBeCloseTo(1);
  });
});
