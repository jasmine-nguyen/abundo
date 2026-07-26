// Screen test: the AddRuleSheet in EDIT mode (WHIT-52 Slice 3). When the sheet
// carries a ruleId it prefills from that rule, relabels to "Edit rule" /
// "Update rule", and submits via updateRule (not saveManualRule). Context is
// injected via the jest.mock('../context') pattern.
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
  setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {},
  dismissNotif: jest.fn(),
};

function editState(): AppContext {
  return {
    sheet: { mode: 'addrule', ruleId: 'e1' },
    toast: null,
    notif: null,
    rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }],
    categories: [
      { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
      { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
    ],
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
});

it('prefills from the rule and relabels for edit', () => {
  mockState = editState();
  render(<Overlays />);
  expect(screen.getByText('Edit rule')).toBeTruthy();
  expect(screen.getByDisplayValue('NETFLIX')).toBeTruthy();
  expect(screen.getByText('Update rule')).toBeTruthy();
});

it('submitting calls updateRule with the id, not saveManualRule', () => {
  mockState = editState();
  render(<Overlays />);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX', 'subs');
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

// WHIT-284 — a restored/prefilled categoryId whose category no longer exists must be dropped:
// no selection, save disabled, and it can never be submitted.
const CATS = [
  { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
];
function ruleState(over: Partial<Record<string, unknown>>): AppContext {
  return { sheet: { mode: 'addrule' }, toast: null, notif: null, rules: [], categories: CATS, ...fns, ...over } as unknown as AppContext;
}

it('[WHIT-284] a DEAD prefilled categoryId (its category was deleted) keeps the save button disabled', () => {
  mockState = { ...editState(), rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'ghost', isNew: false }] } as AppContext;
  render(<Overlays />);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).not.toHaveBeenCalled(); // dead id dropped → canSave false → no submit
});

it('[WHIT-284] a DEAD restored draft categoryId (WHIT-277 unlock) keeps the save button disabled', () => {
  mockState = ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'ghost' }) });
  render(<Overlays />);
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('[WHIT-284] the LAST category was deleted → loaded-but-EMPTY list still drops the dead id (disabled)', () => {
  // The case a `cats.length > 0` guard would miss: empty list, but LOADED (not loading).
  mockState = ruleState({ categories: [], categoriesLoading: false, readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'ghost' }) });
  render(<Overlays />);
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('[WHIT-284] a VALID restored categoryId is NOT cleared — save works', () => {
  mockState = ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) });
  render(<Overlays />);
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('NETFLIX', 'subs');
});

it('[WHIT-284] a valid restored id survives the LOADING window: save is held disabled, then re-enables once the list arrives', () => {
  // While loading, no id can be resolved → save is disabled (so a dead id is never submittable mid-load,
  // WHIT-284 [E1]). The drop effect is gated on !loading, so the valid id is KEPT, not cleared — and the
  // moment the list loads it resolves and save works. Fail-on-revert: restore the `catsLoading ||` escape
  // and the first press would submit during load.
  mockState = ruleState({ categories: [], categoriesLoading: true, readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) });
  const { rerender } = render(<Overlays />);
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled(); // loading → id unverifiable → save disabled

  mockState = ruleState({ categories: CATS, categoriesLoading: false, readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) });
  rerender(<Overlays />);
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('NETFLIX', 'subs'); // valid id kept through load → save works
});

it('[WHIT-284] re-picking a real category after a dead one re-enables save', () => {
  mockState = { ...editState(), rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'ghost', isNew: false }] } as AppContext;
  render(<Overlays />);
  fireEvent.press(screen.getByText('Groceries')); // pick a valid category
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX', 'groceries');
});

