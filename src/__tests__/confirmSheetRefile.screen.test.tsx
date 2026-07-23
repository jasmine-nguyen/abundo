// WHIT-324 — the confirm step of a re-categorise. Both entry points (the Transactions list AND
// a transaction's detail screen) now share ONE confirm: "All from this merchant" (a merchant-wide
// rule sweep) alongside "Just this one" (a single re-file). Pre-324 a detail re-file set a
// `refileOnly` flag that collapsed the confirm to a lone Save — that redundant special case is
// gone, so the two entry points behave identically. These drive the real ConfirmSheet through
// <Overlays/> with a mocked context, mirroring incomeCategoryInteraction.screen.test.tsx.
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

function confirmState(): AppContext {
  return {
    sheet: { mode: 'confirm', txId: 't1', categoryId: 'groceries' },
    transactions: [TX], categories: [CAT], toast: null, notif: null, ...fns,
  } as unknown as AppContext;
}

describe('confirm (re-categorise) — one flow for every entry point', () => {
  it('always offers BOTH the merchant-wide rule and the single-file option', () => {
    mockState = confirmState();
    render(<Overlays />);
    expect(screen.getByText('File as Groceries')).toBeTruthy(); // the sheet title/heading
    expect(screen.getByText('All from this merchant')).toBeTruthy();
    expect(screen.getByText('Just this one')).toBeTruthy();
    // The redundant lone "Save" is gone.
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('"All from this merchant" files the whole merchant (applyCategory("all"))', () => {
    mockState = confirmState();
    render(<Overlays />);
    fireEvent.press(screen.getByText('All from this merchant'));
    expect(fns.applyCategory).toHaveBeenCalledTimes(1);
    expect(fns.applyCategory).toHaveBeenCalledWith('all');
  });

  it('"Just this one" re-files only this transaction (applyCategory("one"))', () => {
    mockState = confirmState();
    render(<Overlays />);
    fireEvent.press(screen.getByText('Just this one'));
    expect(fns.applyCategory).toHaveBeenCalledTimes(1);
    expect(fns.applyCategory).toHaveBeenCalledWith('one');
  });
});
