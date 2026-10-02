// Screen test: the AddRuleSheet in EDIT mode (WHIT-52 Slice 3). When the sheet
// carries a ruleId it prefills from that rule, relabels to "Edit rule" /
// "Update rule", and submits via updateRule (not saveManualRule). Client state and writers are
// injected via the jest.mock('../context') pattern; the categories and rules the sheet reads come
// from the fake server through the real query hooks (WHIT-670).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { queryClient } from '../queryClient';
import { categoriesKey } from '../queries';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, useTestQueryClient, settle } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

const setMockState = (next: AppContext) => { mockState = next; };

const CATS = [
  { id: 'subs', name: 'Subscriptions', icon: 'film', bucket: 'Lifestyle' },
  { id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Living' },
];

// Seed what the sheet reads from the server, then open it over the loaded screens.
async function openSheet(state: Record<string, unknown>, rules: unknown[] = [], categories: unknown[] = CATS) {
  server.seed('/categories', categories);
  server.seed('/rules', rules);
  return openOverlays({ toast: null, ...state } as unknown as AppContext, setMockState);
}

const fns = {
  updateRule: jest.fn(),
  saveManualRule: jest.fn(),
  setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {},
};

const EDIT_SHEET = { mode: 'addrule', ruleId: 'e1' };
const openEdit = (rules: unknown[] = [{ id: 'e1', value: 'NETFLIX', categoryId: 'subs' }]) =>
  openSheet({ sheet: EDIT_SHEET, ...fns }, rules);

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
});

it('prefills from the rule and relabels for edit', async () => {
  await openEdit();
  expect(screen.getByText('Edit rule')).toBeTruthy();
  expect(screen.getByDisplayValue('NETFLIX')).toBeTruthy();
  expect(screen.getByText('Update rule')).toBeTruthy();
});

it('submitting calls updateRule with the id, not saveManualRule', async () => {
  await openEdit();
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX', 'subs', false, undefined, false);
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

// WHIT-558: the "keep out of budget" toggle threads its value into updateRule (edit path).
it('toggling "keep out of budget" passes budgetExcluded:true to updateRule', async () => {
  await openEdit();
  fireEvent.press(screen.getByTestId('rule-budget-excluded'));
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX', 'subs', true, undefined, false);
});

it('prefills the toggle from the edited rule (budgetExcluded:true stays on and is submitted)', async () => {
  await openEdit([{ id: 'e1', value: 'NETFLIX', categoryId: 'subs', budgetExcluded: true }]);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX', 'subs', true, undefined, false);
});

// WHIT-284 — a restored/prefilled categoryId whose category no longer exists must be dropped:
// no selection, save disabled, and it can never be submitted.
const openNew = (over: Record<string, unknown> = {}, rules: unknown[] = [], categories: unknown[] = CATS) =>
  openSheet({ sheet: { mode: 'addrule' }, ...fns, ...over }, rules, categories);

it('[WHIT-284] a DEAD prefilled categoryId (its category was deleted) keeps the save button disabled', async () => {
  await openEdit([{ id: 'e1', value: 'NETFLIX', categoryId: 'ghost' }]);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).not.toHaveBeenCalled(); // dead id dropped → canSave false → no submit
});

it('[WHIT-284] a DEAD restored draft categoryId (WHIT-277 unlock) keeps the save button disabled', async () => {
  await openNew({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'ghost' }) });
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('[WHIT-284] the LAST category was deleted → loaded-but-EMPTY list still drops the dead id (disabled)', async () => {
  // The case a `cats.length > 0` guard would miss: empty list, but LOADED (not loading).
  await openNew({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'ghost' }) }, [], []);
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('[WHIT-284] a VALID restored categoryId is NOT cleared — submit reaches the confirm step', async () => {
  await openNew({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) });
  fireEvent.press(screen.getByText('Add rule'));
  // WHIT-538: a valid new rule now opens the preview/confirm step, which owns the save itself.
  expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addRuleConfirm', pattern: 'NETFLIX', categoryId: 'subs', budgetExcluded: false });
});

