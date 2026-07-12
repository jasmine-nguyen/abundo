// WHIT-255 — the shared native date field. Locks the drift-prone bits the four call-sites used
// to each own: the pick-vs-dismiss quirk (Android fires onChange on BOTH; commit only on a real
// Date), the iOS pill gate (loan shows it even when unset via alwaysShowPillIOS; goal only once
// set), the Clear affordance, and min/max forwarding.
//
// This file OVERRIDES the global datetimepicker mock (jest.setup.js always emits a Date, so it
// can't exercise the dismiss path). The override emits whatever mock* vars say and captures the
// last props, so a single test can drive a pick, a dismiss, and assert forwarded props.
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import React from 'react';
import { Platform } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockPickedDate: Date | undefined = new Date(2026, 5, 20); // 20 Jun 2026
let mockEventType = 'set';
let mockLastProps: Record<string, unknown> | null = null;

jest.mock('@react-native-community/datetimepicker', () => {
  const ReactLib = require('react');
  const { Pressable, Text } = require('react-native');
  const MockPicker = (props: any) => {
    mockLastProps = props;
    return ReactLib.createElement(
      Pressable,
      { testID: 'mock-datepicker', onPress: () => props.onChange && props.onChange({ type: mockEventType }, mockPickedDate) },
      ReactLib.createElement(Text, null, 'picker'),
    );
  };
  return { __esModule: true, default: MockPicker };
});

import { NativeDateField } from '../components/NativeDateField';

const ORIGINAL_OS = Platform.OS;

beforeEach(() => {
  mockPickedDate = new Date(2026, 5, 20);
  mockEventType = 'set';
  mockLastProps = null;
});
afterEach(() => { Platform.OS = ORIGINAL_OS; });

// Open the picker if there's a "Set date"/"Change" affordance (Android, or iOS-when-unset),
// then tap the picker itself.
function openAndTap() {
  const opens = screen.queryAllByTestId('date-open');
  if (opens.length) fireEvent.press(opens[opens.length - 1]);
  const pickers = screen.getAllByTestId('mock-datepicker');
  fireEvent.press(pickers[pickers.length - 1]);
}

describe('the pick / dismiss commit quirk', () => {
  it('a real pick commits the chosen ISO date', () => {
    const onChange = jest.fn();
    render(<NativeDateField value={null} onChange={onChange} />);
    openAndTap();
    expect(onChange).toHaveBeenCalledWith('2026-06-20');
  });

  it('a DISMISS (no date) does NOT commit — the load-bearing Android quirk', () => {
    mockPickedDate = undefined;
    mockEventType = 'dismissed';
    const onChange = jest.fn();
    render(<NativeDateField value={null} onChange={onChange} />);
    openAndTap();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('the iOS pill gate', () => {
  beforeEach(() => { Platform.OS = 'ios'; });

  it('without alwaysShowPillIOS, an UNSET field shows the affordance, not the pill', () => {
    render(<NativeDateField value={null} onChange={jest.fn()} />);
    expect(screen.queryByTestId('mock-datepicker')).toBeNull();
    expect(screen.getByTestId('date-open')).toBeTruthy();
  });

  it('with alwaysShowPillIOS, an UNSET field shows the pill immediately (the loan behaviour)', () => {
    render(<NativeDateField value={null} onChange={jest.fn()} alwaysShowPillIOS />);
    expect(screen.getByTestId('mock-datepicker')).toBeTruthy();
    expect(screen.queryByTestId('date-open')).toBeNull();
  });

  it('once a value is set, the pill shows even without alwaysShowPillIOS', () => {
    render(<NativeDateField value="2026-01-15" onChange={jest.fn()} />);
    expect(screen.getByTestId('mock-datepicker')).toBeTruthy();
  });
});

describe('Android', () => {
  beforeEach(() => { Platform.OS = 'android'; });

  it('shows the affordance and opens the below-row dialog on tap', () => {
    render(<NativeDateField value={null} onChange={jest.fn()} />);
    expect(screen.queryByTestId('mock-datepicker')).toBeNull(); // closed until opened
    fireEvent.press(screen.getByTestId('date-open'));
    expect(screen.getByTestId('mock-datepicker')).toBeTruthy();
  });
});

describe('the Clear affordance', () => {
  it('clearable + a value renders Clear; tapping it commits null', () => {
    const onChange = jest.fn();
    render(<NativeDateField value="2026-01-15" onChange={onChange} clearable />);
    fireEvent.press(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('no Clear affordance without the clearable prop', () => {
    render(<NativeDateField value="2026-01-15" onChange={jest.fn()} />);
    expect(screen.queryByText('Clear')).toBeNull();
  });
});

describe('min / max forwarding', () => {
  it('passes minimumDate and maximumDate through to the picker', () => {
    const min = new Date(2026, 0, 1);
    const max = new Date(2026, 11, 31);
    render(<NativeDateField value="2026-06-01" onChange={jest.fn()} minimumDate={min} maximumDate={max} />);
    expect(mockLastProps?.minimumDate).toBe(min);
    expect(mockLastProps?.maximumDate).toBe(max);
  });
});
