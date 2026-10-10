// WHIT-397 — the shared SegmentedControl (extracted from the two Insights toggles). Locks the
// contract both call sites depend on: options render by label + testID, exactly one segment reads
// as selected, a tap fires onChange with that option's value (numeric AND string, to exercise the
// generic), and the active segment carries its passed-in tint + text colour. The screen suites
// (insightsCycleToggle / insightsSideToggle) prove the two real toggles still behave; this proves
// the component in isolation.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react-native';
import { SegmentedControl } from '../components/SegmentedControl';
import { C, tint } from '../theme';
import { hostParent, styleOf } from './support/layout';

// Synthetic colours on purpose (WHIT-398): these are fixtures for the generic component, not
// production values, so they must not read as a second copy of a real theme colour.
const NUM_OPTIONS = [
  { value: 0, label: 'This cycle', testID: 'seg-current', activeTint: 'rgba(7,8,9,.16)', activeTextColor: '#9db3f9' },
  { value: 1, label: 'Last cycle', testID: 'seg-prev', activeTint: 'rgba(7,8,9,.16)', activeTextColor: '#9db3f9' },
];
const STR_OPTIONS = [
  { value: 'spending' as const, label: 'Spending', testID: 'seg-spending', activeTint: 'rgba(1,2,3,.16)', activeTextColor: '#f7768e' },
  { value: 'earning' as const, label: 'Earning', testID: 'seg-earning', activeTint: 'rgba(4,5,6,.16)', activeTextColor: '#2ac3de' },
];

describe('SegmentedControl', () => {
  it('renders every option by label and testID', () => {
    render(<SegmentedControl value={0} onChange={jest.fn()} options={NUM_OPTIONS} />);
    expect(screen.getByText('This cycle')).toBeTruthy();
    expect(screen.getByText('Last cycle')).toBeTruthy();
    expect(screen.getByTestId('seg-current')).toBeTruthy();
    expect(screen.getByTestId('seg-prev')).toBeTruthy();
  });

  it('marks exactly the selected option as selected', () => {
    render(<SegmentedControl value={1} onChange={jest.fn()} options={NUM_OPTIONS} />);
    expect(screen.getByTestId('seg-current').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('seg-prev').props.accessibilityState.selected).toBe(true);
  });

  it('fires onChange with the tapped option value (number)', () => {
    const onChange = jest.fn();
    render(<SegmentedControl value={0} onChange={onChange} options={NUM_OPTIONS} />);
    fireEvent.press(screen.getByTestId('seg-prev'));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('fires onChange with the tapped option value (string union)', () => {
    const onChange = jest.fn();
    render(<SegmentedControl value="spending" onChange={onChange} options={STR_OPTIONS} />);
    fireEvent.press(screen.getByTestId('seg-earning'));
    expect(onChange).toHaveBeenCalledWith('earning');
  });

  it('applies the active tint + text colour only to the selected segment', () => {
    render(<SegmentedControl value="earning" onChange={jest.fn()} options={STR_OPTIONS} />);
    // active segment: earning → its tint + teal bold text
    expect(styleOf(screen.getByTestId('seg-earning')).backgroundColor).toBe('rgba(4,5,6,.16)');
    expect(styleOf(screen.getByText('Earning'))).toMatchObject({ color: '#2ac3de', fontWeight: '700' });
    // inactive segment: no active tint, muted default weight
    expect(styleOf(screen.getByTestId('seg-spending')).backgroundColor).toBeUndefined();
    expect(styleOf(screen.getByText('Spending')).fontWeight).toBe('600');
  });
});

// WHIT-846: the optional count bubble and per-segment width the Transactions tabs use.
describe('SegmentedControl count bubble and width', () => {
  const BADGED = [{ ...STR_OPTIONS[0], flex: 1.45, badge: 0 }, STR_OPTIONS[1]];

  // [A2] a rose bubble, the same whether its segment is selected or not; a zero count still shows.
  it.each(['spending', 'earning'] as const)('the bubble is rose with %s selected', (value) => {
    render(<SegmentedControl value={value} onChange={jest.fn()} options={BADGED} />);
    const count = within(screen.getByTestId('seg-spending')).getByText('0');
    expect(styleOf(count)).toMatchObject({ color: C.badBright, fontWeight: '700' });
    expect(styleOf(hostParent(count)).backgroundColor).toBe(tint(C.bad, 0.2));
  });

  // [A3] no badge → no bubble; flex defaults to 1 so the Insights toggles stay even.
  it('draws no bubble without a badge and defaults a segment to flex 1', () => {
    render(<SegmentedControl value="earning" onChange={jest.fn()} options={BADGED} />);
    expect(within(screen.getByTestId('seg-earning')).queryAllByText(/\d/)).toHaveLength(0);
    expect(styleOf(screen.getByTestId('seg-earning')).flex).toBe(1);
    expect(styleOf(screen.getByTestId('seg-spending')).flex).toBe(1.45);
  });
});