it('[WHIT-284] a valid restored id survives the LOADING window: save is held disabled, then re-enables once the list arrives', async () => {
  // While loading, no id can be resolved → save is disabled (so a dead id is never submittable mid-load,
  // WHIT-284 [E1]). The drop effect is gated on !loading, so the valid id is KEPT, not cleared — and the
  // moment the list loads it resolves and save works. Fail-on-revert: restore the `catsLoading ||` escape
  // and the first press would submit during load.
  server.seed('/categories', CATS);
  const held = server.hold('/categories');
  setMockState({ sheet: { mode: 'addrule' }, toast: null, ...fns, readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) } as unknown as AppContext);
  render(overlaysTree()); // the sheet opens while the categories reply is still held back
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled(); // loading → id unverifiable → save disabled

  await act(async () => held.release());
  await screen.findByText('Subscriptions'); // the list has arrived
  fireEvent.press(screen.getByText('Add rule'));
  // WHIT-538: valid id kept through load → submit now reaches the confirm step.
  expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addRuleConfirm', pattern: 'NETFLIX', categoryId: 'subs', budgetExcluded: false });
});

it('[WHIT-284] re-picking a real category after a dead one re-enables save', async () => {
  await openEdit([{ id: 'e1', value: 'NETFLIX', categoryId: 'ghost' }]);
  fireEvent.press(screen.getByText('Groceries')); // pick a valid category
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX', 'groceries', false, undefined, false);
});

// WHIT-355 — conflict/duplicate detection in the add-rule sheet.
const NETFLIX_SUBS = { id: 'b1', value: 'NETFLIX', categoryId: 'subs' };

it('[WHIT-355] creating a CLASHING rule warns and does not mint until Replace', async () => {
  await openNew({}, [NETFLIX_SUBS]);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries')); // different category → conflict
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByTestId('rule-conflict')).toBeTruthy();
  expect(fns.saveManualRule).not.toHaveBeenCalled(); // nothing minted yet

  fireEvent.press(screen.getByTestId('rule-conflict-replace'));
  expect(fns.updateRule).toHaveBeenCalledWith('b1', 'NETFLIX', 'groceries', false, undefined, false); // retarget the surviving rule
  expect(fns.saveManualRule).not.toHaveBeenCalled();                          // no second row
});

it('[WHIT-355] Cancel on a create conflict writes nothing and restores the submit button', async () => {
  await openNew({}, [NETFLIX_SUBS]);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-conflict-cancel'));
  expect(fns.updateRule).not.toHaveBeenCalled();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  expect(screen.getByTestId('rule-submit')).toBeTruthy(); // back to the normal form
});

it('[WHIT-355] an exact DUPLICATE on create no-ops (no rule minted) and closes on OK', async () => {
  await openNew({}, [NETFLIX_SUBS]);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Subscriptions')); // same category → duplicate
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByText('You already have a rule for “NETFLIX”.')).toBeTruthy();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('rule-conflict-ok'));
  expect(fns.setSheet).toHaveBeenCalledWith(null);
});

it('[WHIT-355] creating a NON-clashing rule proceeds to the confirm step (happy path preserved)', async () => {
  await openNew({}, [NETFLIX_SUBS]);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'SPOTIFY');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  // WHIT-538: no clash → the preview/confirm step opens (it owns the actual save).
  expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addRuleConfirm', pattern: 'SPOTIFY', categoryId: 'subs', budgetExcluded: false });
  expect(screen.queryByTestId('rule-conflict')).toBeNull();
});

