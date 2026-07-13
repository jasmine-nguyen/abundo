// WHIT-284 — the DROP EFFECT itself (not the canSave belt). The implementer's
// writer-not-called tests are closed by EITHER guard (drop effect OR the canSave
// `cats.some` term), so neither is pinned alone. These tests isolate the drop
// effect's own job: setCategoryId(null) once loaded → the persist effect re-cleans
// the stashed WHIT-277 draft to categoryId:null, so a dead id can't be re-restored
// on the next Face ID lock. Reverting the drop effect must fail these.
//   Covers: [A7] draft re-clean on dead restored id, [A8] in-session category delete.
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

const CATS = [
  { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
];

const fns = {
  updateRule: jest.fn(),
  saveManualRule: jest.fn(),
  setSheet: jest.fn(),
  dismissNotif: jest.fn(),
  writeSheetDraft: jest.fn(),
};

function ruleState(over: Partial<Record<string, unknown>>): AppContext {
  return {
    sheet: { mode: 'addrule' }, toast: null, notif: null, rules: [],
    categories: CATS, categoriesLoading: false,
    readSheetDraft: () => undefined,
    ...fns, ...over,
  } as unknown as AppContext;
}

// Last categoryId the sheet persisted back to the draft store.
function lastDraftCategoryId(): unknown {
  const calls = fns.writeSheetDraft.mock.calls;
  return (calls.at(-1)?.[1] as { categoryId?: unknown } | undefined)?.categoryId;
}

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.writeSheetDraft.mockClear();
});

// [A7] — the drop effect must re-write the persisted draft with categoryId:null.
// canSave belt alone leaves the draft holding the dead id → this pins the effect.
it('[WHIT-284] a DEAD restored id is re-cleaned out of the persisted draft (written back as null)', () => {
  mockState = ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'ghost' }) });
  render(<Overlays />);
  expect(lastDraftCategoryId()).toBeNull(); // effect cleared it, not left at 'ghost'
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

// Control: a VALID restored id is left in the draft untouched (never re-cleaned).
it('[WHIT-284] a VALID restored id is left in the persisted draft (not re-cleaned)', () => {
  mockState = ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) });
  render(<Overlays />);
  expect(lastDraftCategoryId()).toBe('subs');
});

// [A9] — a cold-load ERROR (no cache) also reports isLoading:false with an EMPTY list. The drop
// must NOT fire there: dropping would clear a VALID restored id and stickily re-clean the draft to
// null, so it can't recover when the list later loads OK. Gate is `!catsError`. Fail-on-revert:
// remove `!catsError` and the effect drops 'subs' on the error render → draft re-written to null.
it('[WHIT-284] a categories LOAD ERROR (empty list, not loading) does NOT drop a valid restored id or wipe the draft', () => {
  mockState = ruleState({ categories: [], categoriesLoading: false, categoriesError: true, readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) });
  const { rerender } = render(<Overlays />);
  expect(lastDraftCategoryId()).toBe('subs'); // error → don't drop → draft keeps the id (recoverable)

  // The retry succeeds: the real list arrives with 'subs' still present → selection survived intact.
  mockState = ruleState({ categories: CATS, categoriesLoading: false, categoriesError: false, readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) });
  rerender(<Overlays />);
  expect(lastDraftCategoryId()).toBe('subs');
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('NETFLIX', 'subs'); // recovered → save works
});

// [A8] — an in-session delete: the sheet is open with a valid selection, then that
// category disappears from the list (deleted elsewhere / this device). The drop
// effect must clear the now-dead selection, re-clean the draft, and disable save.
it('[WHIT-284] deleting the selected category while the sheet is open clears it and disables save', () => {
  mockState = ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) });
  const { rerender } = render(<Overlays />);
  expect(lastDraftCategoryId()).toBe('subs'); // starts valid & selected

  // 'subs' is deleted -> only 'groceries' remains, list re-emits.
  mockState = { ...mockState, categories: [CATS[1]] } as AppContext;
  rerender(<Overlays />);

  expect(lastDraftCategoryId()).toBeNull();   // selection dropped & draft re-cleaned
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled(); // save now disabled
});
