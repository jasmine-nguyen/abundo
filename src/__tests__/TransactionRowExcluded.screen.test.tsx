// WHIT-298 — adversarial GAP tests for the "Not in budget" row tag. The implementer's
// TransactionRow.screen.test.tsx covers bank-excluded / user-excluded / normal. These add the
// combinations + surfaces that ship the same row: combined flags, income, uncategorized (still
// tappable), pending (both pills), SELECTION mode (the Transactions tab path), and the a11y label.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';
import type { Category } from '../context';

let mockState: { openPicker: typeof openPicker; category: (id: string | null) => Category | undefined };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

import { TransactionRow } from '../components/TransactionRow';

const openPicker = jest.fn();
function stateWith() {
  return { openPicker, category: makeState({ categories: [cat({ id: 'coffee', name: 'Cafes & Coffee', color: '#E8A87C' })] }).category };
}
beforeEach(() => { openPicker.mockClear(); mockPush.mockClear(); mockState = stateWith(); });

// [A-combo] both flags set → exactly ONE "Not in budget" tag, not two.
it('shows a single "Not in budget" tag when BOTH counts_to_budget false AND budget_excluded true', () => {
  render(<TransactionRow t={txn({ category: 'coffee', counts_to_budget: false, budget_excluded: true })} category={mockState.category} />);
  expect(screen.getAllByText('Not in budget')).toHaveLength(1);
});

// [A-income] an excluded income row shows the tag next to its Income label.
it('shows the tag on an excluded income row', () => {
  render(<TransactionRow t={txn({ category: 'income', amount: 2500, counts_to_budget: false })} category={mockState.category} />);
  expect(screen.getByText('Income')).toBeTruthy();
  expect(screen.getByText('Not in budget')).toBeTruthy();
});

// [A-uncat] WHIT-328 — a not-in-budget uncategorized row still LABELS itself Uncategorized
// (with the tag) but is a QUIET, non-tappable row: filing a transfer does nothing, so a tap
// must NOT open the categorize picker. Fail-on-revert: make the row tappable again → this fails.
it('a not-in-budget uncategorized row shows the tag + label but does NOT open the picker on tap', () => {
  render(<TransactionRow t={txn({ transaction_id: 'txU', category: null, counts_to_budget: false })} category={mockState.category} />);
  expect(screen.getByText('Not in budget')).toBeTruthy();
  fireEvent.press(screen.getByText('Uncategorized'));
  expect(openPicker).not.toHaveBeenCalled();
});

// [A-pending] pending + excluded → both the Pending and Not-in-budget pills render on one row.
it('shows both the Pending and Not-in-budget pills on an excluded pending row', () => {
  render(<TransactionRow t={txn({ category: 'coffee', status: 'pending', counts_to_budget: false })} category={mockState.category} />);
  expect(screen.getByText('Pending')).toBeTruthy();
  expect(screen.getByText('Not in budget')).toBeTruthy();
});

// [A-select] the Transactions tab renders rows in SELECTION mode (selectable). The tag must still
// render VISUALLY. NOTE: WHIT-291 hides the whole row body from assistive tech in selection mode
// (importantForAccessibility='no-hide-descendants'), so the tag is queryable only with
// includeHiddenElements — i.e. a screen-reader user in selection mode does NOT hear it. See critique.
it('still renders the tag visually when the row is in selection mode', () => {
  render(<TransactionRow t={txn({ category: 'coffee', counts_to_budget: false })} category={mockState.category} selectable selected={false} onToggleSelect={jest.fn()} />);
  expect(screen.getByText('Not in budget', { includeHiddenElements: true })).toBeTruthy();
  // And it is NOT in the accessibility tree in selection mode (documents the a11y gap):
  expect(screen.queryByText('Not in budget', { includeHiddenElements: false })).toBeNull();
});

// [A-a11y] the tag carries an assistive-tech label distinct from its on-screen text.
it('exposes the tag to assistive tech via "Not counted in budgets"', () => {
  render(<TransactionRow t={txn({ category: 'coffee', counts_to_budget: false })} category={mockState.category} />);
  expect(screen.getByLabelText('Not counted in budgets')).toBeTruthy();
});
