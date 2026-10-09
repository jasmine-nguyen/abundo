// Screen test: the transaction row (feed + budget detail). Verifies the row
// actually renders the label/amount/pending pill from transactionView and that
// an uncategorized row is tappable (opens the categorize picker) while a
// categorized one is not. Seeded from the QA "Automatable (UI)" feed scenarios.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';
import { pinToday } from './support/clock';
import type { Category } from '../types';

// WHIT-192: the row reads only openPicker (client-state) from the store now; the
// category taxonomy arrives as a prop from the screen's query composite. So the mocked
// context supplies just openPicker + a category() lookup for the tests to pass as a prop.
let mockState: { openPicker: typeof openPicker; category: (id: string | null) => Category | undefined };
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));

// WHIT-272: the row's trailing chevron routes to the detail page via useRouter. Stub it and
// capture push so the chevron-routing test can assert the destination.
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { TransactionRow } from '../components/TransactionRow';

const openPicker = jest.fn();
function stateWith() {
  return { openPicker, category: makeState({ categories: [cat()] }).category };
}

beforeEach(() => {
  resetRouter();
  openPicker.mockClear();
});

it('renders merchant, amount and category for a categorized row', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ merchant_name: 'Woolworths', amount: -12.5, category: 'coffee' })} category={mockState.category} />);
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(screen.getByText('-$12.50')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
});

// WHIT-844: a pending charge older than 3 days says how long it has been pending, so a stuck
// one stands out. The age counts local calendar days from the charge's date.
describe('pending pill shows the age of an old pending charge (WHIT-844)', () => {
  beforeEach(() => { pinToday(new Date('2026-10-09T08:00:00+11:00')); });
  afterEach(() => { jest.useRealTimers(); });

  it.each([
    ['2026-10-09', 'Pending'],
    ['2026-10-06', 'Pending'],
    ['2026-10-05', 'Pending · 4 days'],
    ['2026-10-02', 'Pending · 7 days'],
  ])('a pending charge dated %s shows "%s"', (date, label) => {
    mockState = stateWith();
    render(<TransactionRow t={txn({ status: 'pending', category: 'coffee', date, authorized_date: date })} category={mockState.category} />);
    expect(screen.getByText(label)).toBeTruthy();
  });
});

// WHIT-330: the "Not in budget" tag was removed from all rows. Fail-on-revert: restore the
// pill in TransactionRow and either of these finds it again.
it('shows no "Not in budget" tag on a bank-excluded (counts_to_budget false) row', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ category: 'coffee', counts_to_budget: false })} category={mockState.category} />);
  expect(screen.queryByText('Not in budget')).toBeNull();
  expect(screen.queryByLabelText('Not counted in budgets')).toBeNull();
});

it('shows no "Not in budget" tag on a user-excluded (budget_excluded) row', () => {
  mockState = stateWith();
  render(<TransactionRow t={txn({ category: 'coffee', counts_to_budget: true, budget_excluded: true })} category={mockState.category} />);
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
  expect(routerSpies.push).toHaveBeenCalledWith('/transaction/tx9');
  expect(openPicker).not.toHaveBeenCalled();
});
