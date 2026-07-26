// WHIT-355 (adversarial gaps) — AddRuleSheet conflict flow around the conflict-clearing effect
// (Overlays.tsx: `useEffect(() => { if (conflict) setConflict(null) }, [pattern, categoryId])`).
// The implementer's suite proves the warn/Replace/Cancel happy cases; these pin what happens
// when the user KEEPS EDITING while a warning is up — the stale-pattern / wrong-target window.
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
  dismissNotif: jest.fn(),
};

const CATS = [
  { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
  { id: 'coffee', name: 'Coffee', icon: 'cup', color: '#c08457', bucket: 'Living', recent: 0 },
];

function createState(rules: unknown[]): AppContext {
  return { sheet: { mode: 'addrule' }, toast: null, notif: null, rules, categories: CATS, ...fns } as unknown as AppContext;
}

const NETFLIX_SUBS = { id: 'b1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false };

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
});

// [A-S1] Change the CATEGORY while the conflict warning is up -> the warning is dismissed and
// the normal submit button returns. Guards the clearing effect: without it the stale Replace
// button would survive and retarget the OTHER rule using the newly-picked category.
// Fail-on-revert: delete Overlays.tsx:473 -> the warning persists after the pill tap -> the
// `rule-submit` assertion (and `rule-conflict` being gone) fails.
it('[WHIT-355] changing the category after a warning dismisses it and restores submit', () => {
  mockState = createState([NETFLIX_SUBS]);
  render(<Overlays />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByTestId('rule-conflict')).toBeTruthy();

  fireEvent.press(screen.getByText('Coffee')); // re-pick category while the warning is up
  expect(screen.queryByTestId('rule-conflict')).toBeNull();     // warning dismissed
  expect(screen.queryByTestId('rule-conflict-replace')).toBeNull();
  expect(screen.getByTestId('rule-submit')).toBeTruthy();        // back to the normal form
});

// (The "edit pattern to a unique value clears the warning + saves the new rule" case is covered
// by the implementer's AddRuleSheet.screen.test.tsx stale-clear test; not duplicated here.)

// [A-S3] Edit path: after an edit-into-clash warning, changing the pattern also clears the
// warn-only block (the edit path never had a Replace, so the only risk is being stuck).
it('[WHIT-355] on the edit path, changing the pattern clears the warn-only block', () => {
  mockState = {
    ...createState([
      { id: 'e1', pattern: 'OLD', categoryId: 'subs', isNew: false },
      { id: 'b1', pattern: 'NETFLIX', categoryId: 'groceries', isNew: false },
    ]),
    sheet: { mode: 'addrule', ruleId: 'e1' },
  } as unknown as AppContext;
  render(<Overlays />);
  fireEvent.changeText(screen.getByDisplayValue('OLD'), 'NETFLIX'); // clash with b1
  fireEvent.press(screen.getByText('Update rule'));
  expect(screen.getByTestId('rule-conflict')).toBeTruthy();
  expect(screen.queryByTestId('rule-conflict-replace')).toBeNull(); // edit path: no Replace

  fireEvent.changeText(screen.getByDisplayValue('NETFLIX'), 'DISNEY'); // move off the clash
  expect(screen.queryByTestId('rule-conflict')).toBeNull();
  expect(screen.getByTestId('rule-submit')).toBeTruthy();
});

// [A-S4] Empty rules list -> a create never warns and saves straight through (guards a future
// change that might warn/null-deref on an empty list).
it('[WHIT-355] with no existing rules a create saves with no warning', () => {
  mockState = createState([]);
  render(<Overlays />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('NETFLIX', 'subs');
  expect(screen.queryByTestId('rule-conflict')).toBeNull();
});
