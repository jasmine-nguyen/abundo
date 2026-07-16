// WHIT-294 — the pop-up SheetHost wraps its sheet in a KeyboardAvoidingView so a focused field's
// form (incl. its submit button) lifts above the keyboard instead of being hidden under it. The
// actual keyboard lift is device-only; this locks the structure (the sheet is inside a
// KeyboardAvoidingView with a real behavior) and that the sheet still renders + closes.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { KeyboardAvoidingView } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const fns = { setSheet: jest.fn(), setPayCycleLength: jest.fn(), setPayday: jest.fn(), dismissNotif: jest.fn() };
beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

function sheetState(): AppContext {
  return {
    sheet: { mode: 'paycycle' }, toast: null, notif: null,
    payCycle: { length: 14, last_pay_date: '2026-06-06' }, ...fns,
  } as unknown as AppContext;
}

describe('SheetHost lifts the sheet above the keyboard (WHIT-294)', () => {
  it('wraps the sheet in a KeyboardAvoidingView with a real behavior', () => {
    mockState = sheetState();
    const { UNSAFE_getByType } = render(<Overlays />);
    const kav = UNSAFE_getByType(KeyboardAvoidingView);
    expect(kav).toBeTruthy();
    expect(['padding', 'height', 'position']).toContain(kav.props.behavior); // set, not undefined
  });

  it('still renders the sheet content and closes on the backdrop', () => {
    mockState = sheetState();
    render(<Overlays />);
    expect(screen.getByText('Fortnightly')).toBeTruthy(); // sheet content mounted
    fireEvent.press(screen.getByLabelText('Close'));
    expect(fns.setSheet).toHaveBeenCalledWith(null);
  });
});
