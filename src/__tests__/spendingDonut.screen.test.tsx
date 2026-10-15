// The spending pie/donut on the Insights tab: the pure slice-reduction (top-N + grouped
// "Other") and the rendered chart (leading category in the hole, empty when nothing spent).
// react-native-svg is stubbed to plain Views by jest.setup, so we assert on the labels/roles
// the chart carries, not on drawn paths.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import './support/donut';
import { SpendingDonut, reduceSlices, type DonutSlice } from '../components/SpendingDonut';
import { HERO_BIG_MAX_SCALE } from '../hooks/useLargeText';

const s = (id: string, value: number): DonutSlice => ({ id, name: id, color: '#7aa2f7', value });

describe('reduceSlices', () => {
  it('keeps every positive slice, largest-first, when at or under the cap', () => {
    const out = reduceSlices([s('a', 10), s('c', 30), s('b', 20)], 6);
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('drops zero and negative slices', () => {
    const out = reduceSlices([s('a', 10), s('z', 0), s('n', -5)], 6);
    expect(out.map((x) => x.id)).toEqual(['a']);
  });

  it('folds the smaller tail into a single neutral "Other" slice past the cap', () => {
    const out = reduceSlices(
      [s('a', 100), s('b', 50), s('c', 30), s('d', 10), s('e', 5), s('f', 3), s('g', 2)],
      6,
    );
    // 5 largest kept (a–e), the rest (f+g = 5) summed into one Other slice at the end.
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd', 'e', '__other__']);
    const other = out[out.length - 1];
    expect(other.name).toBe('Other');
    expect(other.value).toBe(5);
  });

  it('does not emit an Other slice when the tail is all zero', () => {
    const out = reduceSlices([s('a', 5), s('b', 4), s('c', 3), s('d', 2), s('e', 1), s('z', 0)], 6);
    expect(out.some((x) => x.id === '__other__')).toBe(false);
  });
});

describe('SpendingDonut', () => {
  it('renders nothing when there is no positive spend', () => {
    const { toJSON } = render(<SpendingDonut slices={[s('a', 0)]} />);
    expect(toJSON()).toBeNull();
  });

  it('shows the biggest category and its share in the hole at rest, not the total again (ABU-63)', () => {
    render(<SpendingDonut slices={[{ id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 }, { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 }]} />);
    expect(screen.getByTestId('donut-center-top-share').props.children).toBe('75%');
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.queryByText('$100')).toBeNull();
    expect(screen.queryByText('total spent')).toBeNull();
  });

  it('gives the chart an accessible summary of each slice', () => {
    render(<SpendingDonut slices={[{ id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 }, { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 }]} testID="donut" />);
    const node = screen.getByTestId('donut');
    expect(node.props.accessibilityLabel).toContain('Groceries 75 percent');
    expect(node.props.accessibilityLabel).toContain('Coffee 25 percent');
  });

  const TWO = [
    { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
    { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
  ];

  it('tapping a wedge shows that category name + total in the hole', () => {
    render(<SpendingDonut slices={TWO} />);
    // Default: the biggest share, no category amount.
    expect(screen.getByTestId('donut-center-top-share').props.children).toBe('75%');
    expect(screen.queryByTestId('donut-center-amount')).toBeNull();

    fireEvent.press(screen.getByTestId('donut-slice-c')); // tap the smaller (non-leading) wedge
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$25');
    expect(screen.getByText('Coffee')).toBeTruthy();
    expect(screen.queryByTestId('donut-center-top-share')).toBeNull(); // default readout is replaced
  });

  it('tapping the selected wedge again clears back to the default readout', () => {
    render(<SpendingDonut slices={TWO} />);
    fireEvent.press(screen.getByTestId('donut-slice-g'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$75');

    fireEvent.press(screen.getByTestId('donut-slice-g')); // same wedge → toggle off
    expect(screen.queryByTestId('donut-center-amount')).toBeNull();
    expect(screen.getByTestId('donut-center-top-share').props.children).toBe('75%');
  });

  // [A5] ABU-63: the hole is a fixed size, so its readout (at rest and tapped) is one line and
  // stops growing at the hero cap.
  it('caps the centre readout so large text cannot overflow the hole', () => {
    render(<SpendingDonut slices={TWO} />);
    const capped = (node: { props: { numberOfLines?: number; maxFontSizeMultiplier?: number } }) =>
      expect([node.props.numberOfLines, node.props.maxFontSizeMultiplier]).toEqual([1, HERO_BIG_MAX_SCALE]);
    capped(screen.getByTestId('donut-center-top-share'));
    expect(screen.getByText('Groceries').props.maxFontSizeMultiplier).toBe(HERO_BIG_MAX_SCALE);
    fireEvent.press(screen.getByTestId('donut-slice-c'));
    capped(screen.getByTestId('donut-center-amount'));
    expect(screen.getByText('Coffee').props.maxFontSizeMultiplier).toBe(HERO_BIG_MAX_SCALE);
  });

  it('tapping the centre resets a selection back to the biggest-share readout', () => {
    render(<SpendingDonut slices={TWO} />);
    fireEvent.press(screen.getByTestId('donut-slice-c'));
    expect(screen.getByTestId('donut-center-amount').props.children).toBe('$25');

    fireEvent.press(screen.getByTestId('donut-center-reset')); // tap the hole → clear
    expect(screen.queryByTestId('donut-center-amount')).toBeNull();
    expect(screen.getByTestId('donut-center-top-share').props.children).toBe('75%');
    expect(screen.getByText('Groceries')).toBeTruthy();
  });

  // (The on-top overlay's structure + tap behaviour are pinned in the "overlay uniqueness" gaps
  // suites below.)
});
const TWO: DonutSlice[] = [
  { id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 },
  { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 },
];

describe('SpendingDonut — overlay uniqueness & base interactivity (gaps)', () => {
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
    expect(screen.getByTestId('donut-center-top-share').props.children).toBe('75%'); // back to the default biggest-share readout
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
    expect(screen.getByTestId('donut-center-top-share').props.children).toBe('100%');
    expect(screen.getByText('Rent')).toBeTruthy();
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
