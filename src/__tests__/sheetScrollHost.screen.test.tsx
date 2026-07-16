// WHIT-288 — the pop-up SheetHost no longer wraps its scrolling content in a Pressable.
// The old backdrop-as-wrapper (a Pressable AROUND the sheet + its ScrollView, there only to
// swallow taps so they didn't close the sheet) competed with the ScrollView for the touch, so
// the category picker scrolled only intermittently. The backdrop now sits BEHIND the sheet as
// a labelled sibling. The scroll gesture itself is device-specific and can't be exercised
// headlessly, so these lock the tap-to-close behaviour of the new structure (a distinct "Close"
// backdrop closes; taps on the list select a row and never leak to a close) — the "Close"
// backdrop is what the old wrapping structure lacked, so its absence is the fail-on-revert.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { ScrollView } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const CAT_A = { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 };
const CAT_B = { id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e0af68', bucket: 'Lifestyle', recent: 0 };

const fns = {
  chooseCategory: jest.fn(), createCategoryInline: jest.fn(), setSheet: jest.fn(),
  dismissNotif: jest.fn(), readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
};
beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

function pickerState(): AppContext {
  return {
    sheet: { mode: 'picker', txId: 't1' },
    transactions: [{ transaction_id: 't1', amount: -12.5, description: 'COLES', merchant_name: 'Coles' }],
    categories: [CAT_A, CAT_B], toast: null, notif: null, ...fns,
  } as unknown as AppContext;
}

describe('SheetHost tap-to-close via a backdrop behind the sheet (WHIT-288)', () => {
  it('a distinct labelled backdrop closes the sheet on tap', () => {
    // The old sheet had no such control — the whole card was the close-wrapper. Its presence is
    // the fail-on-revert: revert to the wrapping Pressable and this "Close" button disappears.
    mockState = pickerState();
    render(<Overlays />);
    fireEvent.press(screen.getByLabelText('Close'));
    expect(fns.setSheet).toHaveBeenCalledWith(null);
  });

  it('the tap-to-close backdrop does NOT wrap the scrolling list', () => {
    // The bug was the closing element wrapping the ScrollView. Lock the fix structurally: the
    // "Close" backdrop must have NO ScrollView in its subtree — it's a sibling behind the sheet,
    // not an ancestor of the list. Re-wrapping the list in a labelled Pressable (reintroducing
    // the exact bug) would put a ScrollView under this element and trip the assertion. (ScrollView
    // matches by type reference in this RN/RNTL; Pressable does not, so we anchor on the list.)
    mockState = pickerState();
    const { UNSAFE_getByType } = render(<Overlays />);
    expect(UNSAFE_getByType(ScrollView)).toBeTruthy(); // the picker list exists...
    const close = screen.getByLabelText('Close');
    expect(close.findAll((n) => n.type === ScrollView)).toHaveLength(0); // ...but not under the backdrop
  });

  it('tapping a category row selects it (list stays interactive)', () => {
    mockState = pickerState();
    render(<Overlays />);
    fireEvent.press(screen.getByText('Groceries'));
    expect(fns.chooseCategory).toHaveBeenCalledWith('groceries');
  });

  it('still renders the picker list', () => {
    mockState = pickerState();
    render(<Overlays />);
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.getByText('Coffee')).toBeTruthy();
  });
});