// WHIT-355 — conflict/duplicate detection in the add-rule sheet.
const NETFLIX_SUBS = { id: 'b1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false };

it('[WHIT-355] creating a CLASHING rule warns and does not mint until Replace', () => {
  mockState = ruleState({ rules: [NETFLIX_SUBS] });
  render(<Overlays />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries')); // different category → conflict
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByTestId('rule-conflict')).toBeTruthy();
  expect(fns.saveManualRule).not.toHaveBeenCalled(); // nothing minted yet

  fireEvent.press(screen.getByTestId('rule-conflict-replace'));
  expect(fns.updateRule).toHaveBeenCalledWith('b1', 'NETFLIX', 'groceries'); // retarget the surviving rule
  expect(fns.saveManualRule).not.toHaveBeenCalled();                          // no second row
});

it('[WHIT-355] Cancel on a create conflict writes nothing and restores the submit button', () => {
  mockState = ruleState({ rules: [NETFLIX_SUBS] });
  render(<Overlays />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-conflict-cancel'));
  expect(fns.updateRule).not.toHaveBeenCalled();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  expect(screen.getByTestId('rule-submit')).toBeTruthy(); // back to the normal form
});

it('[WHIT-355] an exact DUPLICATE on create no-ops (no rule minted) and closes on OK', () => {
  mockState = ruleState({ rules: [NETFLIX_SUBS] });
  render(<Overlays />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Subscriptions')); // same category → duplicate
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByText('You already have a rule for “NETFLIX”.')).toBeTruthy();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('rule-conflict-ok'));
  expect(fns.setSheet).toHaveBeenCalledWith(null);
});

it('[WHIT-355] creating a NON-clashing rule still saves (happy path preserved)', () => {
  mockState = ruleState({ rules: [NETFLIX_SUBS] });
  render(<Overlays />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'SPOTIFY');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('SPOTIFY', 'subs');
  expect(screen.queryByTestId('rule-conflict')).toBeNull();
});

it('[WHIT-355] editing a rule INTO a clash warns with no Replace and writes nothing', () => {
  mockState = {
    ...editState(),
    rules: [
      { id: 'e1', pattern: 'OLD', categoryId: 'subs', isNew: false },
      { id: 'b1', pattern: 'NETFLIX', categoryId: 'groceries', isNew: false },
    ],
    sheet: { mode: 'addrule', ruleId: 'e1' },
  } as AppContext;
  render(<Overlays />);
  fireEvent.changeText(screen.getByDisplayValue('OLD'), 'NETFLIX'); // edit e1's pattern onto b1
  fireEvent.press(screen.getByText('Update rule'));
  expect(screen.getByTestId('rule-conflict')).toBeTruthy();
  expect(screen.queryByTestId('rule-conflict-replace')).toBeNull(); // edit path: warn only, no Replace
  expect(fns.updateRule).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('rule-conflict-ok'));
  expect(fns.updateRule).not.toHaveBeenCalled();
});

it('[WHIT-355] editing the pattern after a warning clears it and restores the submit button', () => {
  mockState = ruleState({ rules: [NETFLIX_SUBS] });
  render(<Overlays />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByTestId('rule-conflict')).toBeTruthy();
  // Change the pattern to something unique → the stale warning must clear, no Replace lingering.
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'SPOTIFY');
  expect(screen.queryByTestId('rule-conflict')).toBeNull();
  expect(screen.getByTestId('rule-submit')).toBeTruthy();
  // And submitting now saves the new rule, never touching the existing NETFLIX one.
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('SPOTIFY', 'groceries');
  expect(fns.updateRule).not.toHaveBeenCalled();
});

it('[WHIT-355] Replace overwrites the surviving rule with the newly-typed raw pattern', () => {
  // Existing rule stored lowercase; user types upper-case + a different category.
  mockState = ruleState({ rules: [{ id: 'b1', pattern: 'netflix', categoryId: 'subs', isNew: false }] });
  render(<Overlays />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-conflict-replace'));
  expect(fns.updateRule).toHaveBeenCalledWith('b1', 'NETFLIX', 'groceries'); // raw NEW pattern, not 'netflix'
});
