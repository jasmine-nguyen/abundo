// WHIT-403 — [Q8]-[Q13] adversarial GAPS in the new ORDER contract that the implementer's [O1]-[O5]
// do not reach. O1/O5 use strictly DESCENDING values, so they only prove the ring follows the sort
// when the sort has a unique answer; these cover the cases where it does not or where the data is
// hostile: exact ties, negatives/zero, an empty list, the folded bucket inside the SPOKEN summary,
// and a value change that REORDERS the ring under a live selection (now possible on every redraw,
// since order is purely value-driven).
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { opacityOf, sl, paintedOrder } from './support/donut';

const slice = (id: string, color: string, value: number): DonutSlice => ({ id, name: id, color, value });
const labelOf = (testID: string) => String(screen.getByTestId(testID).props.accessibilityLabel);

// Same load-bearing hexes as the implementer's order suite: two warm (#ff75a0 341°, #ff9e64 25°)
// then two cool (#7aa2f7, #bb9af7) under the DELETED temperature() classifier. Written warm-warm-
// cool-cool so the old shuffle would interleave them to [health, transport, coffee, pets] — a
// different array from the input. All four values are EQUAL, which is the point: with no size to
// sort by, the only thing that can reorder this ring is a colour-based pass.
const TIED: DonutSlice[] = [
  slice('health', '#ff75a0', 25),
  slice('coffee', '#ff9e64', 25),
  slice('transport', '#7aa2f7', 25),
  slice('pets', '#bb9af7', 25),
];

describe('SpendingDonut — ties keep the caller\'s order', () => {
  // [Q8] ANCHOR (fail-on-revert): restore arrangeByTemperature around reduceSlices and this fixture
  // paints [health, transport, coffee, pets] instead. Distinct from [O1], which relies on distinct
  // values — a shuffle that only fired on ties would still pass O1. Also pins that the ring and the
  // spoken summary agree under ties, and that an identical redraw does not reshuffle.
  it('[Q8] four equal slices paint (and are spoken) in the order they were handed over', () => {
    const { rerender } = render(<SpendingDonut slices={TIED} testID="donut-tied" />);
    expect(paintedOrder()).toEqual(['health', 'coffee', 'transport', 'pets']);

    const spokenAt = TIED.map((s) => labelOf('donut-tied').indexOf(s.name));
    expect(spokenAt).not.toContain(-1); // every category is named at all
    expect([...spokenAt].sort((a, b) => a - b)).toEqual(spokenAt); // spoken in the painted order

    rerender(<SpendingDonut slices={TIED} testID="donut-tied" />);  // identical data, redrawn
    expect(paintedOrder()).toEqual(['health', 'coffee', 'transport', 'pets']); // no reshuffle
  });
});

describe('SpendingDonut — hostile values', () => {
  // [Q9] A refund-heavy or zeroed category must not punch a hole in the ring: negatives and zeros
  // are dropped before layout, and the one survivor paints as a CLOSED full ring (the single-slice
  // branch), with the hole total counting only the positive spend. REGRESSION GUARD on reduceSlices'
  // filter reaching the render — the existing unit tests pin the filter, not what it paints.
  it('[Q9] a negative and a zero category leave one closed full ring and an honest total', () => {
    render(<SpendingDonut slices={[sl('a', 100), sl('refund', -50), sl('zero', 0)]} testID="donut-neg" />);

    expect(paintedOrder()).toEqual(['a']);
    expect(screen.getByTestId('donut-band-a').props.d).toBeUndefined(); // full Circle, no arc ends
    expect(screen.getByTestId('donut-center-total').props.children).toBe('$100'); // −50 not netted off
    expect(labelOf('donut-neg')).toContain('a 100 percent');
    expect(labelOf('donut-neg')).not.toContain('refund');  // nothing painted is never announced
    expect(labelOf('donut-neg')).not.toContain('zero');
  });

  // [Q10] The empty list — a cycle with no spend at all. Distinct from the existing `[a: 0]` case:
  // this exercises the reduce over an EMPTY array. Nothing renders, so there is no lone CHART_BG
  // track sitting on the screen as a mystery dark ring. REGRESSION GUARD.
  it('[Q10] an empty slice list renders nothing at all — not a bare track', () => {
    const { toJSON } = render(<SpendingDonut slices={[]} />);
    expect(toJSON()).toBeNull();
    expect(screen.queryByTestId('donut-track')).toBeNull();
  });

  // [Q10b] ANCHOR for the non-finite guard. Infinity passes a bare `> 0`, and once it reaches the
  // total every sweep becomes Infinity / Infinity = NaN — a ring of `d="M NaN NaN ..."` arcs and a
  // "$∞" readout instead of the empty state. Two cases, because they fail at different guards:
  // an infinite VALUE (caught by reduceSlices' filter) and finite values whose SUM overflows
  // (caught by the render guard). Revert either half of that guard and this reddens.
  it.each([
    ['an infinite value', [sl('a', Infinity), sl('b', 50)]],
    ['finite values that overflow the total', [sl('a', Number.MAX_VALUE), sl('b', Number.MAX_VALUE)]],
  ])('[Q10b] %s never paints a NaN ring', (_name, slices) => {
    render(<SpendingDonut slices={slices as DonutSlice[]} />);
    // Whatever survives must be real geometry: no NaN in any painted arc, and no "∞" on screen.
    for (const band of screen.queryAllByTestId(/^donut-band-/)) {
      expect(String((band as any).props.d ?? '')).not.toContain('NaN');
    }
    expect(screen.queryByText(/∞|NaN/)).toBeNull();
  });
});