it('[WHIT-355] editing a rule INTO a clash warns with no Replace and writes nothing', async () => {
  await openEdit([
    { id: 'e1', value: 'OLD', categoryId: 'subs' },
    { id: 'b1', value: 'NETFLIX', categoryId: 'groceries' },
  ]);
  fireEvent.changeText(screen.getByDisplayValue('OLD'), 'NETFLIX'); // edit e1's pattern onto b1
  fireEvent.press(screen.getByText('Update rule'));
  expect(screen.getByTestId('rule-conflict')).toBeTruthy();
  expect(screen.queryByTestId('rule-conflict-replace')).toBeNull(); // edit path: warn only, no Replace
  expect(fns.updateRule).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('rule-conflict-ok'));
  expect(fns.updateRule).not.toHaveBeenCalled();
});

it('[WHIT-355] editing the pattern after a warning clears it and restores the submit button', async () => {
  await openNew({}, [NETFLIX_SUBS]);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByTestId('rule-conflict')).toBeTruthy();
  // Change the pattern to something unique → the stale warning must clear, no Replace lingering.
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'SPOTIFY');
  expect(screen.queryByTestId('rule-conflict')).toBeNull();
  expect(screen.getByTestId('rule-submit')).toBeTruthy();
  // And submitting now opens the confirm step for the new rule, never touching the existing NETFLIX one.
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addRuleConfirm', pattern: 'SPOTIFY', categoryId: 'groceries', budgetExcluded: false });
  expect(fns.updateRule).not.toHaveBeenCalled();
});

it('[WHIT-355] Replace overwrites the surviving rule with the newly-typed raw pattern', async () => {
  // Existing rule stored lowercase; user types upper-case + a different category.
  await openNew({}, [{ id: 'b1', value: 'netflix', categoryId: 'subs' }]);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-conflict-replace'));
  expect(fns.updateRule).toHaveBeenCalledWith('b1', 'NETFLIX', 'groceries', false, undefined, false); // raw NEW pattern, not 'netflix'
});

