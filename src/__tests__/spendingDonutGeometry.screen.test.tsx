// SpendingDonut ring geometry, slice order, paint order and the "Other" bucket — the reduce-motion-ON
// donut suites merged (WHIT-451) from Divider/DividerEdges/Order/OrderEdges/Init/OtherColor/Pop/Enter.
// Every one mocked useReduceMotion → true, so they share this one file-level mock; none uses fake
// timers (the animated branch lives in spendingDonutDimMotion.screen.test.tsx).
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import React from 'react';
import { Animated } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, reduceSlices, type DonutSlice } from '../components/SpendingDonut';
import { CHART_BG, OTHER_COLOR } from '../chartColors';
import { C } from '../theme';
import {
  sl, paintedBands, bandPath, arcExtentDeg, dividerGapPx, dividerGapDeg,
  arcPoints, ancestorProp, paintedOrder, opacityOf, DIM_BLUE,
} from './support/donut';

const slice = (id: string, color: string, value: number): DonutSlice => ({ id, name: id, color, value });

const THREE: DonutSlice[] = [sl('a', 50), sl('b', 30), sl('c', 20)];

const scaleOf = (testID: string) => ancestorProp(testID, 'scale');

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

// The painted arc INSIDE the selection overlay group. It carries no testID on purpose (see [D4]),
// so it is found structurally: the overlay group is the one whose children include `donut-top`.
const overlayBandPath = (): string => {
  let found: string | null = null;
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const node = n as { children?: unknown[] };
    const kids = (node.children ?? []).filter((k): k is { props: Record<string, unknown> } => !!k && typeof k === 'object');
    if (kids.some((k) => k.props?.testID === 'donut-top')) {
      const band = kids.find((k) => k.props?.testID === undefined && k.props?.d !== undefined);
      if (band) found = String(band.props.d);
    }
    kids.forEach(walk);
  };
  walk(screen.toJSON());
  if (found === null) throw new Error('no painted band inside the overlay group');
  return found;
};

// spyOn's default impl calls a class as a plain function (breaks `new`), so wrap it: record the arg
// and construct via the real class. Typed loosely — this is test plumbing around a class constructor.
const spyValueBirths = (): any => {
  const Real = Animated.Value;
  const spy: any = jest.spyOn(Animated, 'Value');
  spy.mockImplementation((v: number) => new Real(v));
  return spy;
};

afterEach(() => { jest.restoreAllMocks(); });

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

// Seven positive slices against the default cap of six → the tail (f, g) folds into '__other__'.
// `sl` paints every slice '#7aa2f7', so the folded slice's colour can only be OTHER_COLOR if the
// fold sets it — it cannot be inherited from an input.
const SEVEN: DonutSlice[] = [
  sl('a', 100), sl('b', 50), sl('c', 30), sl('d', 10), sl('e', 5), sl('f', 3), sl('g', 2),
];

describe('SpendingDonut — the ring track is the divider colour', () => {
  it('[D1] the track is painted CHART_BG across the full band width', () => {
    render(<SpendingDonut slices={THREE} />);
    const track = screen.getByTestId('donut-track');
    expect(track.props.stroke).toBe(CHART_BG);
    expect(track.props.stroke).not.toBe(C.hairlineStrong); // the faint blue this replaced
    // Same width as a wedge, so the divider reads as background across the whole band rather than
    // only across part of it.
    expect(track.props.strokeWidth).toBe(paintedBands()[0].props.strokeWidth);
    // FAIL-ON-REVERT: put stroke={C.hairlineStrong} back on the track and the first two fail.
  });
});

