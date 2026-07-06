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

import { TransactionRow } from '../components/TransactionRow';

const openPicker = jest.fn();
function stateWith() {
  return { openPicker, category: makeState({ categories: [cat({ id: 'coffee', name: 'Cafes & Coffee', color: '#E8A87C' })] }).category };
}

beforeEach(() => {
  openPicker.mockClear();
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
