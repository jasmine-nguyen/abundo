// WHIT-290 — the grabber wires drag-to-dismiss on the shared SheetHost. These drive the raw
// responder handlers with synthetic pageY events (RN's responder system, no gesture library),
// proving a drag PAST the threshold closes the sheet and a SHORT drag does not. The visual
// follow-the-finger + spring-back is device-verified; the close DECISION is proven here.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { SHEET_DISMISS_DISTANCE, shouldDismissSheet } from '../motion/sheetMotion';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const fns = {
  setSheet: jest.fn(), setPayCycleLength: jest.fn(), setPayday: jest.fn(), dismissNotif: jest.fn(),
};
beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

// The pay-cycle sheet is the simplest to mount (no category/query plumbing).
function sheetState(): AppContext {
  return {
    sheet: { mode: 'paycycle' }, toast: null, notif: null,
    payCycle: { length: 14, last_pay_date: '2026-06-06' }, ...fns,
  } as unknown as AppContext;
}

// Drive a grabber drag from y=100 down to y=100+distance via the raw responder handlers.
function dragGrabber(distance: number) {
  const grabber = screen.getByTestId('sheet-grabber');
  fireEvent(grabber, 'responderGrant', { nativeEvent: { pageY: 100 } });
  fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 100 + distance } });
  fireEvent(grabber, 'responderRelease', { nativeEvent: { pageY: 100 + distance } });
}

describe('shouldDismissSheet threshold (WHIT-290)', () => {
  // Pure decision behind the drag; lives in the screen project because sheetMotion imports
  // Animated (the logic project can't load react-native).
  it('dismisses past the threshold, springs back at/under it, ignores upward drags', () => {
    expect(shouldDismissSheet(SHEET_DISMISS_DISTANCE + 1)).toBe(true);
    expect(shouldDismissSheet(SHEET_DISMISS_DISTANCE)).toBe(false);
    expect(shouldDismissSheet(0)).toBe(false);
    expect(shouldDismissSheet(-200)).toBe(false);
  });
});

describe('grabber pull-down-to-dismiss (WHIT-290)', () => {
  it('a drag past the threshold closes the sheet', () => {
    mockState = sheetState();
    render(<Overlays />);
    dragGrabber(SHEET_DISMISS_DISTANCE + 40);
    expect(fns.setSheet).toHaveBeenCalledWith(null);
  });

  it('a short drag springs back and does NOT close', () => {
    mockState = sheetState();
    render(<Overlays />);
    dragGrabber(20);
    expect(fns.setSheet).not.toHaveBeenCalled();
  });
});
