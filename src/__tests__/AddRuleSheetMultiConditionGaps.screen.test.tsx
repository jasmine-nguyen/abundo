// WHIT-563 gap coverage for the multi-condition rule builder. These are the adversarial cases the
// implementer's AddRuleSheetMultiCondition.screen.test.tsx does NOT exercise:
//  [G1] switching a row's field after typing clears the stale value AND resets the operator
//  [G2] the AND/OR toggle is hidden at one row, shown at two
//  [G3] the account picker surfaces an editing rule's account that isn't in the recent set, and saves it
//  [G4] adding then removing a row back to a single classic row routes a NEW rule through the preview
//  [G5] editing a server-only merchant/category flat rule round-trips its field via the conditions payload
//  [G7] reducing a multi rule to one classic row on EDIT saves via the flat path (no conditions payload)
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

// [G1] Switch a row's field after typing: the old text must not leak into the new field, and the
// operator must snap to the new field's default (not keep the previous field's picked operator).
it('switching a row field clears the stale value and resets the operator to the field default', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-op-0-equals'));
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIX');
  expect(screen.getByDisplayValue('NETFLIX')).toBeTruthy();
  fireEvent.press(screen.getByTestId('rule-field-0-amount'));
  expect(screen.queryByDisplayValue('NETFLIX')).toBeNull();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), '30');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('30', 'groceries', false, {
    conditions: [{ field: 'amount', operator: 'less_than', value: '30' }],
    logic: 'all',
  });
});

// [G2] The AND/OR toggle is meaningless with one condition, so it only appears at >=2 rows.
it('the AND/OR toggle is hidden with one row and appears with two', () => {
  mockState = newState();
  render(<Overlays />);
  expect(screen.queryByTestId('rule-logic-all')).toBeNull();
  expect(screen.queryByTestId('rule-logic-any')).toBeNull();
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  expect(screen.getByTestId('rule-logic-all')).toBeTruthy();
  expect(screen.getByTestId('rule-logic-any')).toBeTruthy();
});

// [G3] Editing an account rule whose account_id isn't in the recent-transactions set: the picker must
// still surface that id as a selected pill so the value is visible and editable, and round-trip on save.
it('an editing rule account not in the recent set is surfaced and round-trips', () => {
  mockState = newState({
    sheet: { mode: 'addrule', ruleId: 'a1' },
    transactions: [],
    rules: [{
      id: 'a1', pattern: 'acc-gone', categoryId: 'groceries', isNew: false,
      field: 'account', operator: 'equals',
      conditions: [{ field: 'account', operator: 'equals', value: 'acc-gone' }],
      logic: 'all',
    }],
  });
  render(<Overlays />);
  expect(screen.getByTestId('rule-account-0-acc-gone')).toBeTruthy();
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('a1', 'acc-gone', 'groceries', false, {
    conditions: [{ field: 'account', operator: 'equals', value: 'acc-gone' }],
    logic: 'all',
  });
});

// [G4] Add a second row then remove it: the draft is back to a single description/contains row, so a
// NEW rule must route through the classic WHIT-538 preview (setSheet addRuleConfirm), NOT the direct
// multi conditions payload.
it('adding then removing a row back to one classic row routes a new rule through the preview', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIX');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '30');
  fireEvent.press(screen.getByTestId('rule-remove-1'));
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.setSheet).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'addRuleConfirm', pattern: 'NETFLIX', categoryId: 'subs' }),
  );
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

// [G5] Editing a server-authored rule on a field the builder never offers (merchant / category): the
// field must survive the round-trip (not silently reset to description) and save via the conditions
// payload without corruption.
it('editing a merchant flat rule preserves the merchant field on save', () => {
  mockState = newState({
    sheet: { mode: 'addrule', ruleId: 'x1' },
    rules: [{ id: 'x1', pattern: 'GROCERYLAND', categoryId: 'groceries', isNew: false, field: 'merchant', operator: 'contains' }],
  });
  render(<Overlays />);
  expect(screen.getByDisplayValue('GROCERYLAND')).toBeTruthy();
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('x1', 'GROCERYLAND', 'groceries', false, {
    conditions: [{ field: 'merchant', operator: 'contains', value: 'GROCERYLAND' }],
    logic: 'all',
  });
});

it('editing a category equals flat rule preserves the category field on save', () => {
  mockState = newState({
    sheet: { mode: 'addrule', ruleId: 'c1' },
    rules: [{ id: 'c1', pattern: 'GROCERIES', categoryId: 'groceries', isNew: false, field: 'category', operator: 'equals' }],
  });
  render(<Overlays />);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('c1', 'GROCERIES', 'groceries', false, {
    conditions: [{ field: 'category', operator: 'equals', value: 'GROCERIES' }],
    logic: 'all',
  });
});

// [G7] Reducing a MULTI rule down to one classic description/contains row on EDIT must save via the
// flat path (updateRule with 4 args, no conditions payload) — the collapse-to-single case that mirrors
// context.tsx nulling conditions/logic on the classic edit path.
it('editing a multi rule down to one classic row saves via the flat path (no conditions payload)', () => {
  mockState = newState({
    sheet: { mode: 'addrule', ruleId: 'm2' },
    rules: [{
      id: 'm2', pattern: 'NETFLIX', categoryId: 'subs', isNew: false,
      field: 'description', operator: 'contains',
      conditions: [
        { field: 'description', operator: 'contains', value: 'NETFLIX' },
        { field: 'amount', operator: 'less_than', value: '30' },
      ],
      logic: 'all',
    }],
  });
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-remove-1')); // drop the amount row → one description/contains row
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('m2', 'NETFLIX', 'subs', false);
});
