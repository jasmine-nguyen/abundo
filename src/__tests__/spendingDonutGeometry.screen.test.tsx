// SpendingDonut ring geometry, slice order, paint order and the "Other" bucket — the reduce-motion-ON
// donut suites merged (WHIT-451) from Divider/DividerEdges/Order/OrderEdges/Init/OtherColor/Pop/Enter.
// Every one mocked useReduceMotion → true, so they share this one file-level mock.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import {
  sl, slice, bandPath, arcExtentDeg, dividerGapDeg, arcPoints, paintedOrder, opacityOf, DIM_CATEGORY,
} from './support/donut';

const THREE: DonutSlice[] = [sl('a', 50), sl('b', 30), sl('c', 20)];

const labelOf = (testID: string) => String(screen.getByTestId(testID).props.accessibilityLabel);

// Every testID in RENDER order. SVG paints in document order, so later = drawn ON TOP.
const testIdOrder = (): string[] => {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const node = n as { props?: { testID?: unknown }; children?: unknown[] };
    if (node.props?.testID !== undefined) out.push(String(node.props.testID));
    (node.children ?? []).forEach(walk);
  };
  walk(screen.toJSON());
  return out;
};

// THESE HEXES ARE LOAD-BEARING — do not "modernise" them to the current chart ramp. They are the
// old app-wide palette, chosen because they split exactly 3 warm / 3 cool under the deleted
// temperature() classifier. That split is the only reason the shuffled order differs from the
// spend-descending one, which is what makes [O1] fail if the shuffle is ever put back.
// Values are strictly descending, so spend order is simply the order written here.
const WARM_CLUSTERED: DonutSlice[] = [
  slice('health', '#ff75a0', 100),
  slice('eatingout', '#e5495f', 90),
  slice('coffee', '#ff9e64', 80),
  slice('shopping', '#73daca', 70),
  slice('transport', '#7aa2f7', 60),
  slice('pets', '#bb9af7', 50),
];

// Same load-bearing hexes, all EQUAL in value: with no size to sort by, the only thing that can
// reorder this ring is a colour-based pass (the deleted temperature() shuffle).
const TIED: DonutSlice[] = [
  slice('health', '#ff75a0', 25),
  slice('coffee', '#ff9e64', 25),
  slice('transport', '#7aa2f7', 25),
  slice('pets', '#bb9af7', 25),
];

describe('SpendingDonut — the painted band stays unique and never inverts', () => {
  it('[D5] a wedge too thin to pay a full half-divider keeps a third of itself instead of inverting', async () => {
    // Sweeps: 358.209° / 1.433° / 0.358°. Half a divider is 0.381°, so 'tiny' cannot pay it at both
    // ends and gives up a third of its sweep at each instead — always leaving a third painted.
    const values: Record<string, number> = { big: 1000, mid: 4, tiny: 1 };
    await render(<SpendingDonut slices={Object.entries(values).map(([id, v]) => sl(id, v))} />);
    // A wedge's sweep is its share of the total — the layout contract, independent of the inset.
    const total = Object.values(values).reduce((sum, v) => sum + v, 0);
    for (const [id, value] of Object.entries(values)) {
      const sweep = (value / total) * 360;
      const extent = arcExtentDeg(bandPath(id));
      expect(extent).toBeGreaterThan(0);
      expect(extent).toBeLessThanOrEqual(sweep + 1e-9);
    }
    // Exactly a third of its sweep survives — never zero, never inverted, however thin it gets.
    expect(arcExtentDeg(bandPath('tiny'))).toBeCloseTo(((1 / total) * 360) / 3, 9);
    // An inverted arc would surface as an extent near 360 (the modulo keeps it positive), which is
    // why the bound above is an upper one against each wedge's own sweep — raising DIVIDER_PX far
    // enough to swallow a thin wedge breaks this.
  });
});

