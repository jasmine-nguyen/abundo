// WHIT-239 GAP (host regression) — the categorise sheet's inline-create form now renders its parent
// picker via the shared CategoryFields (parentPicker). The implementer's pickerSheetInlineCreate suite
// only ever creates a TOP-LEVEL category (asserts parent:null) — it never nests the new one. This
// proves the sheet's draft still carries a PICKED parent all the way into createCategoryInline through
// the real Overlays host. Fail-on-revert: unwire the parent picker (or the draft's parent) → parent:null.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, Category } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const NEW_CAT: Category = { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'coffee', color: '#fff', recent: 0, parent: 'coffee' };
const fns = {
  createCategoryInline: jest.fn(async (_form: unknown) => NEW_CAT as Category | null),
  chooseCategory: jest.fn(),
  setSheet: jest.fn(),
  dismissNotif: jest.fn(),
};

function pickerState(): AppContext {
  return {
    sheet: { mode: 'picker', txId: 't1' },
    toast: null,
    notif: null,
    transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' }],
    // One same-bucket (Lifestyle) category, so it is offered as an eligible parent in the picker.
    categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0, parent: null }],
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => { fns.createCategoryInline.mockClear(); fns.chooseCategory.mockClear(); });

it('nesting the new category under a picked parent carries that parent into createCategoryInline', async () => {
  mockState = pickerState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('pickerNewCategory'));
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
  // The inline form's parent picker (initialBucket Lifestyle) offers the same-bucket 'Coffee'. Pick it.
  fireEvent.press(screen.getByText('Coffee'));
  await act(async () => { fireEvent.press(screen.getByText('Create & file')); });

  expect(fns.createCategoryInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gym', bucket: 'Lifestyle', parent: 'coffee' }));
});
