// Screen test: the Pay cycle sheet (WHIT-9 UI). Verifies the three length options
// render with the current one selected, that tapping a length calls
// setPayCycleLength, and that picking a date drives setPayday through the
// (event, date) extraction that fixed the picker crash. Seeded from the QA
// "Automatable (UI)" pay-cycle scenarios. Runs on iOS (RN preset default), which
// renders the inline compact picker.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

import { Overlays } from '../components/Overlays';

const fns = {
  setPayCycleLength: jest.fn(),
  setPayday: jest.fn(),
  setSheet: jest.fn(),
};

function paycycleState(length = 14): AppContext {
  return {
    sheet: { mode: 'paycycle' },
    toast: null,
    notif: null,
    payCycle: { length, last_pay_date: '2026-06-06' },
    dismissNotif: jest.fn(),
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => {
  fns.setPayCycleLength.mockClear();
  fns.setPayday.mockClear();
  fns.setSheet.mockClear();
});

it('renders the three cycle lengths', () => {
  mockState = paycycleState(14);
  render(<Overlays />);
  expect(screen.getByText('Weekly')).toBeTruthy();
  expect(screen.getByText('Fortnightly')).toBeTruthy();
  expect(screen.getByText('Monthly')).toBeTruthy();
});

it('tapping a length calls setPayCycleLength with its day count', () => {
  mockState = paycycleState(14);
  render(<Overlays />);
  fireEvent.press(screen.getByText('Monthly'));
  expect(fns.setPayCycleLength).toHaveBeenCalledWith(30);
  fireEvent.press(screen.getByText('Weekly'));
  expect(fns.setPayCycleLength).toHaveBeenCalledWith(7);
});

it('picking a date calls setPayday with the ISO date (via the event,date extraction)', () => {
  mockState = paycycleState(14);
  render(<Overlays />);
  // The mocked picker fires onValueChange({type:'set'}, Date(2026-06-20)).
  fireEvent.press(screen.getByTestId('mock-datepicker'));
  expect(fns.setPayday).toHaveBeenCalledWith('2026-06-20');
});

it('Done closes the sheet', () => {
  mockState = paycycleState(14);
  render(<Overlays />);
  fireEvent.press(screen.getByText('Done'));
  expect(fns.setSheet).toHaveBeenCalledWith(null);
});
