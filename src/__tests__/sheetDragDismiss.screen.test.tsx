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

// A slow drag from y=100 down to y=100+distance (timestamps far apart → negligible velocity, so
// the DISTANCE path decides). Raw responder events, no gesture library.
function dragGrabber(distance: number) {
  const grabber = screen.getByTestId('sheet-grabber');
  fireEvent(grabber, 'responderGrant', { nativeEvent: { pageY: 100, timestamp: 0 } });
  fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 100 + distance, timestamp: 400 } });
  fireEvent(grabber, 'responderRelease', { nativeEvent: { pageY: 100 + distance, timestamp: 400 } });
}

// A quick short flick: a small total distance but a fast last segment (18px in 8ms ≈ 2.25 px/ms).
function flickGrabber() {
  const grabber = screen.getByTestId('sheet-grabber');
  fireEvent(grabber, 'responderGrant', { nativeEvent: { pageY: 100, timestamp: 0 } });
  fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 118, timestamp: 8 } });
  fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 136, timestamp: 16 } });
  fireEvent(grabber, 'responderRelease', { nativeEvent: { pageY: 138, timestamp: 18 } }); // dy=38 (< distance)
}

describe('shouldDismissSheet decision (WHIT-290/WHIT-293)', () => {
  // Pure decision behind the drag; lives in the screen project because sheetMotion imports
  // Animated (the logic project can't load react-native).
  it('dismisses a far-enough pull, springs back under it, ignores upward drags', () => {
    expect(shouldDismissSheet(SHEET_DISMISS_DISTANCE + 1, 0)).toBe(true);
    expect(shouldDismissSheet(SHEET_DISMISS_DISTANCE, 0)).toBe(false);
    expect(shouldDismissSheet(0, 0)).toBe(false);
    expect(shouldDismissSheet(-200, 0)).toBe(false);
  });

  it('dismisses a quick downward flick even when the pull is short (WHIT-293)', () => {
    expect(shouldDismissSheet(24, 1.0)).toBe(true);   // short but fast → dismiss
    expect(shouldDismissSheet(24, 0.1)).toBe(false);  // short and slow → spring back
    expect(shouldDismissSheet(-24, 2.0)).toBe(false); // fast but UPWARD → never dismiss
  });
});

describe('grabber pull-down-to-dismiss (WHIT-290/WHIT-293)', () => {
  it('a drag past the threshold closes the sheet', () => {
    mockState = sheetState();
    render(<Overlays />);
    dragGrabber(SHEET_DISMISS_DISTANCE + 40);
    expect(fns.setSheet).toHaveBeenCalledWith(null);
  });

  it('a short, slow drag springs back and does NOT close', () => {
    mockState = sheetState();
    render(<Overlays />);
    dragGrabber(20);
    expect(fns.setSheet).not.toHaveBeenCalled();
  });

  it('a quick short flick closes the sheet (WHIT-293)', () => {
    mockState = sheetState();
    render(<Overlays />);
    flickGrabber();
    expect(fns.setSheet).toHaveBeenCalledWith(null);
  });
});
