// Screen test: the transaction row (feed + budget detail). Verifies the row
// actually renders the label/amount/pending pill from transactionView and that
// an uncategorized row is tappable (opens the categorize picker) while a
// categorized one is not. Seeded from the QA "Automatable (UI)" feed scenarios.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';
import type { AppContext } from '../context';

// Inject a controlled context but keep the real transactionView (same module).
let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

import { TransactionRow } from '../components/TransactionRow';

const openPicker = jest.fn();
function stateWith(t = {}) {
  return { ...makeState({ categories: [cat({ id: 'coffee', name: 'Cafes & Coffee', color: '#E8A87C' })] }), openPicker } as AppContext;
}

beforeEach(() => {
  openPicker.mockClear();
});

it('renders merchant, amount and category for a categorized row', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ merchant_name: 'Woolworths', amount: -12.5, category: 'coffee' })} />);
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(screen.getByText('-$12.50')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
});

it('shows a Pending pill for a pending transaction', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ status: 'pending', category: 'coffee' })} />);
  expect(screen.getByText('Pending')).toBeTruthy();
});

it('an uncategorized row is labelled Uncategorized and opens the picker on tap', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ transaction_id: 'tx9', category: null })} />);
  const label = screen.getByText('Uncategorized');
  expect(label).toBeTruthy();
  fireEvent.press(label);
  expect(openPicker).toHaveBeenCalledWith('tx9');
});

it('a categorized row does not open the picker on tap', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ transaction_id: 'tx1', category: 'coffee' })} />);
  fireEvent.press(screen.getByText('Cafes & Coffee'));
  expect(openPicker).not.toHaveBeenCalled();
});
