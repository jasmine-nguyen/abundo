// WHIT-403 — the divider between donut slices. It is a GAP over a CHART_BG-painted ring track, not
// a drawn line: the track shows through, so the divider's colour is the track's colour and its width
// is the angular inset applied to each wedge end. Before this card the track was a faint blue
// (C.hairlineStrong) and the gap was 2px.
// The jest react-native-svg stub renders every element as a plain View with all props forwarded, so
// `stroke`, `strokeWidth` and `d` are readable off the rendered nodes.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { CHART_BG } from '../theme/chartColors';
import { C } from '../theme';
import { sl, paintedBands, bandPath, arcExtentDeg, dividerGapPx } from './support/donut';

// THREE slices, never one: a lone slice paints as a full circle with no arc ends and therefore no
// divider at all (and no `d` prop to read). Sweeps here are 180° / 108° / 72°.
const THREE: DonutSlice[] = [sl('a', 50), sl('b', 30), sl('c', 20)];

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
