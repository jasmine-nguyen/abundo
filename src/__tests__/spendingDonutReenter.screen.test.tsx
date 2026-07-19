// WHIT-305 — adversarial GAPS the enter/fold/selection files miss, all turning on the paintedKey
// effect dep re-targeting CACHED (never-evicted) wedges when the id-set changes but activeId does
// not. E1/E2/E3 cover a fresh (cached-at-0) return and first-seen entries; these cover the two
// stale states E2 does not: a wedge cached POPPED (+1) and a wedge cached DIMMED (−1), plus the
// synthesised __other__ bucket. react-native-svg is stubbed to Views; emphasis opacity resolves to
// a plain NUMBER on the wedge group node. reduce-motion forced ON so the effect's setValue is sync.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { opacityOf, sl } from './support/donut';

describe('SpendingDonut — a cached wedge re-entering must re-target, not keep its stale emphasis', () => {
  // [A8] A wedge that was itself POPPED (+1), left the data, then RETURNS while a DIFFERENT category
  // is selected. Its Animated.Value is cached at +1 (map never evicts). It must dim to −1 (0.22) to
  // match its peers, NOT paint popped/bright as if it were still the selection.
  // FAIL-ON-REVERT (paintedKey dep): on return activeId is unchanged ('a'), so with deps
  // [activeId, reduceMotion] the effect does not re-run and emphasisOf('z') hands back the stale +1
  // → opacity 1. With paintedKey in the deps the effect re-targets z to −1 → 0.22. Distinct from
  // E2, whose stale value is 0 (rest) — here it is +1 (popped), a wedge masquerading as selected.
  it('[A8] a previously-popped wedge returning while another is selected dims (not stuck popped)', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);

    fireEvent.press(screen.getByTestId('donut-slice-z')); // pop z → its cached value is +1
    expect(opacityOf('z')).toBeCloseTo(1);
    expect(opacityOf('a')).toBeCloseTo(0.22);

    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />); // z leaves; +1 stays cached
    fireEvent.press(screen.getByTestId('donut-slice-a'));            // now select a instead
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z returns, a held

    expect(opacityOf('z')).toBeCloseTo(0.22); // re-targeted to dim, NOT the stale popped +1
    expect(opacityOf('a')).toBeCloseTo(1);    // a is the live selection
    expect(opacityOf('b')).toBeCloseTo(0.22);
  });

  // [A9] The over-dim guard the fix must not trip: a wedge cached DIMMED (−1) that returns while
  // NOTHING is selected must go full-bright (rest), not stay stuck at 0.22. E3 only covers a
  // first-seen wedge (born at its target); this covers a CACHED one whose stale value is −1.
  // FAIL-ON-REVERT (paintedKey dep): activeId is null both before and after the return, so without
  // the dep the effect never re-runs and z keeps its cached −1 → opacity 0.22 (wrongly dimmed).
  // With the dep it re-targets to 0 → opacity 1.
  it('[A9] a previously-dimmed wedge returning while nothing is selected goes full-bright (no over-dim)', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);

    fireEvent.press(screen.getByTestId('donut-slice-a')); // z dims to −1 (0.22), cached
    expect(opacityOf('z')).toBeCloseTo(0.22);

    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />); // z leaves; −1 stays cached
    fireEvent.press(screen.getByTestId('donut-slice-a'));            // deselect a → nothing selected
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z returns, no selection

    expect(opacityOf('z')).toBeCloseTo(1); // back to rest, NOT stuck dimmed at 0.22
    expect(opacityOf('a')).toBeCloseTo(1);
    expect(opacityOf('b')).toBeCloseTo(1);
  });

  // [A10] The synthesised '__other__' bucket appearing for the first time (tail crosses 6 → 7) while
  // a selection is held must paint dimmed like the real peers. CHARACTERIZATION w.r.t. the paintedKey
  // dep: __other__ is FIRST-SEEN here, so emphasisOf inits it at its target (−1) and reverting the
  // dep ALONE still leaves it dimmed — this does NOT fail on that revert (it fails only if the init
  // is ALSO reverted, exactly like E1). Its value is a data-path guard: the fold-created bucket is
  // covered by the same emphasis wiring as a real id, and the held selection's peers stay correct.
  it('[A10] the __other__ bucket newly appearing while one is selected paints dimmed', () => {
    const six: DonutSlice[] = [sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 50)];
    const { rerender } = render(<SpendingDonut slices={six} />); // 6 painted, no __other__
    expect(screen.queryByTestId('donut-slice-__other__')).toBeNull();

    fireEvent.press(screen.getByTestId('donut-slice-a')); // select a → peers dim
    expect(opacityOf('b')).toBeCloseTo(0.22);

    const seven: DonutSlice[] = [...six, sl('g', 10)]; // 7 positive → f,g fold into __other__
    rerender(<SpendingDonut slices={seven} />);

    expect(screen.getByTestId('donut-slice-__other__')).toBeTruthy();
    expect(opacityOf('__other__')).toBeCloseTo(0.22); // the new bucket dims like its peers
    expect(opacityOf('a')).toBeCloseTo(1);            // a still popped
    expect(opacityOf('b')).toBeCloseTo(0.22);         // untouched peer still dimmed
  });
});