describe('SpendingDonut — the wedges tile the whole ring', () => {
  // [Q2] Completeness invariant, independent of the divider's WIDTH: going once round the ring, every
  // boundary gap must be identical and the painted arcs must account for all 360° minus exactly those
  // gaps. That is what catches an arc laid out against the wrong denominator, dropped, or
  // double-counted — the leftover surfaces as ONE oversized gap at the 12 o'clock wrap, which neither
  // D2 (three named boundaries on one fixture) nor O1 (which compares ids, not geometry) would see.
  // NB `painted + gaps === 360` ALONE is a tautology of the modulo arithmetic — the equal-gaps
  // assertion is the load-bearing one. REGRESSION GUARD: it holds at any divider width, on purpose.
  it.each([
    ['two wedges', [sl('a', 75), sl('b', 25)]],
    ['three wedges', THREE],
    ['six wedges', [sl('a', 60), sl('b', 50), sl('c', 40), sl('d', 30), sl('e', 20), sl('f', 10)]],
  ])('[Q2] %s: identical gaps at every boundary and no arc left over', async (_name, slices) => {
    await render(<SpendingDonut slices={slices as DonutSlice[]} />);
    const paths = (slices as DonutSlice[]).map((s) => bandPath(s.id));
    const gaps = paths.map((d, i) => dividerGapDeg(d, paths[(i + 1) % paths.length]));
    const painted = paths.reduce((sum, d) => sum + arcExtentDeg(d), 0);

    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 9); // one uniform divider all the way round
    expect(gaps[0]).toBeGreaterThan(0);                      // the gaps really exist
    expect(painted).toBeCloseTo(360 - gaps.length * gaps[0], 9); // nothing unpainted beyond them
  });
});

describe('SpendingDonut — a wedge too thin to give up a full half-divider', () => {
  // [Q3b] ANCHOR for taking the MIN rather than an all-or-nothing threshold. The old rule had a
  // cliff at its cutoff: a wedge just under it kept its whole sweep while one just over it gave up
  // half a divider at each end — so spending LESS on a category could paint it THREE TIMES WIDER.
  // Walking a wedge's spend down across that cutoff must only ever shrink it. Restore the old
  // ternary and the pair straddling the cutoff inverts → red.
  it('[Q3b] painting width only ever moves with spend — no cliff at the thin-wedge cutoff', async () => {
    // 'mid' sweeps 1.20° → 1.00° across these, which straddles the old 1.143° cutoff.
    const midValues = [3.35, 3.21, 3.19, 3.07, 2.79];
    const widths: number[] = [];
    for (const value of midValues) {
      const view = await render(<SpendingDonut slices={[sl('big', 1000), sl('mid', value), sl('tiny', 1)]} />);
      widths.push(arcExtentDeg(bandPath('mid')));
      await view.unmount();
    }

    const descending = [...widths].sort((a, b) => b - a);
    expect(widths).toEqual(descending); // never wider than the next-bigger spend
  });
});

describe('SpendingDonut — the track is under the wedges and outside the selection', () => {
  // [Q4] PAINT ORDER. The divider only exists because the track sits BEHIND every wedge; move that
  // Circle after {wedges} and it repaints the whole ring flat CHART_BG — a blank donut that D1
  // still passes (its colour and width are unchanged). The reset disc must stay last so a centre
  // tap always wins. ANCHOR: moving the track line below {wedges} reddens this.
  it('[Q4] the track paints first, every band after it, and the centre reset disc last', async () => {
    await render(<SpendingDonut slices={THREE} />);
    const order = testIdOrder();
    const trackAt = order.indexOf('donut-track');
    const bandAts = order.map((id, i) => (id.startsWith('donut-band-') ? i : -1)).filter((i) => i >= 0);
    expect(trackAt).toBeGreaterThanOrEqual(0);
    expect(bandAts).toHaveLength(3);
    expect(Math.min(...bandAts)).toBeGreaterThan(trackAt);              // wedges on top of the track
    const resetAt = order.indexOf('donut-center-reset');
    expect(resetAt).toBeGreaterThan(Math.max(...bandAts));       // hole tap stays on top of the ring
    // Nothing drawn INSIDE the ring follows it. Filtered to the ring's own nodes on purpose: the
    // centre readout renders later but lives outside the <Svg> and is pointerEvents="none", so
    // giving it a testID one day must not redden this.
    const ringAfterReset = order.slice(resetAt + 1).filter((id) => id.startsWith('donut-band-') || id === 'donut-track');
    expect(ringAfterReset).toEqual([]);
  });
});

