// Screen test: the AddRuleSheet multi-condition builder (WHIT-563). Builds ≥2 condition rows with
// per-field operators, a dollar amount, an account picker, a spending/income choice and an AND/OR
// toggle; saves the conditions+logic payload; edits round-trip; single-condition classic rules keep
// today's behaviour (covered in AddRuleSheet.screen.test.tsx, plus the backward-compat case here).
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

function newState(over: Partial<Record<string, unknown>> = {}): AppContext {
  return { sheet: { mode: 'addrule' }, toast: null, rules: [], categories: CATS, transactions: [], ...fns, ...over } as unknown as AppContext;
}

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
});

it('builds a two-condition rule and saves it directly (no preview step)', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIX');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '30');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('NETFLIX', 'subs', false, {
    conditions: [
      { field: 'description', operator: 'contains', value: 'NETFLIX' },
      { field: 'amount', operator: 'less_than', value: '30' },
    ],
    logic: 'all',
  });
  // A multi rule never routes through the single-rule preview/confirm sheet.
  expect(fns.setSheet).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm' }));
});

it('the logic toggle sets "any" in the saved payload', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIX');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '30');
  fireEvent.press(screen.getByTestId('rule-logic-any'));
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('NETFLIX', 'subs', false, expect.objectContaining({ logic: 'any' }));
});

it('a single direction condition saves via the conditions payload, not the classic preview', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-field-0-direction')); // defaults to Spending (debit)
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('debit', 'subs', false, {
    conditions: [{ field: 'direction', operator: 'is', value: 'debit' }],
    logic: 'all',
  });
  expect(fns.setSheet).not.toHaveBeenCalled();
});

it('an amount condition of 0 keeps save disabled', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-field-0-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-0'), '0');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('a positive amount condition saves', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-field-0-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-0'), '30');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('30', 'groceries', false, {
    conditions: [{ field: 'amount', operator: 'less_than', value: '30' }],
    logic: 'all',
  });
});

it('a too-short description-contains value keeps save disabled (mirrors the server floor)', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'AB'); // < 4 alphanumerics
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  expect(fns.setSheet).not.toHaveBeenCalled();
});

it('an account condition stores the picked account id', () => {
  mockState = newState({
    transactions: [{ transaction_id: 't1', account_id: 'acc-1', account_name: 'Everyday' }],
  });
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-field-0-account'));
  fireEvent.press(screen.getByTestId('rule-account-0-acc-1'));
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('acc-1', 'groceries', false, {
    conditions: [{ field: 'account', operator: 'equals', value: 'acc-1' }],
    logic: 'all',
  });
});

it('editing a multi-condition rule round-trips its conditions and logic', () => {
  mockState = newState({
    sheet: { mode: 'addrule', ruleId: 'm1' },
    rules: [{
      id: 'm1', pattern: 'COLES', categoryId: 'groceries', isNew: false,
      field: 'description', operator: 'contains',
      conditions: [
        { field: 'description', operator: 'contains', value: 'COLES' },
        { field: 'amount', operator: 'greater_than', value: '100' },
      ],
      logic: 'any',
    }],
  });
  render(<Overlays />);
  expect(screen.getByTestId('rule-condition-0')).toBeTruthy();
  expect(screen.getByTestId('rule-condition-1')).toBeTruthy();
  expect(screen.getByDisplayValue('COLES')).toBeTruthy();
  expect(screen.getByDisplayValue('100')).toBeTruthy();
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('m1', 'COLES', 'groceries', false, {
    conditions: [
      { field: 'description', operator: 'contains', value: 'COLES' },
      { field: 'amount', operator: 'greater_than', value: '100' },
    ],
    logic: 'any',
  });
});

it('a legacy flat rule edits via the classic single-condition path (no conditions payload)', () => {
  mockState = newState({
    sheet: { mode: 'addrule', ruleId: 'f1' },
    rules: [{ id: 'f1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' }],
  });
  render(<Overlays />);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('f1', 'NETFLIX', 'subs', false);
});

it('adds and removes condition rows', () => {
  mockState = newState();
  render(<Overlays />);
  expect(screen.queryByTestId('rule-condition-1')).toBeNull();
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  expect(screen.getByTestId('rule-condition-1')).toBeTruthy();
  fireEvent.press(screen.getByTestId('rule-remove-1'));
  expect(screen.queryByTestId('rule-condition-1')).toBeNull();
});
