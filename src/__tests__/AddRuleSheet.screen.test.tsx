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
