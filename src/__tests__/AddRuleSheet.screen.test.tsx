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
};

function editState(): AppContext {
  return {
    sheet: { mode: 'addrule', ruleId: 'e1' },
    toast: null,
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
  return { sheet: { mode: 'addrule' }, toast: null, rules: [], categories: CATS, ...fns, ...over } as unknown as AppContext;
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

// ===== WHIT-284 drop effect (folded from AddRuleSheetDrop) — the persist effect re-cleans a dead
// restored draft id to null. Own block-scoped fixtures: fns.writeSheetDraft is a TRACKED jest.fn
// (the survivor's is a no-op), and lastDraftCategoryId reads its calls. =====
describe('AddRuleSheet — WHIT-284 drop effect (draft re-clean)', () => {
  const CATS = [
    { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
    { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
  ];

  const fns = {
    updateRule: jest.fn(),
    saveManualRule: jest.fn(),
    setSheet: jest.fn(),
    writeSheetDraft: jest.fn(),
  };

  function ruleState(over: Partial<Record<string, unknown>>): AppContext {
    return {
      sheet: { mode: 'addrule' }, toast: null, rules: [],
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
});

// ===== WHIT-355 conflict adversarial (folded from AddRuleSheet.conflict-adversarial) — keeps its
// own 3-category CATS (adds 'coffee') and createState helper. =====
describe('AddRuleSheet — WHIT-355 conflict adversarial', () => {
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
    { id: 'coffee', name: 'Coffee', icon: 'cup', color: '#c08457', bucket: 'Living', recent: 0 },
  ];

  function createState(rules: unknown[]): AppContext {
    return { sheet: { mode: 'addrule' }, toast: null, rules, categories: CATS, ...fns } as unknown as AppContext;
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
  // by the survivor's stale-clear test above; not duplicated here.)

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
});
