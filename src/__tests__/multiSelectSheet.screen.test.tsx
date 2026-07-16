// WHIT-291 — the picker/confirm sheets in their multi-select ('*Many') modes. The picker shows
// the selection COUNT (no single merchant/amount) and advances chooseCategory on a pick; the
// confirm files the whole captured set via applyCategoryToMany. Drives the real sheets through
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

const fns = {
  chooseCategory: jest.fn(), applyCategoryToMany: jest.fn(), createCategoryInline: jest.fn(),
  setSheet: jest.fn(), dismissNotif: jest.fn(), readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
};
beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

describe('multi-select picker (WHIT-291)', () => {
  it('pickerMany shows the selection count and advances chooseCategory on a pick', () => {
    mockState = {
      sheet: { mode: 'pickerMany', txIds: ['t1', 't2', 't3'] },
      transactions: [], categories: [CAT], toast: null, notif: null, ...fns,
    } as unknown as AppContext;
    render(<Overlays />);
    expect(screen.getByText('3 transactions')).toBeTruthy(); // count header, not a merchant/amount

    fireEvent.press(screen.getByText('Groceries'));
    expect(fns.chooseCategory).toHaveBeenCalledWith('groceries');
  });

  it('confirmMany files the whole captured set via applyCategoryToMany', () => {
    mockState = {
      sheet: { mode: 'confirmMany', txIds: ['t1', 't2', 't3'], categoryId: 'groceries' },
      transactions: [], categories: [CAT], toast: null, notif: null, ...fns,
    } as unknown as AppContext;
    render(<Overlays />);
    expect(screen.getByText('File 3 transactions')).toBeTruthy();

    fireEvent.press(screen.getByText('File 3 transactions'));
    expect(fns.applyCategoryToMany).toHaveBeenCalledTimes(1);
    expect(fns.applyCategoryToMany).toHaveBeenCalledWith(['t1', 't2', 't3'], 'groceries');
  });

  it('singular copy for a one-item selection', () => {
    mockState = {
      sheet: { mode: 'confirmMany', txIds: ['t1'], categoryId: 'groceries' },
      transactions: [], categories: [CAT], toast: null, notif: null, ...fns,
    } as unknown as AppContext;
    render(<Overlays />);
    expect(screen.getByText('File 1 transaction')).toBeTruthy(); // not "1 transactions"
  });
});
