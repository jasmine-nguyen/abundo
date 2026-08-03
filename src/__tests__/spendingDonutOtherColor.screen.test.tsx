// WHIT-400 (QA gap) — [Q20][Q21] the MISSING LINK in this card's guard chain.
// [Q19]/[Q25] (otherColorToken.logic.test.ts) pin the TOKEN: that OTHER_COLOR lifts far enough off
// the chart background to be seen, and stays far enough from the category ramp. Nothing pinned
// that the "Other" wedge is actually PAINTED that token. Before this file, SpendingDonut.tsx's
// `color: OTHER_COLOR` (reduceSlices) could be swapped for any other colour and the whole suite —
// 1053 logic tests, twelve donut screen suites, the token guards included — stayed green. The existing
// OTHER_COLOR assertions are all NEGATIVE ("no category is ever this grey"); none is positive.
//
// So this is the assertion that makes those guards mean something: token → paint. Kept as a `screen` test
// because reduceSlices lives in a React-Native component module.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, reduceSlices, type DonutSlice } from '../components/SpendingDonut';
import { OTHER_COLOR } from '../chartColors';
import { sl } from './support/donut';

// Seven positive slices against the default cap of six → the tail (f, g) folds into '__other__'.
// `sl` paints every slice '#7aa2f7', so the folded slice's colour can only be OTHER_COLOR if the
// fold sets it — it cannot be inherited from an input.
const SEVEN: DonutSlice[] = [
  sl('a', 100), sl('b', 50), sl('c', 30), sl('d', 10), sl('e', 5), sl('f', 3), sl('g', 2),
];

describe('SpendingDonut — the folded "Other" wedge really is the reserved grey', () => {
  it('[Q20] the rendered __other__ band is stroked OTHER_COLOR, not an input colour', () => {
    render(<SpendingDonut slices={SEVEN} />);
    const other = screen.getByTestId('donut-band-__other__');
    expect(other.props.stroke).toBe(OTHER_COLOR);
    // Its neighbours still carry the colour the CALLER resolved — proving the grey is applied by the
    // fold and not by everything happening to be the same colour.
    expect(screen.getByTestId('donut-band-a').props.stroke).toBe('#7aa2f7');
    expect(other.props.stroke).not.toBe('#7aa2f7');
    // FAIL-ON-REVERT: change `color: OTHER_COLOR` in reduceSlices (SpendingDonut.tsx) to any other
    // colour and this reddens. Nothing else in the suite does.
  });

  it('[Q21] reduceSlices sets the grey on the folded slice itself', () => {
    const out = reduceSlices(SEVEN);
    const other = out[out.length - 1];
    expect(other.id).toBe('__other__');
    expect(other.color).toBe(OTHER_COLOR);
    // The pure half of [Q20]: it fixes the CONTRACT of reduceSlices' return, which the Insights
    // screen's a11y summary and centre readout also read, independently of what renders.
  });
});