// ===== WHIT-284 drop effect (folded from AddRuleSheetDrop) — the persist effect re-cleans a dead
// restored draft id to null. Own block-scoped fixtures: fns.writeSheetDraft is a TRACKED jest.fn
// (the survivor's is a no-op), and lastDraftCategoryId reads its calls. =====
describe('AddRuleSheet — WHIT-284 drop effect (draft re-clean)', () => {
  const fns = {
    updateRule: jest.fn(),
    saveManualRule: jest.fn(),
    setSheet: jest.fn(),
    writeSheetDraft: jest.fn(),
  };

  function ruleState(over: Partial<Record<string, unknown>>) {
    return { sheet: { mode: 'addrule' }, readSheetDraft: () => undefined, ...fns, ...over };
  }

  // Last categoryId the sheet persisted back to the draft store.
  function lastDraftCategoryId(): unknown {
    const calls = fns.writeSheetDraft.mock.calls;
    return (calls.at(-1)?.[1] as { categoryId?: unknown } | undefined)?.categoryId;
  }

  beforeEach(() => {
    fns.updateRule.mockClear();
    fns.saveManualRule.mockClear();
    fns.setSheet.mockClear();
    fns.writeSheetDraft.mockClear();
  });

  // [A7] — the drop effect must re-write the persisted draft with categoryId:null.
  // canSave belt alone leaves the draft holding the dead id → this pins the effect.
  it('[WHIT-284] a DEAD restored id is re-cleaned out of the persisted draft (written back as null)', async () => {
    await openSheet(ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'ghost' }) }));
    expect(lastDraftCategoryId()).toBeNull(); // effect cleared it, not left at 'ghost'
    fireEvent.press(screen.getByText('Add rule'));
    expect(fns.saveManualRule).not.toHaveBeenCalled();
  });

  // Control: a VALID restored id is left in the draft untouched (never re-cleaned).
  it('[WHIT-284] a VALID restored id is left in the persisted draft (not re-cleaned)', async () => {
    await openSheet(ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) }));
    expect(lastDraftCategoryId()).toBe('subs');
  });

  // [A9] — a cold-load ERROR (no cache) also reports isLoading:false with an EMPTY list. The drop
  // must NOT fire there: dropping would clear a VALID restored id and stickily re-clean the draft to
  // null, so it can't recover when the list later loads OK. Gate is `!catsError`. Fail-on-revert:
  // remove `!catsError` and the effect drops 'subs' on the error render → draft re-written to null.
  it('[WHIT-284] a categories LOAD ERROR (empty list, not loading) does NOT drop a valid restored id or wipe the draft', async () => {
    server.fail('/categories', 500);
    await openSheet(ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) }));
    await settle(); // opening the sheet retries the failed read; let it fail again
    expect(lastDraftCategoryId()).toBe('subs'); // error → don't drop → draft keeps the id (recoverable)

    // The retry succeeds: the real list arrives with 'subs' still present → selection survived intact.
    server.once('GET', '/categories', { body: CATS });
    await refreshInAct(() => queryClient.refetchQueries({ queryKey: categoriesKey }));
    await screen.findByText('Subscriptions'); // the list has arrived
    expect(lastDraftCategoryId()).toBe('subs');
    fireEvent.press(screen.getByText('Add rule'));
    // WHIT-538: recovered → submit reaches the confirm step.
    expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addRuleConfirm', pattern: 'NETFLIX', categoryId: 'subs', budgetExcluded: false });
  });

  // [A8] — an in-session delete: the sheet is open with a valid selection, then that
  // category disappears from the list (deleted elsewhere / this device). The drop
  // effect must clear the now-dead selection, re-clean the draft, and disable save.
  it('[WHIT-284] deleting the selected category while the sheet is open clears it and disables save', async () => {
    await openSheet(ruleState({ readSheetDraft: () => ({ pattern: 'NETFLIX', categoryId: 'subs' }) }));
    expect(lastDraftCategoryId()).toBe('subs'); // starts valid & selected

    // 'subs' is deleted -> only 'groceries' remains, list re-emits.
    server.seed('/categories', [CATS[1]]);
    await refreshInAct(() => queryClient.invalidateQueries({ queryKey: categoriesKey }));
    await waitFor(() => expect(screen.queryByText('Subscriptions')).toBeNull()); // the new list is on screen

    await waitFor(() => expect(lastDraftCategoryId()).toBeNull());   // selection dropped & draft re-cleaned
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
    { id: 'subs', name: 'Subscriptions', icon: 'film', bucket: 'Lifestyle' },
    { id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Living' },
    { id: 'coffee', name: 'Coffee', icon: 'cup', bucket: 'Living' },
  ];

  const openCreate = (rules: unknown[], sheet: Record<string, unknown> = { mode: 'addrule' }) =>
    openSheet({ sheet, ...fns }, rules, CATS);

  const NETFLIX_SUBS = { id: 'b1', value: 'NETFLIX', categoryId: 'subs' };

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
  it('[WHIT-355] changing the category after a warning dismisses it and restores submit', async () => {
    await openCreate([NETFLIX_SUBS]);
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
  it('[WHIT-355] on the edit path, changing the pattern clears the warn-only block', async () => {
    await openCreate([
      { id: 'e1', value: 'OLD', categoryId: 'subs' },
      { id: 'b1', value: 'NETFLIX', categoryId: 'groceries' },
    ], { mode: 'addrule', ruleId: 'e1' });
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
  it('[WHIT-355] with no existing rules a create proceeds with no warning', async () => {
    await openCreate([]);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'NETFLIX');
    fireEvent.press(screen.getByText('Subscriptions'));
    fireEvent.press(screen.getByText('Add rule'));
    // WHIT-538: no clash → the preview/confirm step opens (it owns the save).
    expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addRuleConfirm', pattern: 'NETFLIX', categoryId: 'subs', budgetExcluded: false });
    expect(screen.queryByTestId('rule-conflict')).toBeNull();
  });
});
