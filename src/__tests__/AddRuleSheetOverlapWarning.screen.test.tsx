// Screen test: the WHIT-562 multi-condition overlap warning in the rule builder. When a multi rule
// can co-match a charge with an existing rule that files elsewhere, the builder SOFT-warns before
// saving (it does not block) — the user can Save anyway or Cancel. A non-overlapping multi rule
// saves directly, unchanged.
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

const fns = {
  updateRule: jest.fn(),
  saveManualRule: jest.fn(),
  setSheet: jest.fn(),
  readSheetDraft: () => undefined,
  writeSheetDraft: () => {},
};

const CATS = [
  { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
];

const colesGroceries = { id: 'g1', pattern: 'COLES', categoryId: 'groceries', isNew: false };
const wooliesGroceries = { id: 'w1', pattern: 'WOOLIES', categoryId: 'groceries', isNew: false };

function newState(over: Partial<Record<string, unknown>> = {}): AppContext {
  return { sheet: { mode: 'addrule' }, toast: null, rules: [], categories: CATS, transactions: [], ...fns, ...over } as unknown as AppContext;
}

// Build a two-condition rule "COLES AND under $40", filed as Subscriptions.
function buildColesUnder40() {
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'COLES');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '40');
  fireEvent.press(screen.getByText('Subscriptions'));
}

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
});

it('warns (does not save) when a multi rule overlaps an existing rule filing elsewhere', () => {
  mockState = newState({ rules: [colesGroceries] });
  render(<Overlays />);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByTestId('rule-overlap')).toBeTruthy();
  expect(screen.getByText(/files as Groceries/)).toBeTruthy();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('"Save anyway" saves the rule despite the overlap', () => {
  mockState = newState({ rules: [colesGroceries] });
  render(<Overlays />);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-overlap-save'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('COLES', 'subs', false, {
    conditions: [
      { field: 'description', operator: 'contains', value: 'COLES' },
      { field: 'amount', operator: 'less_than', value: '40' },
    ],
    logic: 'all',
  });
});

it('"Cancel" dismisses the warning and does not save', () => {
  mockState = newState({ rules: [colesGroceries] });
  render(<Overlays />);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-overlap-cancel'));
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('a non-overlapping multi rule saves directly (no warning)', () => {
  // Existing rule matches WOOLIES; the candidate needs COLES too, so no charge matches both.
  mockState = newState({ rules: [wooliesGroceries] });
  render(<Overlays />);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).toHaveBeenCalledWith('COLES', 'subs', false, expect.objectContaining({ logic: 'all' }));
});

it('does not warn when the overlapping rule files to the SAME category', () => {
  mockState = newState({ rules: [{ id: 's1', pattern: 'COLES', categoryId: 'subs', isNew: false }] });
  render(<Overlays />);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).toHaveBeenCalled();
});
