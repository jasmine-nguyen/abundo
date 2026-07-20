// WHIT donut pop-out fix (branch claude/pie-shard-popup-clipping-rw7yek) — adversarial GAPS
// beyond the 12 existing tests in spendingDonut.screen.test.tsx. react-native-svg is stubbed to
// plain Views by jest.setup, so these assert only on observable structure (testID presence/
// counts), the hole readout text, and onPress toggle behaviour — never on transforms/geometry.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SpendingDonut, type DonutSlice } from '../components/SpendingDonut';

const TWO: DonutSlice[] = [
  { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
  { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
];

describe('SpendingDonut — overlay uniqueness & base interactivity (gaps)', () => {
  // [A-G1] While a wedge is selected there is EXACTLY ONE on-top overlay, the base wedge is not
  // duplicated by it, and the base wedge under the overlay still owns a live tap (toggles off).
  // Fail-on-revert: the donut-top count goes 1→0 if the inert-overlay hunk is reverted (the old
  // splice/reorder had no overlay). The base-stays-interactive half is a regression guard.
  it('[A-G1] one unique overlay (non-a11y), base slice not duplicated, base tap still fires under it', () => {
    render(<SpendingDonut slices={TWO} />);
    expect(screen.queryByTestId('donut-top')).toBeNull(); // nothing selected → no overlay

    fireEvent.press(screen.getByTestId('donut-slice-c'));

    expect(screen.getAllByTestId('donut-top')).toHaveLength(1);   // exactly one overlay copy
    expect(screen.getByTestId('donut-top').props.accessible).toBe(false); // base beneath owns a11y
    expect(screen.getAllByTestId('donut-slice-c')).toHaveLength(1); // overlay didn't clone the base id

    // The base wedge (beneath the overlay) is still a tap target: pressing it toggles off.
    fireEvent.press(screen.getByTestId('donut-slice-c'));
    expect(screen.queryByTestId('donut-center-amount')).toBeNull();
    expect(screen.queryByTestId('donut-top')).toBeNull();
  });

  // [A-G5] Tapping the on-top overlay ITSELF must deselect — the overlay sits over the popped wedge,
  // so it carries the same toggle rather than relying on the tap falling through to the base beneath.
  // Fail-on-revert: drop the overlay's onPress and tapping donut-top no longer clears → red.
  it('[A-G5] tapping the on-top overlay itself deselects (no reliance on tap fall-through)', () => {
    render(<SpendingDonut slices={TWO} />);
    fireEvent.press(screen.getByTestId('donut-slice-c'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$25');

    fireEvent.press(screen.getByTestId('donut-top')); // tap the top copy of the popped wedge
    expect(screen.queryByTestId('donut-center-amount')).toBeNull();
    expect(screen.queryByTestId('donut-top')).toBeNull();
  });

  // [A-G6] Direct A→B switch, THEN tap the overlay — it must deselect the NEWLY-selected wedge, not
  // resurrect the old one. Guards the overlay's onPress against a stale s.id: because the overlay is
  // keyed by a stable "__top__" and recomputed from the fresh selectedLayout each render, its toggle
  // must re-point to B after g→c. If the overlay bound its toggle to the first selection, tapping it
  // here would set selectedId back to 'g' (hole shows $75) instead of clearing — this test goes red.
  // (A-G2 only checks the hole readout re-targets, which reads state directly; A-G5 only taps after a
  // fresh select — neither exercises tap-the-overlay AFTER a direct switch.)
  it('[A-G6] tapping the overlay after a direct g→c switch deselects c (does not re-select g)', () => {
    render(<SpendingDonut slices={TWO} />);
    fireEvent.press(screen.getByTestId('donut-slice-g'));
    fireEvent.press(screen.getByTestId('donut-slice-c')); // direct switch g → c, no deselect between
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$25');

    fireEvent.press(screen.getByTestId('donut-top')); // tap the popped overlay (now over c)
    expect(screen.queryByTestId('donut-center-amount')).toBeNull(); // cleared, NOT re-showing $75
    expect(screen.queryByTestId('donut-top')).toBeNull();
    expect(screen.getByTestId('donut-center-total').props.children).toBe('$100'); // back to the default total-spent readout
  });

  // [A-G2] Switching the selection straight from one wedge to another (no deselect in between)
  // must leave exactly one overlay bound under the stable key "__top__" and re-point the hole
  // readout to the newly-tapped wedge. Fail-on-revert: donut-top disappears if the overlay hunk
  // is reverted, so the length-1 assertion goes red.
  it('[A-G2] switching selection keeps a single overlay and re-targets the hole readout', () => {
    render(<SpendingDonut slices={TWO} />);

    fireEvent.press(screen.getByTestId('donut-slice-g'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$75');

    fireEvent.press(screen.getByTestId('donut-slice-c')); // switch directly g → c
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$25');
    expect(screen.getByText('Coffee')).toBeTruthy();

    expect(screen.getAllByTestId('donut-top')).toHaveLength(1);       // no stale second overlay
    expect(screen.getAllByTestId('donut-slice-g')).toHaveLength(1);   // base wedges stable, single copies
    expect(screen.getAllByTestId('donut-slice-c')).toHaveLength(1);
  });
});

describe('SpendingDonut — single 100% slice (gaps)', () => {
  const SOLO: DonutSlice[] = [{ id: 'solo', name: 'Rent', color: '#7aa2f7', value: 100 }];

  // [A-G3] A lone slice renders its interactive donut-slice-<id> (drawn as a full Circle), can be
  // selected → shows its amount + name and gets the inert overlay, and toggles back off. The
  // "overlay appears for a selected single slice" half fails-on-revert (the old splice path drew
  // no overlay); the render+toggle half is a regression guard on the single-slice branch.
  it('[A-G3] renders donut-slice-<id>, selecting overlays + reads it, tapping again clears', () => {
    render(<SpendingDonut slices={SOLO} />);
    expect(screen.getByTestId('donut-slice-solo')).toBeTruthy();
    expect(screen.getByTestId('donut-center-total').props.children).toBe('$100');
    expect(screen.getByText('total spent')).toBeTruthy();
    expect(screen.queryByTestId('donut-top')).toBeNull();

    fireEvent.press(screen.getByTestId('donut-slice-solo'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$100');
    expect(screen.getByText('Rent')).toBeTruthy();
    expect(screen.getAllByTestId('donut-top')).toHaveLength(1); // single slice still gets one overlay

    fireEvent.press(screen.getByTestId('donut-slice-solo')); // toggle off
    expect(screen.queryByTestId('donut-center-amount')).toBeNull();
    expect(screen.queryByTestId('donut-top')).toBeNull();
  });
});

describe('SpendingDonut — "Other" grouping render count (gap, characterization)', () => {
  // [A-G4] Past the 6-slice cap, exactly one interactive node is drawn per PAINTED slice: the 5
  // largest plus the folded "Other" (id __other__) — and the folded-away ids are not drawn.
  // Characterization of reduceSlices ∘ render (reduceSlices is unchanged by this diff).
  it('[A-G4] seven inputs → six donut-slice nodes incl __other__, folded ids absent', () => {
    const many: DonutSlice[] = [
      { id: 'a', name: 'A', color: '#111', value: 100 },
      { id: 'b', name: 'B', color: '#222', value: 50 },
      { id: 'c', name: 'C', color: '#333', value: 30 },
      { id: 'd', name: 'D', color: '#444', value: 10 },
      { id: 'e', name: 'E', color: '#555', value: 5 },
      { id: 'f', name: 'F', color: '#666', value: 3 },
      { id: 'g', name: 'G', color: '#777', value: 2 },
    ];
    render(<SpendingDonut slices={many} />);
    expect(screen.getAllByTestId(/^donut-slice-/)).toHaveLength(6);
    expect(screen.getByTestId('donut-slice-__other__')).toBeTruthy();
    expect(screen.queryByTestId('donut-slice-f')).toBeNull(); // folded into Other
    expect(screen.queryByTestId('donut-slice-g')).toBeNull();
  });
});