describe('SpendingDonut — the folded "Other" bucket in the spoken summary', () => {
  // [Q11] O4 pins Other last in the RING; O5 pins summary order on a fixture with NO fold. This is
  // the intersection neither covers: Other must be announced LAST even though it outweighs three of
  // the five kept slices, and the two categories folded into it must not be announced at all (a
  // screen reader naming a category that has no wedge is a lie about the chart).
  // ANCHOR-ish: re-sorting the painted list after the fold, or pointing the label back at a
  // separately-sorted list, reddens the ordering assertion.
  it('[Q11] Other is spoken last, and the categories folded into it are not spoken', () => {
    const many: DonutSlice[] = [
      sl('Alpha', 100), sl('Bravo', 90), sl('Charlie', 80), sl('Delta', 70), sl('Echo', 60),
      sl('Foxtrot', 55), sl('Golf', 50), // folded → Other = 105, bigger than Bravo…Echo
    ];
    render(<SpendingDonut slices={many} testID="donut-other" />);
    const label = labelOf('donut-other');

    const otherAt = label.indexOf('Other');
    expect(otherAt).toBeGreaterThan(0);
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
      expect(label.indexOf(name)).toBeGreaterThan(0);
      expect(label.indexOf(name)).toBeLessThan(otherAt); // every kept category is named before Other
    }
    expect(label).not.toContain('Foxtrot'); // folded away — no wedge, so no announcement
    expect(label).not.toContain('Golf');
    expect(label).toContain('Other 21 percent'); // 105 of 505
  });
});

describe('SpendingDonut — a data change that reorders the ring', () => {
  // [Q12] Order is now purely value-driven, so an ordinary refresh can swap two neighbours' places
  // on the ring while a selection is held. The selection follows the CATEGORY, not the position:
  // the tapped wedge stays popped with its new amount in the hole, its neighbour stays dimmed, and
  // the ring order really did swap. REGRESSION GUARD on the paintedKey re-target surviving a
  // reorder (the existing enter/re-enter suites only add or remove ids, never permute them).
  it('[Q12] two categories swapping places keeps the tapped one popped and re-reads its amount', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 100), sl('b', 60)]} />);
    fireEvent.press(screen.getByTestId('donut-slice-b'));
    expect(paintedOrder()).toEqual(['a', 'b']);
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$60');
    expect(opacityOf('a')).toBeCloseTo(0.4);

    rerender(<SpendingDonut slices={[sl('a', 50), sl('b', 120)]} />); // b overtakes a

    expect(paintedOrder()).toEqual(['b', 'a']);                                   // ring really swapped
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$120'); // still b, new total
    expect(opacityOf('b')).toBeCloseTo(1);                                        // still popped
    expect(opacityOf('a')).toBeCloseTo(0.4);                                      // still dimmed
  });

  // [Q13] The reorder must not break the divider: after the swap the wedges are still laid out
  // edge-to-edge around the full circle with their gaps intact. Cheap completeness re-check on a
  // permuted ring (the geometry suite only ever renders a fresh mount).
  it('[Q13] after a reorder every wedge is still painted exactly once', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 100), sl('b', 60), sl('c', 30)]} />);
    rerender(<SpendingDonut slices={[sl('a', 10), sl('b', 60), sl('c', 300)]} />);
    expect(paintedOrder()).toEqual(['c', 'b', 'a']);
    expect(screen.getAllByTestId(/^donut-band-/)).toHaveLength(3);
    expect(screen.getByTestId('donut-center-total').props.children).toBe('$370');
  });
});