describe('SpendingDonut — the divider measures 1.25px', () => {
  it('[D2] every boundary between wedges is a ~1.25px gap, including the wrap at 12 o\'clock', () => {
    render(<SpendingDonut slices={THREE} />);
    const [a, b, c] = ['a', 'b', 'c'].map(bandPath);
    expect(dividerGapPx(a, b)).toBeCloseTo(1.25, 2);
    expect(dividerGapPx(b, c)).toBeCloseTo(1.25, 2);
    expect(dividerGapPx(c, a)).toBeCloseTo(1.25, 2); // the wrap-around boundary
    // FAIL-ON-REVERT: set DIVIDER_PX back to 2 and each of these measures 2.0.
  });

  it('[D3] the gap lives on the painted band — the tap band still takes the full sweep', () => {
    render(<SpendingDonut slices={THREE} />);
    // Slice 'a' sweeps 180°; its painted arc gives up half a divider at each end (2 × 0.381°).
    expect(arcExtentDeg(bandPath('a'))).toBeCloseTo(179.238, 2);
    // Its tap band keeps the whole 180° so adjacent tap targets meet with no dead strip. This is
    // why the divider must never be measured off `donut-slice-<id>` — it would always read zero.
    const hit = screen.getByTestId('donut-slice-a');
    expect(arcExtentDeg(String(hit.props.d))).toBeCloseTo(180, 6);
    expect(Number(paintedBands()[0].props.strokeWidth)).toBeLessThan(Number(hit.props.strokeWidth));
  });
});

