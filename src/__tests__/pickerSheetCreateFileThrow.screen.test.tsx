// WHIT-249 — [A-createfile] the picker sheet's inline "Create & file" button re-enables after an
// UNEXPECTED createCategoryInline throw. Gap: the WHIT-249 caller re-enable pattern is tested for
// goal/budget/category screens, but NOT for Overlays.createAndFile — whose visible flag is
// `submitting`, OWNED by PickerSheet and passed as `busy` into QuickCreateCategory (so a stuck
// flag disables the button from a DIFFERENT component). The handler now resets `submitting` in a
// catch and re-throws; the re-throw is caught+logged by QuickCreateCategory's own useInFlightGuard
// (createAndFile is not directly wrapped — it's the onSubmit that runSubmit awaits).
// Fail-on-revert: drop the catch in src/components/Overlays.tsx createAndFile → `submitting` stays
// true after the throw → `busy` keeps the button disabled (`canSave` false) → press #2 early-
// returns in QuickCreateCategory.submit → createCategoryInline called ONCE → this reddens.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
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

beforeEach(() => {
  fns.createCategoryInline.mockClear();
  fns.createCategoryInline.mockImplementation(async () => NEW_CAT as Category | null);
  fns.chooseCategory.mockClear();
});

// Restore any per-test console.error spy even if a test fails mid-body (targets console.error
// only, so jest.setup's console.warn silence stays intact).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

// [A-createfile] The inline create throws on the first press. The button (gated by PickerSheet's
// `submitting` → QuickCreateCategory `busy`) must re-enable so a retry creates + files.
it('re-enables Create & file so a retry runs after createCategoryInline throws', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  fns.createCategoryInline.mockRejectedValueOnce(new Error('network blew up')); // 1st press throws
  mockState = pickerState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('pickerNewCategory'));
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');

  await act(async () => { fireEvent.press(screen.getByText('Create & file')); }); // throws → guard logs, submitting reset
  await act(async () => { fireEvent.press(screen.getByText('Create & file')); }); // only fires if re-enabled

  // Called TWICE = `submitting` was reset (else `busy` keeps the button disabled and press #2 no-ops).
  expect(fns.createCategoryInline).toHaveBeenCalledTimes(2);
  // The retry succeeded → the transaction is filed into the freshly-created category.
  await waitFor(() => expect(fns.chooseCategory).toHaveBeenCalledWith('gym'));
  expect(errorSpy).toHaveBeenCalled(); // the guard logged the escaped throw (WHIT-249 contract)
});
