// WHIT-323 — adversarial GAP tests for the donut's warm/cool alternation. The implementer's
// happy-path + acceptance cases live in spendingDonutArrange.screen.test.tsx (balanced/lopsided
// alternation, Other-last, the Eating-Out/Health separation). This file adds the edges they did
// NOT cover: degenerate colours (black/white/grey), the 80°/330° hue boundaries, uppercase hex, a
// malformed hex (no-crash), and the degenerate arrangeByTemperature inputs (empty / single /
// all-warm / all-cool / only-Other / two-Other / very-warm-heavy). Plus an INTEGRATION check that
// the reorder is actually wired into SpendingDonut's painted wedge order (not just the pure fn),
// and that selection + the centre readout + slice-completeness survive the reorder.
// temperature/arrangeByTemperature live in SpendingDonut.tsx (RN imports) → screen project.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// Force reduce-motion ON so the emphasis springs settle synchronously (matches the other donut
// screen suites) — no animation to await for the selection assertions below.
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import {
  SpendingDonut, temperature, arrangeByTemperature, type DonutSlice,
} from '../components/SpendingDonut';

const slice = (id: string, color: string, value = 100): DonutSlice => ({ id, name: id, color, value });
const temps = (arr: DonutSlice[]) => arr.map((s) => temperature(s.color));
const ids = (arr: DonutSlice[]) => arr.map((s) => s.id);

// The painted wedge order as it actually renders: base wedges carry testID `donut-slice-<id>` and
// are emitted in painted order; the selection overlay is `donut-top` (excluded by this regex).
const paintedOrder = () =>
  screen.getAllByTestId(/^donut-slice-/).map((n: any) => String(n.props.testID).replace('donut-slice-', ''));

describe('temperature — degenerate + boundary colours (gaps)', () => {
  it('[A-T1] pure black / white / mid-grey are neutral (saturation 0 → never fights a hue)', () => {
    expect(temperature('#000000')).toBe('neutral'); // delta 0 → sat 0
    expect(temperature('#ffffff')).toBe('neutral');
    expect(temperature('#808080')).toBe('neutral');
  });

  it('[A-T2] uppercase hex parses the same as lowercase (parseInt is case-insensitive)', () => {
    expect(temperature('#FF9E64')).toBe(temperature('#ff9e64'));
    expect(temperature('#FF9E64')).toBe('warm'); // coffee orange
  });

  it('[A-T3] the 80 degree warm/cool cutoff: just-warmer is warm, just-cooler is cool', () => {
    // #b0ff00 ~ hue 78.6 sits just warm; #a0ff00 ~ hue 82.4 sits just cool — the cutoff lands in
    // the yellow-green, consistent with groceries (#9ece6a, hue ~89 = cool).
    expect(temperature('#b0ff00')).toBe('warm');
    expect(temperature('#a0ff00')).toBe('cool');
  });

  it('[A-T4] the 330 degree magenta boundary: warm side (>=330) vs cool side (<330)', () => {
    // #ff0080 is hue ~329.9 → just under 330 → classified COOL (documented edge; see critique).
    // #ff0090 is hue ~326 → cool. A palette pink like health (#ff75a0, hue ~341) stays warm.
    expect(temperature('#ff75a0')).toBe('warm');
    expect(temperature('#ff0080')).toBe('cool'); // pins the current boundary behaviour
  });

  it('[A-T5] a WHIT-320 darkened sibling still classifies on the correct side of its base', () => {
    // eatingout sibling #bc3349 (darkened rose) must read warm like its base #e5495f, or the ring
    // would sort a user-overflow eatingout the wrong way. pets sibling #977aca stays cool.
    expect(temperature('#bc3349')).toBe('warm');
    expect(temperature('#977aca')).toBe('cool');
  });

  it('[A-T6] a malformed hex does not throw (falls through to a definite class)', () => {
    // Production only ever feeds valid 6-digit hex (CATEGORY_BASE/SIBLINGS/OTHER), so this is a
    // no-crash guard, not a correctness claim — NaN math currently resolves to "cool".
    expect(() => temperature('#zzzzzz')).not.toThrow();
    expect(['warm', 'cool', 'neutral']).toContain(temperature('#zzzzzz'));
  });
});