describe('SpendingDonut — the painted band stays unique and never inverts', () => {
  it('[D4] selecting a wedge adds an overlay but no second painted band', () => {
    render(<SpendingDonut slices={THREE} />);
    expect(paintedBands()).toHaveLength(3);

    fireEvent.press(screen.getByTestId('donut-slice-a'));

    expect(screen.getAllByTestId('donut-top')).toHaveLength(1); // the overlay really rendered
    expect(screen.getAllByTestId('donut-band-a')).toHaveLength(1); // but carries no band id
    expect(paintedBands()).toHaveLength(3);
  });

  it('[D5] a wedge too thin to pay a full half-divider keeps a third of itself instead of inverting', () => {
    // Sweeps: 358.209° / 1.433° / 0.358°. Half a divider is 0.381°, so 'tiny' cannot pay it at both
    // ends and gives up a third of its sweep at each instead — always leaving a third painted.
    const values: Record<string, number> = { big: 1000, mid: 4, tiny: 1 };
    render(<SpendingDonut slices={Object.entries(values).map(([id, v]) => sl(id, v))} />);
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

describe('SpendingDonut — the single-slice ring has no divider at all', () => {
  // [Q1] A lone category paints as a full Circle, not an arc: there is no boundary, so no divider
  // and no `d` to measure. D2/D3 use three slices precisely to avoid this branch, and D1 reads the
  // track's width off paintedBands()[0] — which only exists here because the WHIT-403 hunk put the
  // band id on the Circle branch too. ANCHOR for that: drop `testID={bandTestID}` from the
  // single-slice Circle and paintedBands() finds nothing → red.
  it('[Q1] a lone category is one full-ring band on the track radius, with no arc and no gap', () => {
    render(<SpendingDonut slices={[{ id: 'solo', name: 'Rent', color: '#7aa2f7', value: 100 }]} />);
    const bands = paintedBands();
    expect(bands).toHaveLength(1);
    const band = bands[0];
    expect(band.props.d).toBeUndefined();            // a Circle, not an arc — nothing to inset
    expect(band.props.stroke).toBe('#7aa2f7');       // the category's own colour, not the track's
    const track = screen.getByTestId('donut-track');
    expect(band.props.r).toBe(track.props.r);        // exactly covers the track — no ring peeking out
    expect(band.props.strokeWidth).toBe(track.props.strokeWidth);
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
  ])('[Q2] %s: identical gaps at every boundary and no arc left over', (_name, slices) => {
    render(<SpendingDonut slices={slices as DonutSlice[]} />);
    const paths = (slices as DonutSlice[]).map((s) => bandPath(s.id));
    const gaps = paths.map((d, i) => dividerGapDeg(d, paths[(i + 1) % paths.length]));
    const painted = paths.reduce((sum, d) => sum + arcExtentDeg(d), 0);

    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 9); // one uniform divider all the way round
    expect(gaps[0]).toBeGreaterThan(0);                      // the gaps really exist
    expect(painted).toBeCloseTo(360 - gaps.length * gaps[0], 9); // nothing unpainted beyond them
  });
});

describe('SpendingDonut — a wedge too thin to give up a full half-divider', () => {
  // [Q3] The consequence D5 stops short of: a wedge narrower than 1.5 dividers cannot give up half
  // a divider at each end without inverting, so it gives up a third of its sweep instead. Its
  // boundaries are therefore narrower than a normal one — the wedge simply cannot pay for more.
  // The number that matters is that they no longer collapse to the neighbour's half alone: the old
  // all-or-nothing threshold left them at 0.625px, they are now 0.82px.
  // ANCHOR for DIVIDER_PX: at 2px 'tiny' still pays sweep/3 but 'mid' pays a bigger half-divider,
  // so big|mid becomes 1.78px and mid|tiny 0.98px → both assertions below go red.
  it('[Q3] its boundaries are as wide as it can afford, while a normal boundary keeps the full 1.25px', () => {
    // Sweeps: big 358.209° / mid 1.433° / tiny 0.358°. Half a divider is 0.381°, so 'tiny' (whose
    // third is 0.119°) is the only one that cannot pay it.
    render(<SpendingDonut slices={[sl('big', 1000), sl('mid', 4), sl('tiny', 1)]} />);
    const [big, mid, tiny] = ['big', 'mid', 'tiny'].map(bandPath);

    expect(dividerGapPx(big, mid)).toBeCloseTo(1.25, 2);  // both neighbours pay in full
    expect(dividerGapPx(mid, tiny)).toBeCloseTo(0.821, 2); // tiny pays a third of itself instead
    expect(dividerGapPx(tiny, big)).toBeCloseTo(0.821, 2); // the wrap side of tiny, symmetrically
    // Symmetric on purpose: a thin wedge must not sit visibly off-centre between its neighbours.
    expect(dividerGapPx(mid, tiny)).toBeCloseTo(dividerGapPx(tiny, big), 9);
  });

  // [Q3b] ANCHOR for taking the MIN rather than an all-or-nothing threshold. The old rule had a
  // cliff at its cutoff: a wedge just under it kept its whole sweep while one just over it gave up
  // half a divider at each end — so spending LESS on a category could paint it THREE TIMES WIDER.
  // Walking a wedge's spend down across that cutoff must only ever shrink it. Restore the old
  // ternary and the pair straddling the cutoff inverts → red.
  it('[Q3b] painting width only ever moves with spend — no cliff at the thin-wedge cutoff', () => {
    // 'mid' sweeps 1.20° → 1.00° across these, which straddles the old 1.143° cutoff.
    const midValues = [3.35, 3.21, 3.19, 3.07, 2.79];
    const widths = midValues.map((value) => {
      const view = render(<SpendingDonut slices={[sl('big', 1000), sl('mid', value), sl('tiny', 1)]} />);
      const extent = arcExtentDeg(bandPath('mid'));
      view.unmount();
      return extent;
    });

    const descending = [...widths].sort((a, b) => b - a);
    expect(widths).toEqual(descending); // never wider than the next-bigger spend
  });
});

describe('SpendingDonut — the track is under the wedges and outside the selection', () => {
  // [Q4] PAINT ORDER. The divider only exists because the track sits BEHIND every wedge; move that
  // Circle after {wedges} and it repaints the whole ring flat CHART_BG — a blank donut that D1
  // still passes (its colour and width are unchanged). The reset disc must stay last so a centre
  // tap always wins. ANCHOR: moving the track line below {wedges} reddens this.
  it('[Q4] the track paints first, every band after it, and the centre reset disc last', () => {
    render(<SpendingDonut slices={THREE} />);
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

  // [Q5] The track must not be swept up in a wedge's pop/dim: it is a child of the STATIC group, so
  // it carries no animated opacity and does not scale. If it ever moved inside a wedge's animated
  // group, every divider would fade with its wedge and the ring would look smeared while a
  // slice is selected. REGRESSION GUARD (the current structure has always been this way).
  it('[Q5] selecting a wedge leaves exactly one track, still CHART_BG, with no emphasis opacity', () => {
    render(<SpendingDonut slices={THREE} />);
    fireEvent.press(screen.getByTestId('donut-slice-a'));

    expect(screen.getAllByTestId('donut-track')).toHaveLength(1);
    expect(screen.getByTestId('donut-track').props.stroke).toBe(CHART_BG);
    expect(ancestorProp('donut-track', 'opacity')).toBeUndefined();  // not inside any animated wedge group
    expect(ancestorProp('donut-band-b', 'opacity')).toBeCloseTo(DIM_BLUE); // sanity: the helper does find one
  });
});

describe('SpendingDonut — the popped wedge keeps its dividers', () => {
  // [Q6] The overlay copy is drawn from the SAME layout entry, so the popped wedge must be the same
  // inset arc as the base band beneath it — not the full sweep. If it were drawn uninset it would
  // grow into its neighbours' dividers as it pops and the gaps would visibly close on tap.
  // REGRESSION GUARD on renderWedge's non-interactive path (D4 only counts the nodes).
  it('[Q6] the overlay paints the same inset arc as the base band, not the full sweep', () => {
    render(<SpendingDonut slices={THREE} />);
    const base = bandPath('a');
    fireEvent.press(screen.getByTestId('donut-slice-a'));

    expect(overlayBandPath()).toBe(base);                       // identical geometry, gaps intact
    const hit = String(screen.getByTestId('donut-top').props.d); // its tap copy still takes the full sweep
    expect(arcExtentDeg(hit)).toBeGreaterThan(arcExtentDeg(base));
  });
});

describe('SpendingDonut — extreme but legal values', () => {
  // [Q7] A trillion-dollar category next to a one-dollar one: the sweep/inset arithmetic must stay
  // finite. A NaN in `d` is silent under the jest SVG stub but is a blank (or throwing) ring on a
  // real device, so it is worth a cheap guard on the new inset path. REGRESSION GUARD.
  it('[Q7] a 1e12-vs-1 spread still produces finite arc geometry for every wedge', () => {
    render(<SpendingDonut slices={[sl('big', 1e12), sl('mid', 1e6), sl('tiny', 1)]} />);
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
  it('[O1] paints wedges in spend order, with no warm/cool re-shuffle on top', () => {
    render(<SpendingDonut slices={WARM_CLUSTERED} />);
    expect(paintedOrder()).toEqual(['health', 'eatingout', 'coffee', 'shopping', 'transport', 'pets']);
    // FAIL-ON-REVERT: restore arrangeByTemperature around reduceSlices and this fixture paints
    // [health, shopping, eatingout, transport, coffee, pets] instead — a different array.
  });

  it('[O3] selection + centre readout resolve the tapped slice', () => {
    render(<SpendingDonut slices={WARM_CLUSTERED} />);
    fireEvent.press(screen.getByTestId('donut-slice-eatingout'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$90');
    expect(screen.getByText('eatingout')).toBeTruthy();
  });

  it('[O4] the folded Other slice is last even when it outweighs most kept slices', () => {
    // 7 inputs → reduceSlices keeps the 5 largest and folds 55 + 50 into __other__ = 105, which is
    // bigger than four of the five kept slices. Other is appended AFTER the descending sort, so it
    // stays last; re-sorting the list after the fold would move it to position 2 and fail this.
    const many: DonutSlice[] = [
      slice('health', '#ff75a0', 100), slice('shopping', '#73daca', 90),
      slice('eatingout', '#e5495f', 80), slice('transport', '#7aa2f7', 70),
      slice('coffee', '#ff9e64', 60), slice('a', '#7dcfff', 55), slice('b', '#9d7cd8', 50),
    ];
    render(<SpendingDonut slices={many} />);
    const order = paintedOrder();
    expect(order).toHaveLength(6);
    expect(order[order.length - 1]).toBe('__other__');
  });

  it('[O5] the spoken summary names categories in the painted order', () => {
    // Independent of [O1]: this pins the SUMMARY's order, so pointing the label at some other list
    // fails here while [O1] still passes. Note the assertion it replaces proved the opposite — the
    // ring order and the spoken order used to DIVERGE deliberately (the ring alternated, the summary
    // stayed largest-first). They coincide now, which is the point.
    render(<SpendingDonut slices={WARM_CLUSTERED} testID="donut-summary" />);
    const label = String(screen.getByTestId('donut-summary').props.accessibilityLabel);
    const spokenPositions = WARM_CLUSTERED.map((s) => label.indexOf(s.name));
    expect(spokenPositions).not.toContain(-1); // every category is named at all
    expect([...spokenPositions].sort((a, b) => a - b)).toEqual(spokenPositions);
  });
});

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
    expect(opacityOf('a')).toBeCloseTo(DIM_BLUE);

    rerender(<SpendingDonut slices={[sl('a', 50), sl('b', 120)]} />); // b overtakes a

    expect(paintedOrder()).toEqual(['b', 'a']);                                   // ring really swapped
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$120'); // still b, new total
    expect(opacityOf('b')).toBeCloseTo(1);                                        // still popped
    expect(opacityOf('a')).toBeCloseTo(DIM_BLUE);                                      // still dimmed
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

// The render half of the OTHER_COLOR guard chain: [Q19]/[Q25] in otherColorToken.logic.test.ts pin
// the TOKEN (it lifts off the chart background, stays clear of the category ramp); [Q20]/[Q21] here
// pin that the folded "Other" wedge is actually PAINTED that token.
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

describe('SpendingDonut — a category entering mid-highlight is dimmed', () => {
  // [E1] Brand-new (never-seen) category appears while 'a' is selected → it must be dimmed, not
  // bright. END-STATE guard: goes red only if BOTH fix parts are reverted (value born at 0 AND the
  // effect not re-run). The paintedKey dep alone already dims it by assert time, so this does not
  // isolate the init — the init's payoff is that frame ONE is dimmed (no bright flash), which RTL
  // can't see (effects flush before assertions); that's a device check. [E2] isolates the dep.
  it('[E1] a brand-new category appearing while one is selected renders dimmed', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />);
    fireEvent.press(screen.getByTestId('donut-slice-a')); // select a → b dims
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE);

    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z is new
    expect(opacityOf('z')).toBeCloseTo(DIM_BLUE); // dimmed like its peers, not full-bright
    expect(opacityOf('a')).toBeCloseTo(1);    // a still popped
    expect(opacityOf('b')).toBeCloseTo(DIM_BLUE); // b untouched
  });

  // [E2] The load-bearing anchor: a category that LEFT and RETURNS while a selection is held. Its
  // Animated.Value is cached (the map never evicts, the donut never remounts), so init is skipped
  // on return — only the painted-id-set effect dep re-targets it. FAIL-ON-REVERT of that dep: with
  // deps [activeId, reduceMotion] the return rerender doesn't re-run the effect (activeId unchanged)
  // and z reads its stale cached 0 → opacity 1. With paintedKey in the deps → setValue(-1) → its own dimmed opacity.
  it('[E2] a category that leaves then returns while one is selected renders dimmed (not stale-bright)', () => {
    const { rerender } = render(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />);
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25)]} />); // z leaves (its value stays cached)
    fireEvent.press(screen.getByTestId('donut-slice-a')); // now select a
    rerender(<SpendingDonut slices={[sl('a', 75), sl('b', 25), sl('z', 40)]} />); // z returns, a still selected

    expect(opacityOf('z')).toBeCloseTo(DIM_BLUE); // re-targeted to dim, not the stale cached full-bright
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