describe('SpendingDonut — extreme but legal values', () => {
  // [Q7] A trillion-dollar category next to a one-dollar one: the sweep/inset arithmetic must stay
  // finite. A NaN in `d` is silent under the jest SVG stub but is a blank (or throwing) ring on a
  // real device, so it is worth a cheap guard on the new inset path. REGRESSION GUARD.
  it('[Q7] a 1e12-vs-1 spread still produces finite arc geometry for every wedge', async () => {
    await render(<SpendingDonut slices={[sl('big', 1e12), sl('mid', 1e6), sl('tiny', 1)]} />);
    for (const id of ['big', 'mid', 'tiny']) {
      const { x1, y1, r, x2, y2 } = arcPoints(bandPath(id));
      expect([x1, y1, r, x2, y2].filter((n) => !Number.isFinite(n))).toEqual([]);
    }
    expect(arcExtentDeg(bandPath('big'))).toBeGreaterThan(358);  // still the ring, not an inverted arc
  });
});

describe('SpendingDonut — slice order is spend descending, Other last', () => {
  // Exact-array equality, so this also carries the ported "no slice dropped or duplicated"
  // guarantee: a missing, extra or repeated wedge changes the array just as a reorder does.
  it('[O1] paints wedges in spend order, with no warm/cool re-shuffle on top', async () => {
    await render(<SpendingDonut slices={WARM_CLUSTERED} />);
    expect(paintedOrder()).toEqual(['health', 'eatingout', 'coffee', 'shopping', 'transport', 'pets']);
    // FAIL-ON-REVERT: restore arrangeByTemperature around reduceSlices and this fixture paints
    // [health, shopping, eatingout, transport, coffee, pets] instead — a different array.
  });

  it('[O4] the folded Other slice is last even when it outweighs most kept slices', async () => {
    // 7 inputs → reduceSlices keeps the 5 largest and folds 55 + 50 into __other__ = 105, which is
    // bigger than four of the five kept slices. Other is appended AFTER the descending sort, so it
    // stays last; re-sorting the list after the fold would move it to position 2 and fail this.
    const many: DonutSlice[] = [
      slice('health', '#ff75a0', 100), slice('shopping', '#73daca', 90),
      slice('eatingout', '#e5495f', 80), slice('transport', '#7aa2f7', 70),
      slice('coffee', '#ff9e64', 60), slice('a', '#7dcfff', 55), slice('b', '#9d7cd8', 50),
    ];
    await render(<SpendingDonut slices={many} />);
    const order = paintedOrder();
    expect(order).toHaveLength(6);
    expect(order[order.length - 1]).toBe('__other__');
  });
});

describe('SpendingDonut — ties keep the caller\'s order', () => {
  // [Q8] ANCHOR (fail-on-revert): restore arrangeByTemperature around reduceSlices and this fixture
  // paints [health, transport, coffee, pets] instead. Distinct from [O1], which relies on distinct
  // values — a shuffle that only fired on ties would still pass O1. Also pins that the ring and the
  // spoken summary agree under ties, and that an identical redraw does not reshuffle.
  it('[Q8] four equal slices paint (and are spoken) in the order they were handed over', async () => {
    const { rerender } = await render(<SpendingDonut slices={TIED} testID="donut-tied" />);
    expect(paintedOrder()).toEqual(['health', 'coffee', 'transport', 'pets']);

    const spokenAt = TIED.map((s) => labelOf('donut-tied').indexOf(s.name));
    expect(spokenAt).not.toContain(-1); // every category is named at all
    expect([...spokenAt].sort((a, b) => a - b)).toEqual(spokenAt); // spoken in the painted order

    await rerender(<SpendingDonut slices={TIED} testID="donut-tied" />);  // identical data, redrawn
    expect(paintedOrder()).toEqual(['health', 'coffee', 'transport', 'pets']); // no reshuffle
  });
});