describe('arrangeByTemperature — degenerate inputs (gaps)', () => {
  it('[A-A1] an empty array yields an empty array (no crash)', () => {
    expect(arrangeByTemperature([])).toEqual([]);
  });

  it('[A-A2] a single slice is returned unchanged', () => {
    const one = [slice('coffee', '#ff9e64')];
    expect(arrangeByTemperature(one)).toEqual(one);
  });

  it('[A-A3] all-warm (no cool to interleave) preserves order and every slice', () => {
    const input = [slice('coffee', '#ff9e64'), slice('eatingout', '#e5495f'), slice('health', '#ff75a0')];
    const out = arrangeByTemperature(input);
    expect(temps(out)).toEqual(['warm', 'warm', 'warm']);
    expect(ids(out)).toEqual(['coffee', 'eatingout', 'health']); // stable, no dropped/duped slice
  });

  it('[A-A4] all-cool preserves order and every slice', () => {
    const input = [slice('transport', '#7aa2f7'), slice('shopping', '#73daca'), slice('pets', '#bb9af7')];
    const out = arrangeByTemperature(input);
    expect(temps(out)).toEqual(['cool', 'cool', 'cool']);
    expect(ids(out)).toEqual(['transport', 'shopping', 'pets']);
  });

  it('[A-A5] only the neutral Other slice → returned as the sole (last) slice', () => {
    const out = arrangeByTemperature([slice('__other__', '#565f89', 40)]);
    expect(ids(out)).toEqual(['__other__']);
  });

  it('[A-A6] two neutral slices are both kept, at the end', () => {
    const input = [slice('__other__', '#565f89', 40), slice('greyish', '#606060', 10)];
    const out = arrangeByTemperature(input);
    expect(temps(out)).toEqual(['neutral', 'neutral']);
    expect(ids(out).sort()).toEqual(['__other__', 'greyish']);
  });

  it('[A-A7] a very warm-heavy 5w/1c set keeps all six and wedges the lone cool at index 1', () => {
    const input = [
      slice('coffee', '#ff9e64'), slice('eatingout', '#e5495f'), slice('health', '#ff75a0'),
      slice('utilities', '#e0af68'), slice('gifts-w', '#ff8040'), slice('transport', '#7aa2f7'),
    ];
    const out = arrangeByTemperature(input);
    expect(out).toHaveLength(6); // nothing dropped or duplicated
    expect(ids(out).sort()).toEqual(input.map((s) => s.id).sort());
    // The single cool is spread in right after the first warm (interleave from the larger group).
    expect(temperature(out[1].color)).toBe('cool');
  });
});

describe('SpendingDonut — the reorder is really wired in (integration)', () => {
  // Values are strictly descending so reduceSlices alone would paint them warm-clustered:
  // [health, eatingout, coffee, shopping, transport, pets]. arrangeByTemperature must interleave
  // them to [health, shopping, eatingout, transport, coffee, pets]. If the arrange call were
  // dropped from SpendingDonut, the DOM order would fall back to the clustered order → this fails.
  const WARM_CLUSTERED: DonutSlice[] = [
    slice('health', '#ff75a0', 100),
    slice('eatingout', '#e5495f', 90),
    slice('coffee', '#ff9e64', 80),
    slice('shopping', '#73daca', 70),
    slice('transport', '#7aa2f7', 60),
    slice('pets', '#bb9af7', 50),
  ];

  it('[A-I1] paints wedges in the alternated order, not the value-sorted order', () => {
    render(<SpendingDonut slices={WARM_CLUSTERED} />);
    // Exactly the order arrangeByTemperature(reduceSlices(...)) produces.
    expect(paintedOrder()).toEqual(['health', 'shopping', 'eatingout', 'transport', 'coffee', 'pets']);
    // Warm/cool truly alternate around the ring (the whole point of the card).
    expect(paintedOrder().map((id) => temperature(WARM_CLUSTERED.find((s) => s.id === id)!.color)))
      .toEqual(['warm', 'cool', 'warm', 'cool', 'warm', 'cool']);
  });

  it('[A-I2] every input category still appears as a wedge — none dropped by the reorder', () => {
    render(<SpendingDonut slices={WARM_CLUSTERED} />);
    expect(paintedOrder().sort()).toEqual(WARM_CLUSTERED.map((s) => s.id).sort());
  });

  it('[A-I3] selection + centre readout still resolve the right slice after the reorder', () => {
    render(<SpendingDonut slices={WARM_CLUSTERED} />);
    // eatingout is painted at index 2 after the reorder — tapping it must still read ITS total.
    fireEvent.press(screen.getByTestId('donut-slice-eatingout'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$90');
    expect(screen.getByText('eatingout')).toBeTruthy();
  });

  it('[A-I5] the spoken a11y summary stays largest-first, even though the ring alternates', () => {
    // The RING alternates (painted order [health, shopping, eatingout, transport, coffee, pets]),
    // but the accessibility summary should read largest-first to match the category rows: eatingout
    // ($90) is spoken before shopping ($70). If the summary used the painted order it would flip.
    render(<SpendingDonut slices={WARM_CLUSTERED} testID="donut-summary" />);
    const label = String(screen.getByTestId('donut-summary').props.accessibilityLabel);
    expect(label.indexOf('eatingout')).toBeLessThan(label.indexOf('shopping'));
  });

  it('[A-I4] the grey Other slice sorts to the last wedge after folding', () => {
    // 7 inputs → reduceSlices folds the tail into __other__; arrangeByTemperature must place the
    // neutral slice last regardless of its value.
    const many: DonutSlice[] = [
      slice('health', '#ff75a0', 100), slice('shopping', '#73daca', 90),
      slice('eatingout', '#e5495f', 80), slice('transport', '#7aa2f7', 70),
      slice('coffee', '#ff9e64', 60), slice('a', '#7dcfff', 50), slice('b', '#9d7cd8', 40),
    ];
    render(<SpendingDonut slices={many} />);
    const order = paintedOrder();
    expect(order[order.length - 1]).toBe('__other__');
  });
});
