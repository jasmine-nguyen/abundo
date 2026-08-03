// WHIT-425 (QA gap) — [A56], [A58]-[A60], the RENDERED edges the swapped-constant screen assertions miss.
//
// The implementer's screen work swapped 19 literal 0.4s for named per-colour constants. Every one of
// those runs the same shape: a normal ring, a normal tap. This file is the adversarial half — what
// the per-colour fade does when a wedge is drawn twice, when a colour changes underneath a wedge
// that is already dimmed, when a colour will not parse, and across repeated selection.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// Reduce-motion ON so the springs settle synchronously — same pattern as every other donut suite.
// The reduce-motion-OFF (animated) branch lives in spendingDonutDimMotion.screen.test.tsx.
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { OTHER_COLOR } from '../chartColors';
import { WEDGE_DIM_MAX, wedgeDimOpacity } from '../contrast';
import { opacityOf, ancestorProp, sl, DIM_BLUE, DIM_GREEN, DIM_OTHER } from './support/donut';

const slice = (id: string, color: string, value: number): DonutSlice => ({ id, name: id, color, value });
const scaleOf = (id: string) => ancestorProp(`donut-slice-${id}`, 'scale');

describe('SpendingDonut — the fade maths assumes each wedge is painted EXACTLY once', () => {
  // [A56] The whole derivation rests on "a faded wedge sits on the opaque CHART_BG track below and
  // nothing else" (SpendingDonut.tsx:93-95). Two stacked copies at opacity a composite to
  // 1-(1-a)^2 -- 0.561 would land at 0.807 -- so the measured contrast would silently stop being
  // the contrast the module computed. The overlay must therefore never carry a second painted band,
  // and must only ever exist for the wedge whose opacity is 1.
  // FAIL-ON-REVERT: drop the `interactive ?` guard on bandTestID (SpendingDonut.tsx:267) and the
  // band count goes to 4.
  it('[A56] a dimmed wedge has exactly one painted band; the overlay adds none and sits at 1', () => {
    render(<SpendingDonut slices={[sl('a', 50), sl('b', 30), sl('c', 20)]} />);
    expect(screen.getAllByTestId(/^donut-band-/)).toHaveLength(3);

    fireEvent.press(screen.getByTestId('donut-slice-a'));

    expect(screen.getAllByTestId(/^donut-band-/)).toHaveLength(3);   // still one band per wedge
    expect(screen.getByTestId('donut-top')).toBeTruthy();            // the overlay IS drawn
    expect(ancestorProp('donut-top', 'opacity')).toBeCloseTo(1);     // ...only ever at full opacity
    expect(ancestorProp('donut-band-a', 'opacity')).toBeCloseTo(1);  // as is the base under it
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE);                    // the faded ones are single-painted
    expect(opacityOf('c')).toBeCloseTo(DIM_BLUE);
  });

});

describe('SpendingDonut — the fade must track the CURRENT colour, not a remembered one', () => {
  // [A58] `anims` is keyed by id and never evicted (SpendingDonut.tsx:171). The fade, unlike the
  // emphasis value, is a function of the COLOUR — and a category's colour really does change under
  // a stable id: chartColors.ts:84-88 documents a client running ahead of the server falling back
  // to an id-derived hue, then switching to the slotted one once `colorSlot` arrives.
  // This is also the tripwire for the obvious performance fix: wedgeDimOpacity runs a 30-step
  // bisection per wedge per redraw, and caching it BY ID (rather than by colour) would pass every
  // other test in the suite and pin the old hue's fade forever.
  it('[A58] a wedge recoloured while it is dimmed re-derives its fade', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />);
    fireEvent.press(screen.getByTestId('donut-slice-a'));
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE);   // b is #7aa2f7

    // Same id, same value, new colour — only the hue moved.
    rerender(<SpendingDonut slices={[sl('a', 75), slice('b', '#7FD49B', 25)]} />);

    expect(screen.getByTestId('donut-band-b').props.stroke).toBe('#7FD49B');
    expect(opacityOf('b')).toBeCloseTo(DIM_GREEN);  // the greener, brighter hue fades FURTHER
    expect(DIM_GREEN).toBeLessThan(DIM_BLUE);       // ...which is the point of deriving it at all
    expect(opacityOf('a')).toBeCloseTo(1);
  });

  // [A59] An unusable colour string reaching the REAL component, not just the pure module. [Q33]
  // proves wedgeDimOpacity clamps; nothing proved the clamp survives the render, and the clamp is
  // the one path where a dimmed wedge is nearly indistinguishable from the picked one (0.85 vs 1).
  // Empty string is the realistic shape — a category row whose colour never resolved.
  it('[A59] a wedge with an unparseable colour still renders, and lands on the clamp', () => {
    render(<SpendingDonut slices={[sl('a', 60), slice('broken', '', 40)]} />);
    fireEvent.press(screen.getByTestId('donut-slice-a'));

    expect(opacityOf('broken')).toBeCloseTo(WEDGE_DIM_MAX);
    expect(opacityOf('broken')).toBeLessThan(1);          // it does step back, per contrast.ts:21-26
    expect(opacityOf('broken')).toBeGreaterThan(DIM_BLUE); // ...but far less than a measurable peer:
                                                           // an unresolved colour reads closest to
                                                           // "selected" of anything on the ring.
    expect(wedgeDimOpacity('')).toBe(WEDGE_DIM_MAX);       // the module half, for the seam
  });
});

describe('SpendingDonut — repeated selection lands exactly on the derived values', () => {
  // [A60] Select -> deselect -> select a DIFFERENT wedge, with three different colours in play. The
  // fade is now three different numbers instead of one shared constant, so a wedge picking up a
  // neighbour's floor (a mixed-up index, a shared interpolation, a memo keyed on the wrong thing)
  // is a NEW class of bug that the old flat DIM could not express. Nothing else drives the cycle
  // more than once.
  it('[A60] each wedge returns to its OWN floor on every re-selection, never a neighbour\'s', () => {
    render(<SpendingDonut slices={[
      slice('blue', '#7aa2f7', 50), slice('green', '#7FD49B', 30), slice('grey', OTHER_COLOR, 20),
    ]} />);

    fireEvent.press(screen.getByTestId('donut-slice-blue'));
    expect(opacityOf('green')).toBeCloseTo(DIM_GREEN);
    expect(opacityOf('grey')).toBeCloseTo(DIM_OTHER);

    fireEvent.press(screen.getByTestId('donut-slice-blue'));   // tap again -> deselect
    for (const id of ['blue', 'green', 'grey']) expect(opacityOf(id)).toBeCloseTo(1);

    fireEvent.press(screen.getByTestId('donut-slice-green'));  // now pick a different one
    expect(opacityOf('green')).toBeCloseTo(1);
    expect(opacityOf('blue')).toBeCloseTo(DIM_BLUE);           // its own floor, not green's
    expect(opacityOf('grey')).toBeCloseTo(DIM_OTHER);

    fireEvent.press(screen.getByTestId('donut-center-reset')); // clear from the hole
    for (const id of ['blue', 'green', 'grey']) expect(opacityOf(id)).toBeCloseTo(1);

    fireEvent.press(screen.getByTestId('donut-slice-grey'));   // and once more, third wedge
    expect(opacityOf('grey')).toBeCloseTo(1);
    expect(opacityOf('blue')).toBeCloseTo(DIM_BLUE);
    expect(opacityOf('green')).toBeCloseTo(DIM_GREEN);
  });
});
