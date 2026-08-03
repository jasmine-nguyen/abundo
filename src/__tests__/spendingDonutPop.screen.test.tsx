// WHIT-403 — [Q16] the POP, which the new divider's whole rationale rests on. SpendingDonut.tsx:68-70
// justifies making the divider a GAP over the CHART_BG track rather than a drawn line because the gap
// "grows and moves with a popped wedge (a static line would not)". Nothing in the suite pinned that:
// flattening the pop's outputRange to [1, 1, 1] leaves all 57 existing donut tests green, so the
// divider's stated reason for existing could silently stop being true. [Q5]/[Q12] pin the dimmed opacity
// only; [Q6]/[D4] pin the overlay's arc geometry but not that it is scaled.
// react-native-svg is stubbed to plain Views by jest.setup and the emphasis springs resolve to plain
// numbers, so the animated group's `scale` is readable straight off the rendered node.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// Reduce-motion ON so the springs settle synchronously — same pattern as every other donut suite.
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { sl, arcPoints, bandPath, ancestorProp } from './support/donut';

const scaleOf = (testID: string) => ancestorProp(testID, 'scale');

const THREE: DonutSlice[] = [sl('a', 50), sl('b', 30), sl('c', 20)];

describe('SpendingDonut — the popped wedge really grows, so its dividers grow with it', () => {
  // [Q16] ANCHOR (fail-on-revert): change the pop interpolation's outputRange from
  // [1, 1, SEL_SCALE] to [1, 1, 1] — every assertion below that expects a scale above 1 goes red,
  // while all 57 other donut tests stay green.
  it('[Q16] at rest nothing is scaled; tapping scales that wedge AND its overlay, neighbours stay put', () => {
    render(<SpendingDonut slices={THREE} />);

    // At rest every wedge sits flat on the track — no wedge is lifted for free.
    for (const id of ['a', 'b', 'c']) expect(scaleOf(`donut-band-${id}`)).toBe(1);

    fireEvent.press(screen.getByTestId('donut-slice-a'));

    const popped = scaleOf('donut-band-a');
    expect(popped).toBeGreaterThan(1);          // the tapped wedge lifts
    expect(scaleOf('donut-top')).toBe(popped);  // and so does the copy drawn ON TOP of it — the one
                                                // actually seen, and the one carrying the visible gap
    expect(scaleOf('donut-band-b')).toBe(1);    // neighbours are dimmed, never resized: a wedge that
    expect(scaleOf('donut-band-c')).toBe(1);    // grew too would close the gap it is meant to open

    // The consequence the divider design is built on. The wedge is drawn flush with the CHART_BG
    // track and its gap is an ANGLE on that same radius, so scaling the wedge's group carries the
    // gap outward with it — where a line drawn in the parent group would have stayed behind.
    expect(arcPoints(bandPath('a')).r).toBe(Number(screen.getByTestId('donut-track').props.r));
  });

  it('[Q16b] clearing the selection puts the popped wedge back flat on the track', () => {
    render(<SpendingDonut slices={THREE} />);
    fireEvent.press(screen.getByTestId('donut-slice-a'));
    expect(scaleOf('donut-band-a')).toBeGreaterThan(1);

    fireEvent.press(screen.getByTestId('donut-center-reset')); // tap the hole to clear

    expect(screen.queryByTestId('donut-top')).toBeNull();
    for (const id of ['a', 'b', 'c']) expect(scaleOf(`donut-band-${id}`)).toBe(1);
  });
});
