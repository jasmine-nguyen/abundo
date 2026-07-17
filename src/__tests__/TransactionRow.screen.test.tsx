// Screen test: the transaction row (feed + budget detail). Verifies the row
// actually renders the label/amount/pending pill from transactionView and that
// an uncategorized row is tappable (opens the categorize picker) while a
// categorized one is not. Seeded from the QA "Automatable (UI)" feed scenarios.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';
import type { Category } from '../context';

// WHIT-192: the row reads only openPicker (client-state) from the store now; the
// category taxonomy arrives as a prop from the screen's query composite. So the mocked
// context supplies just openPicker + a category() lookup for the tests to pass as a prop.
let mockState: { openPicker: typeof openPicker; category: (id: string | null) => Category | undefined };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

// WHIT-272: the row's trailing chevron routes to the detail page via useRouter. Stub it and
// capture push so the chevron-routing test can assert the destination.
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

import { TransactionRow } from '../components/TransactionRow';

const openPicker = jest.fn();
function stateWith() {
  return { openPicker, category: makeState({ categories: [cat({ id: 'coffee', name: 'Cafes & Coffee', color: '#E8A87C' })] }).category };
}

beforeEach(() => {
  openPicker.mockClear();
  mockPush.mockClear();
});

it('renders merchant, amount and category for a categorized row', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ merchant_name: 'Woolworths', amount: -12.5, category: 'coffee' })} category={mockState.category} />);
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(screen.getByText('-$12.50')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
});

it('shows a Pending pill for a pending transaction', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ status: 'pending', category: 'coffee' })} category={mockState.category} />);
  expect(screen.getByText('Pending')).toBeTruthy();
});

// WHIT-298: a charge that doesn't count toward budgets shows a quiet "Not in budget" tag.
it('shows a "Not in budget" tag on a bank-excluded (counts_to_budget false) row', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ category: 'coffee', counts_to_budget: false })} category={mockState.category} />);
  expect(screen.getByText('Not in budget')).toBeTruthy();
});

it('shows the "Not in budget" tag on a user-excluded (budget_excluded) row too', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ category: 'coffee', counts_to_budget: true, budget_excluded: true })} category={mockState.category} />);
  expect(screen.getByText('Not in budget')).toBeTruthy();
});

it('does NOT show the tag on a normal counted row', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ category: 'coffee', counts_to_budget: true })} category={mockState.category} />);
  expect(screen.queryByText('Not in budget')).toBeNull();
});

it('an uncategorized row is labelled Uncategorized and opens the picker on tap', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ transaction_id: 'tx9', category: null })} category={mockState.category} />);
  const label = screen.getByText('Uncategorized');
  expect(label).toBeTruthy();
  fireEvent.press(label);
  expect(openPicker).toHaveBeenCalledWith('tx9');
});

it('a categorized row does not open the picker on tap', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ transaction_id: 'tx1', category: 'coffee' })} category={mockState.category} />);
  fireEvent.press(screen.getByText('Cafes & Coffee'));
  expect(openPicker).not.toHaveBeenCalled();
});

// WHIT-272: the trailing chevron opens /transaction/[id]. It is a SEPARATE Pressable from the
// row body, so pressing it routes to the detail page and never fires the category picker —
// even on an uncategorized (tappable) row.
it('the trailing chevron opens the transaction detail page without opening the picker', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ transaction_id: 'tx9', category: null })} category={mockState.category} />);
  fireEvent.press(screen.getByLabelText('View transaction details'));
  expect(mockPush).toHaveBeenCalledWith('/transaction/tx9');
  expect(openPicker).not.toHaveBeenCalled();
});
