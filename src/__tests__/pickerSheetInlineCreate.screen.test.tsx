// WHIT-238: create a category from the categorise sheet. Tapping "New category" swaps the
// list for an inline mini-form; on create the sheet files THIS transaction into the new one
// (chooseCategory advances to the confirm step) — no round-trip to Settings.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { AppContext, Category } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const NEW_CAT: Category = { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#fff', recent: 0, parent: null };
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
    categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0 }],
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => { fns.createCategoryInline.mockClear(); fns.chooseCategory.mockClear(); });

it('opens the inline create form from the picker', () => {
  mockState = pickerState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('pickerNewCategory'));
  expect(screen.getByPlaceholderText('Category name')).toBeTruthy();
  expect(screen.getByText('Create & file')).toBeTruthy();
});

it('creating files the transaction into the new category', async () => {
  mockState = pickerState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('pickerNewCategory'));
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
  await act(async () => { fireEvent.press(screen.getByText('Create & file')); });

  expect(fns.createCategoryInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gym', bucket: 'Lifestyle', parent: null }));
  // ...then files THIS transaction into the just-created category (advances to confirm).
  await waitFor(() => expect(fns.chooseCategory).toHaveBeenCalledWith('gym'));
});

it('does not file when creation fails (chooseCategory not called)', async () => {
  fns.createCategoryInline.mockResolvedValueOnce(null);
  mockState = pickerState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('pickerNewCategory'));
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
  await act(async () => { fireEvent.press(screen.getByText('Create & file')); });

  expect(fns.createCategoryInline).toHaveBeenCalled();
  expect(fns.chooseCategory).not.toHaveBeenCalled();
});
