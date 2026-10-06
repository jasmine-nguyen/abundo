// WHIT-759 (QA) — the fixed fades through the REAL component, across the whole shipped palette,
// and with the grey "Other" as the selected slice.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut } from '../components/SpendingDonut';
import { CATEGORY_COLORS } from '../chartColors';
import { C } from '../theme';
import { opacityOf, sl, slice, DIM_CATEGORY, DIM_OTHER } from './support/donut';

describe('SpendingDonut — every shipped colour fades to the category value', () => {
  // [A4] All 20 ramp colours plus the Uncategorized purple, rendered as unselected peers. The cap
  // is 6 painted wedges, so go through the palette 5 peers at a time beside one picked wedge.
  // FAIL-ON-REVERT: any per-colour fade (or a lookup that misses an entry) moves a peer off 0.55.
  const colors: string[] = [...CATEGORY_COLORS, C.purple];
  const chunks = [0, 5, 10, 15, 20].map((start) => [start, colors.slice(start, start + 5)] as const);
  it.each(chunks)('[A4] non-grey slice colours from #%i, unselected, land on 0.55', (start, chunk) => {
    const peers = chunk.map((color, i) => slice(`p${start + i}`, color, 50 - i));
    render(<SpendingDonut slices={[sl('pick', 100), ...peers]} />);
    fireEvent.press(screen.getByTestId('donut-slice-pick'));
    for (const peer of peers) expect(opacityOf(peer.id)).toBeCloseTo(DIM_CATEGORY, 3);
  });
});

describe('SpendingDonut — selecting the grey "Other" itself', () => {
  // [A5] With the bucket picked, its own fade must not leak onto the category peers, and the
  // hole reset brings everything back.
  it('[A5] tapping "Other" fades every category to 0.55 and keeps Other at 1; reset restores all', () => {
    const seven = [sl('a', 100), sl('b', 90), sl('c', 80), sl('d', 70), sl('e', 60), sl('f', 50), sl('g', 40)];
    render(<SpendingDonut slices={seven} />);

    fireEvent.press(screen.getByTestId('donut-slice-__other__'));
    expect(opacityOf('__other__')).toBeCloseTo(1);
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(opacityOf(id)).toBeCloseTo(DIM_CATEGORY, 3);

    fireEvent.press(screen.getByTestId('donut-center-reset'));
    for (const id of ['a', 'b', 'c', 'd', 'e', '__other__']) expect(opacityOf(id)).toBeCloseTo(1);

    fireEvent.press(screen.getByTestId('donut-slice-c'));
    expect(opacityOf('__other__')).toBeCloseTo(DIM_OTHER, 3);
  });
});