describe('SpendingDonut — hostile values', () => {
  // [Q9] A refund-heavy or zeroed category must not punch a hole in the ring: negatives and zeros
  // are dropped before layout, and the one survivor paints as a CLOSED full ring (the single-slice
  // branch), with the hole total counting only the positive spend. REGRESSION GUARD on reduceSlices'
  // filter reaching the render — the existing unit tests pin the filter, not what it paints.
  it('[Q9] a negative and a zero category leave one closed full ring and an honest total', async () => {
    await render(<SpendingDonut slices={[sl('a', 100), sl('refund', -50), sl('zero', 0)]} testID="donut-neg" />);

    expect(paintedOrder()).toEqual(['a']);
    expect(screen.getByTestId('donut-band-a').props.d).toBeUndefined(); // full Circle, no arc ends
    expect(screen.getByTestId('donut-center-top-share').props.children).toBe('100%'); // −50 not netted off (netted it would read 200%)
    expect(labelOf('donut-neg')).toContain('a 100 percent');
    expect(labelOf('donut-neg')).not.toContain('refund');  // nothing painted is never announced
    expect(labelOf('donut-neg')).not.toContain('zero');
  });

  // [Q10b] ANCHOR for the non-finite guard. Infinity passes a bare `> 0`, and once it reaches the
  // total every sweep becomes Infinity / Infinity = NaN — a ring of `d="M NaN NaN ..."` arcs and a
  // "$∞" readout instead of the empty state. Two cases, because they fail at different guards:
  // an infinite VALUE (caught by reduceSlices' filter) and finite values whose SUM overflows
  // (caught by the render guard). Revert either half of that guard and this reddens.
  it.each([
    ['an infinite value', [sl('a', Infinity), sl('b', 50)]],
    ['finite values that overflow the total', [sl('a', Number.MAX_VALUE), sl('b', Number.MAX_VALUE)]],
  ])('[Q10b] %s never paints a NaN ring', async (_name, slices) => {
    await render(<SpendingDonut slices={slices as DonutSlice[]} />);
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
  it('[Q11] Other is spoken last, and the categories folded into it are not spoken', async () => {
    const many: DonutSlice[] = [
      sl('Alpha', 100), sl('Bravo', 90), sl('Charlie', 80), sl('Delta', 70), sl('Echo', 60),
      sl('Foxtrot', 55), sl('Golf', 50), // folded → Other = 105, bigger than Bravo…Echo
    ];
    await render(<SpendingDonut slices={many} testID="donut-other" />);
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
  it('[Q12] two categories swapping places keeps the tapped one popped and re-reads its amount', async () => {
    const { rerender } = await render(<SpendingDonut slices={[sl('a', 100), sl('b', 60)]} />);
    await fireEvent.press(screen.getByTestId('donut-slice-b'));
    expect(paintedOrder()).toEqual(['a', 'b']);
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$60');
    expect(opacityOf('a')).toBeCloseTo(DIM_CATEGORY);

    await rerender(<SpendingDonut slices={[sl('a', 50), sl('b', 120)]} />); // b overtakes a

    expect(paintedOrder()).toEqual(['b', 'a']);                                   // ring really swapped
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$120'); // still b, new total
    expect(opacityOf('b')).toBeCloseTo(1);                                        // still popped
    expect(opacityOf('a')).toBeCloseTo(DIM_CATEGORY);                                      // still dimmed
  });
});

