// WHIT-403 — [Q1]-[Q7] adversarial GAPS around the new CHART_BG divider that the implementer's
// [D1]-[D5] do not reach: the track's PAINT ORDER (a track drawn after the wedges would erase the
// whole ring — D1 only reads its colour), the single-slice branch (a full ring with no arc ends and
// therefore no divider at all — D2 deliberately avoids it), ring completeness (no arc dropped or
// double-counted), a thin UNINSET wedge's boundaries (D5 pins its sweep but not what that does to
// the dividers either side of it), the track surviving a selection undimmed, the popped overlay
// keeping its inset, and float safety at extreme values.
// react-native-svg is stubbed to plain Views by jest.setup, so `stroke`, `strokeWidth`, `r` and `d`
// are readable off the rendered nodes — but nothing here can see real pixels; the visual reads are
// in the manual checklist.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// Reduce-motion ON so the emphasis springs settle synchronously — same pattern as every other donut
// screen suite.
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { CHART_BG } from '../chartColors';
import { sl, paintedBands, bandPath, arcPoints, arcExtentDeg, dividerGapPx, dividerGapDeg, ancestorProp, DIM_BLUE } from './support/donut';

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

const THREE: DonutSlice[] = [sl('a', 50), sl('b', 30), sl('c', 20)];

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
