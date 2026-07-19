// Category-name-keyboard-overlap — the categorise sheet's inline "New category" form auto-focuses
// its name field, so the keyboard is up the instant it opens and the keyboard-avoider lifts the whole
// sheet. On a shorter screen the form is taller than the room above the keyboard, so its top (the
// title + the Category name field) was pushed off-screen with no way to pull it back. The fix wraps
// the form in a scroller so every field stays reachable. The scroll itself is device-only; this locks
// the structure — the name field lives inside a ScrollView that keeps taps alive over the keyboard.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { ScrollView } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext, Category } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const fns = {
  createCategoryInline: jest.fn(async (_form: unknown) => null as Category | null),
  chooseCategory: jest.fn(),
  setSheet: jest.fn(),
  readSheetDraft: () => undefined,
  writeSheetDraft: () => {},
  dismissNotif: jest.fn(),
};

function pickerState(): AppContext {
  return {
    sheet: { mode: 'picker', txId: 't1' },
    toast: null,
    notif: null,
    transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' }],
    categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0, parent: null }],
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => { Object.values(fns).forEach((f) => typeof f === 'function' && (f as jest.Mock).mockClear?.()); });

// Fail-on-revert: drop the ScrollView wrapper (back to the plain <View>) and the name field is no
// longer inside any vertical scroller with keyboardShouldPersistTaps — both assertions below fail.
it('wraps the New-category form in a tap-persisting scroller so the name field stays reachable', () => {
  mockState = pickerState();
  const { UNSAFE_getAllByType } = render(<Overlays />);
  fireEvent.press(screen.getByTestId('pickerNewCategory'));

  // The scroller that owns the form: a ScrollView told to keep taps alive over the keyboard so a
  // chip/button lands on the first press (the horizontal icon strip does not set this).
  const formScroll = UNSAFE_getAllByType(ScrollView).find((sv) => sv.props.keyboardShouldPersistTaps === 'handled');
  expect(formScroll).toBeTruthy();

  // The Category name input must live INSIDE that scroller — that is what keeps it on-screen when the
  // keyboard lifts the sheet.
  const nameInput = screen.getByPlaceholderText('Category name');
  expect(formScroll!.findAll((n) => n === nameInput)).toHaveLength(1);
});
