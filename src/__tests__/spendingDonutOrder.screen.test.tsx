// WHIT-403 — the donut's slice ORDER, after the warm/cool re-shuffle was deleted. Ring order is now
// exactly reduceSlices' output: spend descending, with the folded "Other" appended after the sort.
// This file carries forward the integration guarantees that survived the deleted
// spendingDonutTemperatureEdges suite (nothing dropped, selection + centre readout, Other last,
// a11y summary order) and re-points its order assertion at the new contract.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// Reduce-motion ON so the emphasis springs settle synchronously (matches the other donut screen
// suites) — no animation to await for the selection assertions below.
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';
import { paintedOrder } from './support/donut';

const slice = (id: string, color: string, value: number): DonutSlice => ({ id, name: id, color, value });

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
