// WHIT-287 — the confirm step of a re-categorise opened from a transaction's DETAIL screen.
// A detail re-file sets `refileOnly` on the sheet, which collapses the confirm to a single
// "File as X" action (applyCategory('one')) with NO merchant-wide rule sweep. The list flow
// (refileOnly absent) still shows both "All from this merchant" and "Just this one". These
// drive the real ConfirmSheet through <Overlays/> with a mocked context, mirroring
// incomeCategoryInteraction.screen.test.tsx.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const CAT = { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 };
const TX = { transaction_id: 't1', amount: -12.5, description: 'COLES', merchant_name: 'Coles' };

const fns = {
  applyCategory: jest.fn(), chooseCategory: jest.fn(), setSheet: jest.fn(),
  dismissNotif: jest.fn(), readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
};
beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

function confirmState(refileOnly: boolean): AppContext {
  return {
    sheet: { mode: 'confirm', txId: 't1', categoryId: 'groceries', refileOnly },
    transactions: [TX], categories: [CAT], toast: null, notif: null, ...fns,
  } as unknown as AppContext;
}

describe('refileOnly confirm (detail-screen re-categorise)', () => {
  it('offers only a single re-file — no merchant-wide rule option', () => {
    mockState = confirmState(true);
    render(<Overlays />);
    expect(screen.getByText('File as Groceries')).toBeTruthy(); // the sheet title/heading
    expect(screen.getByText('Save')).toBeTruthy();              // the single CTA
    expect(screen.queryByText('All from this merchant')).toBeNull();
    expect(screen.queryByText('Just this one')).toBeNull();
  });

  it('the single button re-files just this transaction (applyCategory("one"))', () => {
    mockState = confirmState(true);
    render(<Overlays />);
    fireEvent.press(screen.getByText('Save'));
    expect(fns.applyCategory).toHaveBeenCalledTimes(1);
    expect(fns.applyCategory).toHaveBeenCalledWith('one');
  });
});

describe('normal confirm (list-flow categorise) is unchanged', () => {
  it('still offers both the rule sweep and the single-file option', () => {
    mockState = confirmState(false);
    render(<Overlays />);
    expect(screen.getByText('All from this merchant')).toBeTruthy();
    expect(screen.getByText('Just this one')).toBeTruthy();

    fireEvent.press(screen.getByText('All from this merchant'));
    expect(fns.applyCategory).toHaveBeenCalledWith('all');
    fireEvent.press(screen.getByText('Just this one'));
    expect(fns.applyCategory).toHaveBeenCalledWith('one');
  });
});
