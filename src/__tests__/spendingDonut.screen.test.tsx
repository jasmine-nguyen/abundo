// The spending pie/donut on the Insights tab: the pure slice-reduction (top-N + grouped
// "Other") and the rendered chart (leading category in the hole, empty when nothing spent).
// react-native-svg is stubbed to plain Views by jest.setup, so we assert on the labels/roles
// the chart carries, not on drawn paths.
import { describe, it, expect } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { SpendingDonut, reduceSlices, type DonutSlice } from '../components/SpendingDonut';

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

  it('highlights the leading category share in the hole', () => {
    render(<SpendingDonut slices={[{ id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 }, { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 }]} />);
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('top category')).toBeTruthy();
  });

  it('gives the chart an accessible summary of each slice', () => {
    render(<SpendingDonut slices={[{ id: 'g', name: 'Groceries', color: '#7FD49B', value: 75 }, { id: 'c', name: 'Coffee', color: '#E8A87C', value: 25 }]} testID="donut" />);
    const node = screen.getByTestId('donut');
    expect(node.props.accessibilityLabel).toContain('Groceries 75 percent');
    expect(node.props.accessibilityLabel).toContain('Coffee 25 percent');
  });
});
