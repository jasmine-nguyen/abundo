// Category-edit screen tests (WHIT-451 + WHIT-459 consolidation): every app/category/edit suite.
// WHIT-451 merged categoryEditSummaryToast + categoryEditSubcategories + categoryEditSubcategoriesGaps
// + categoryEditParentClear + categoryEditParentPick + categoryEditDelete. WHIT-459 folded in the
// reason / save-failure family (categoryEditReasonGaps), the session-stamp guard
// (categoryEditSignOutGuard) and the cold-cache seed guard (categoryEditColdSeed) — see the
// // ===== headers below. WHIT-688: the taxonomy is read by the real query hooks over the fake
// server — each test sets `categories` and drawEdit() seeds /categories with it. WHIT-692: the
// screen draws inside the real AppProvider (support/renderWithApp), so the real create, update and
// delete writers send to the fake server. Failures are staged there (server.once / server.hold),
// sign-out mid-save is a real setAuthStatus('anon'), and each test reads the requests sent plus
// the toasts the user saw (shownToasts()).
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../types';
import { MAX_CHILDREN_PER_CATEGORY } from '../context';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, WithApp, shownToasts, resetAppProbe } from './support/renderWithApp';
import { resetAuth, setAuthStatus } from './support/authMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import CategoryEdit from '../../app/category/edit';
import { COFFEE, COFFEE_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

// The coffee fields an edit-screen save sends (everything but the id).
const COFFEE_SAVED = { name: COFFEE_RECORD.name, bucket: COFFEE_RECORD.bucket, icon: COFFEE_RECORD.icon };

// The taxonomy /categories answers with; drawEdit() seeds it right before the screen draws.
let categories: Category[] = [];
async function drawEdit() {
  server.seed('/categories', categories);
  return renderWithApp(<CategoryEdit />);
}

beforeEach(() => {
  resetRouter();
  resetAuth();
  resetAppProbe();
});

const LIVING = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', parent });

const GENERIC_SAVE_FAILURE = 'Could not save category. Please try again.';

// Reset the module-level params / seed / router spy per test so a prior suite's values can't leak.
function resetMocks(params: { categoryId?: string }) {
  setParams(params);
  categories = [];
}

const save = async () => { await act(async () => { fireEvent.press(screen.getByText('Save category')); }); };

/** Queue a brand-new inline sub-category (the create half of the child writes). */
const addNewChild = (name: string) => {
  fireEvent.press(screen.getByText('＋ New sub-category'));
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), name);
  fireEvent.press(screen.getByText('Add sub-category'));
};

const patchBodies = (id: string) => server.sent('PATCH', `/categories/${id}`).map((request) => request.body);
const postBodies = () => server.sent('POST', '/categories').map((request) => request.body);

describe('categoryEditSummaryToast', () => {
  beforeEach(() => { resetMocks({}); });
  afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

  it('editing a parent and attaching 2 children shows one "Category updated, with 2 sub-categories."', async () => {
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual(['Category updated, with 2 sub-categories.']));
    expect(patchBodies('transport')).toEqual([{ name: 'Transport', bucket: 'Living', icon: 'car', parent: null }]);
    expect(patchBodies('parking')).toEqual([{ name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' }]);
    expect(patchBodies('petrol')).toEqual([{ name: 'Petrol', bucket: 'Living', icon: 'car', parent: 'transport' }]);
    expect(routerSpies.back).toHaveBeenCalled();
  });

  // [B2] CREATE verb + SINGULAR "with 1 sub-category" (not "sub-categories"). Fail-on-revert:
  // change the `n === 1 ? 'y' : 'ies'` ternary and this exact string breaks.
  it('creating a parent with 1 attached child shows one "Category created, with 1 sub-category."', async () => {
    setParams({});
    categories = [LIVING('parking', 'Parking')];
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Transport');
    fireEvent.press(screen.getByText('Living'));
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual(['Category created, with 1 sub-category.']));
    expect(server.sent('POST', '/categories')).toHaveLength(1);
    expect(patchBodies('parking')).toEqual([{ name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' }]);
  });

  // [B3] UPDATE + one child fails: the FULL partial-failure string (leading "Category updated," +
  // singular "it") and it is the ONLY toast — children ran silent so nothing competes.
  it('a single failed child shows exactly one full "Category updated, but 1 sub-category couldn\'t be attached — add it from its page."', async () => {
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking')];
    server.once('PATCH', '/categories/parking', { status: 500 }); // self ok, child fails, NO per-op toast
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."]));
    expect(server.sent('PATCH', '/categories/parking')).toHaveLength(1);
    expect(routerSpies.back).toHaveBeenCalled(); // Option A: good parent is kept, not rolled back
  });

  // [B4] Two failures -> plural "sub-categories" + "add them". Fail-on-revert: the failed===1
  // singular branch would wrongly render "it"/"sub-category" here.
  it('two failed children show one plural "...2 sub-categories couldn\'t be attached — add them from its page."', async () => {
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
    server.once('PATCH', '/categories/parking', { status: 500 });
    server.once('PATCH', '/categories/petrol', { status: 500 });
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([
      "Category updated, but 2 sub-categories couldn't be attached — add them from its page."]));
  });

  // [B5] CREATE where the PARENT write fails: this screen OWNS the failure toast (the writer went
  // silent and threw), fires NO summary, does NOT navigate back, and never attempts child ops. A
  // failure with no server reason is unexpected, so the screen re-throws for the in-flight guard
  // to log.
  it('a failed parent create shows the failure toast, no summary, and does not navigate back', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setParams({});
    categories = [LIVING('parking', 'Parking')];
    server.once('POST', '/categories', { status: 500 }); // parent create fails
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Transport');
    fireEvent.press(screen.getByText('Living'));
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([GENERIC_SAVE_FAILURE]));
    expect(server.sent('POST', '/categories')).toHaveLength(1); // parent only — bailed before any child op
    expect(server.sentUnder('PATCH', '/categories')).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  // [B6] UPDATE where the parent self-save fails: same ownership as [B5] on the update branch.
  it('a failed parent update shows the failure toast, no summary, and does not navigate back', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport')];
    server.once('PATCH', '/categories/transport', { status: 500 }); // self update fails
    await drawEdit();
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([GENERIC_SAVE_FAILURE]));
    expect(server.sent('POST', '/categories')).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('categoryEditSubcategories', () => {
  beforeEach(() => { resetMocks({}); });

  it('creates the parent first, then attaches the picked child and creates the new inline child under it', async () => {
    categories = [
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', parent: null },
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', parent: null },
    ];
    await drawEdit();

    // Name the new parent + move it to Living (so the Living 'parking' becomes attachable).
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Transport');
    fireEvent.press(screen.getByText('Living'));
    // Attach the existing Living category 'parking'.
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    // Add a brand-new inline sub 'Tolls'.
    addNewChild('Tolls');

    await save();

    // WHIT-240: the parent + both children ran silent, so this screen fires exactly ONE summary
    // toast for the whole save — not the 3 per-op toasts that used to flicker. Fail-on-revert:
    // drop the success summary in edit.tsx and no toast shows.
    await waitFor(() => expect(shownToasts()).toEqual(['Category created, with 2 sub-categories.']));
    // Parent persisted first (top-level); the server names it 'transport'.
    expect(postBodies()).toEqual([
      expect.objectContaining({ name: 'Transport', bucket: 'Living', parent: null }),
      expect.objectContaining({ name: 'Tolls', bucket: 'Living', parent: 'transport' }),
    ]);
    // Existing child re-parented under the new parent (resends its own name/bucket/icon).
    expect(patchBodies('parking')).toEqual([{ name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' }]);
  });

  it('shows one plain toast when a new category is saved with no sub-categories', async () => {
    // WHIT-240: the no-children path still owns exactly one toast, matching the writer's old copy.
    categories = [];
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');
    await save();
    await waitFor(() => expect(shownToasts()).toEqual(['Category created.']));
    expect(postBodies()).toEqual([expect.objectContaining({ name: 'Groceries', parent: null })]);
  });

  it('a cross-bucket category is not offered as an attachable child', async () => {
    categories = [
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', parent: null },
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', parent: null },
    ];
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Transport');
    fireEvent.press(screen.getByText('Living'));
    // Living 'parking' is attachable; Lifestyle 'coffee' is not.
    expect(screen.getByTestId('attachChild-parking')).toBeTruthy();
    expect(screen.queryByTestId('attachChild-coffee')).toBeNull();
  });
});

describe('categoryEditSubcategoriesGaps', () => {
  beforeEach(() => { resetMocks({ categoryId: 'transport' }); });

  it('editing an existing parent updates it then attaches the picked child', async () => {
    categories = [
      { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', parent: null },
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', parent: null },
    ];
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(routerSpies.back).toHaveBeenCalled());
    // Self persisted via UPDATE (its own id), not created.
    expect(patchBodies('transport')).toEqual([{ name: 'Transport', bucket: 'Living', icon: 'car', parent: null }]);
    // Child re-parented under it, resending the child's OWN name/bucket/icon.
    expect(patchBodies('parking')).toEqual([{ name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' }]);
    expect(server.sent('POST', '/categories')).toEqual([]); // existing parent is never "created"
  });

  // [A3] A category already parented under this one is listed as "Already nested" and is NOT
  // re-offered in the attach list. Fail-on-revert: drop the `c.parent !== categoryId` filter and
  // attachChild-parking renders.
  it('a current child shows as Already nested and is not offered to re-attach', async () => {
    categories = [
      { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', parent: null },
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', parent: 'transport' }, // already a child
      { id: 'petrol', name: 'Petrol', bucket: 'Living', icon: 'car', color: '#8ab4f8', parent: null },         // free to attach
    ];
    await drawEdit();
    expect(screen.getByText(/Already nested: Parking/)).toBeTruthy();
    expect(screen.queryByTestId('attachChild-parking')).toBeNull();  // not re-offered
    expect(screen.getByTestId('attachChild-petrol')).toBeTruthy();   // an unrelated one still is
  });
});

describe('categoryEditParentClear', () => {
  beforeEach(() => { resetMocks({ categoryId: 'coffee' }); });

  it('drops a stale cross-bucket parent to top-level before saving', async () => {
    // coffee (Lifestyle) has a corrupt/legacy parent pointing at rent (Living) — a
    // cross-bucket link the server's same-bucket rule would never allow on write.
    categories = [
      { ...COFFEE, parent: 'rent' },
      { id: 'rent', name: 'Rent', bucket: 'Living', icon: 'home', color: '#8AB4F8', parent: null },
    ];
    await drawEdit();

    await save();

    // Saved with parent cleared to null — the invisible cross-bucket link is not re-persisted.
    await waitFor(() => expect(patchBodies('coffee')).toEqual([
      { ...COFFEE_SAVED, parent: null }]));
  });

  it('keeps a valid same-bucket parent through a save', async () => {
    categories = [
      { ...COFFEE, parent: 'treats' },
      { id: 'treats', name: 'Treats', bucket: 'Lifestyle', icon: 'gift', color: '#F0B27A', parent: null },
    ];
    await drawEdit();

    await save();

    await waitFor(() => expect(patchBodies('coffee')).toEqual([
      { ...COFFEE_SAVED, parent: 'treats' }]));
  });
});

describe('categoryEditParentPick', () => {
  beforeEach(() => { resetMocks({ categoryId: 'coffee' }); });

  it('picking a parent in the shared picker stamps it onto the saved category', async () => {
    // coffee (editing) starts top-level; treats is a same-bucket, eligible parent.
    categories = [
      { ...COFFEE, parent: null },
      { id: 'treats', name: 'Treats', bucket: 'Lifestyle', icon: 'gift', color: '#F0B27A', parent: null },
    ];
    await drawEdit();
    // 'Treats' shows twice: as the parent-picker chip (CategoryFields, rendered first) AND as an
    // attachable sub-category below. The parent chip is the first match — pick it, then save.
    const treatsChips = screen.getAllByText('Treats');
    expect(treatsChips.length).toBe(2); // guards the assumption: parent chip + attach chip
    fireEvent.press(treatsChips[0]);
    await save();

    await waitFor(() => expect(patchBodies('coffee')).toEqual([
      { ...COFFEE_SAVED, parent: 'treats' }]));
  });
});

describe('categoryEditDelete', () => {
  beforeEach(() => {
    resetMocks({ categoryId: 'coffee' });
    categories = [
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', parent: null },
    ];
  });

  it('pressing Delete category sends one DELETE, says so, and navigates back', async () => {
    await drawEdit();

    await act(async () => { fireEvent.press(screen.getByText('Delete category')); });

    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(server.sent('DELETE', '/categories/coffee')).toHaveLength(1);
    expect(shownToasts()).toEqual(['Category deleted.']);
  });

  // A failed delete says so, stays on the screen, and re-enables Delete so a retry runs. The old
  // "deleteCategory throws" case is gone: the real writer never throws — it routes every error to
  // its own failure toast and returns false.
  it('a failed delete shows the failure toast, stays put, and lets a retry run', async () => {
    server.once('DELETE', '/categories/coffee', { status: 500 });
    await drawEdit();

    await act(async () => { fireEvent.press(screen.getByText('Delete category')); });
    await waitFor(() => expect(shownToasts()).toEqual(['Could not delete category. Please try again.']));
    expect(routerSpies.back).not.toHaveBeenCalled();

    await act(async () => { fireEvent.press(screen.getByText('Delete category')); }); // only fires if re-enabled
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(server.sent('DELETE', '/categories/coffee')).toHaveLength(2);
  });
});

// ===== WHIT-459: folded from categoryEditReasonGaps.screen.test.tsx (WHIT-451 reason / save-failure family) =====
describe('categoryEditReasonGaps', () => {
  const CAP = 'a category can have at most 50 sub-categories';

  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    resetMocks({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
    // useInFlightGuard logs anything that escapes the screen's own handling; every test here
    // asserts on whether it did, so capture it rather than letting it colour the run.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { errorSpy.mockRestore(); });

  describe('[A40][A45][A46] a refused PARENT is handled, not leaked', () => {
    // The child ops are constructed AFTER the parent await. If the parent catch ever stopped
    // returning, those promises would be created and then dropped — Promise.allSettled is what
    // makes them safe, and nothing outside it awaits them.
    it('never starts the child writes when the parent is refused with a reason', async () => {
      server.once('PATCH', '/categories/transport', { status: 400, reason: CAP });
      await drawEdit();
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      addNewChild('Tolls');
      await save();

      // WHIT-240: still exactly one toast.
      await waitFor(() => expect(shownToasts()).toEqual(['A category can have at most 50 sub-categories.']));
      expect(server.sent('PATCH', '/categories/transport')).toHaveLength(1);
      expect(server.sent('PATCH', '/categories/parking')).toEqual([]); // no attach fired
      expect(server.sent('POST', '/categories')).toEqual([]);         // no orphan sub created under nothing
      expect(routerSpies.back).not.toHaveBeenCalled();
    });

    // The inverse of P3. `if (reason === null) throw error` is what keeps a HANDLED refusal out of
    // the log; drop the condition and every 50-cap refusal becomes a console.error too.
    it('does not re-throw a refusal it already explained', async () => {
      server.once('PATCH', '/categories/transport', { status: 400, reason: CAP });
      await drawEdit();
      await save();

      await waitFor(() => expect(shownToasts()).toHaveLength(1));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    // WHIT-249: the button must come back so the user can shorten the name / pick a new parent.
    it('re-enables Save after a refusal so the user can retry', async () => {
      server.once('PATCH', '/categories/transport', { status: 400, reason: CAP });
      await drawEdit();
      await save();
      await waitFor(() => expect(shownToasts()).toHaveLength(1));

      await save();
      await waitFor(() => expect(server.sent('PATCH', '/categories/transport')).toHaveLength(2));
    });
  });

  describe('[A41][A44][A47] the fold covers both child writers and ignores the successes', () => {
    // A SUCCESS must not dilute the shared reason — `reasons` is derived from `failures` only.
    // Invert that (map over `results`) and this goes red while every existing child test stays green.
    it('quotes the reason when one child succeeded and one was refused', async () => {
      server.once('PATCH', '/categories/petrol', { status: 400, reason: CAP });
      await drawEdit();
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      fireEvent.press(screen.getByTestId('attachChild-petrol'));
      await save();

      await waitFor(() => expect(shownToasts()).toEqual([
        `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`]));
    });

    // The 50-cap fires on CREATING a new sub as readily as on attaching one, and that path goes
    // through createCategoryInline — untouched by every existing child test.
    it('folds a reason from a refused NEW inline sub-category', async () => {
      server.once('POST', '/categories', { status: 400, reason: CAP });
      await drawEdit();
      addNewChild('Tolls');
      await save();

      await waitFor(() => expect(shownToasts()).toEqual([
        `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`]));
      expect(postBodies()).toEqual([expect.objectContaining({ name: 'Tolls', bucket: 'Living', parent: 'transport' })]);
    });

    // The realistic 50-cap shape: an attach AND a create, both refused by the same rule, via two
    // DIFFERENT writers. `reasons[0]` comparison is by string, so this must still fold.
    it('folds one shared reason across an attach and a create', async () => {
      server.once('PATCH', '/categories/parking', { status: 400, reason: CAP });
      server.once('POST', '/categories', { status: 400, reason: CAP });
      await drawEdit();
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      addNewChild('Tolls');
      await save();

      await waitFor(() => expect(shownToasts()).toEqual([
        `Category updated, but 2 sub-categories couldn't be attached — ${CAP}.`]));
    });
  });

  describe('[A42][A43] reason text that could break the folded line', () => {
    // Nothing between the server and this toast strips control characters: failed() only .trim()s
    // the ends. A multi-line reason must still produce ONE toast with the text intact — this pins
    // the current behaviour so a future sanitiser is a deliberate, visible change.
    it('folds a multi-line reason verbatim into a single toast', async () => {
      const multi = 'cannot attach:\nthe parent already has 50 sub-categories';
      server.once('PATCH', '/categories/parking', { status: 400, reason: multi });
      await drawEdit();
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      await save();

      await waitFor(() => expect(shownToasts()).toEqual([
        `Category updated, but 1 sub-category couldn't be attached — ${multi}.`]));
    });

    // The summary tail uses endSentence(reason) directly rather than writeFailureMessage, so the
    // "no full stop after the ellipsis" rule has to hold on THIS path too.
    it('ends a truncated reason with the ellipsis and no extra full stop', async () => {
      server.once('PATCH', '/categories/parking', { status: 400, reason: 'z'.repeat(200) });
      await drawEdit();
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      await save();

      await waitFor(() => expect(shownToasts()).toHaveLength(1));
      const line = shownToasts()[0];
      expect(line).toBe(`Category updated, but 1 sub-category couldn't be attached — ${'z'.repeat(159)}…`);
      expect(line.endsWith('….')).toBe(false);
    });

    // A refusal that already ends in a full stop must not gain a second one.
    it('does not double the full stop on an already-terminated reason', async () => {
      server.once('PATCH', '/categories/parking', { status: 409, reason: 'that name is taken.' });
      await drawEdit();
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      await save();

      await waitFor(() => expect(shownToasts()).toEqual([
        "Category updated, but 1 sub-category couldn't be attached — that name is taken."]));
    });
  });
});

describe('categoryEditChildReason', () => {
  const CAP = 'a category can have at most 50 sub-categories';

  beforeEach(() => {
    resetMocks({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
  });

  // The parent save succeeds; refuse only the child attaches.
  const refuseChildrenWith = (reply: Parameters<typeof server.once>[2]) => {
    server.once('PATCH', '/categories/parking', reply);
    server.once('PATCH', '/categories/petrol', reply);
  };

  // [C1] ONE child refused for a stated reason -> the reason replaces the generic tail.
  it('folds a single child refusal reason into the one summary toast', async () => {
    refuseChildrenWith({ status: 400, reason: CAP });
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    // WHIT-240 still holds: one toast.
    await waitFor(() => expect(shownToasts()).toEqual([
      `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`]));
    expect(routerSpies.back).toHaveBeenCalled();             // WHIT-237 Option A: a good parent is kept
  });

  // [C2] TWO children refused for the SAME reason -> one cause, stated once, plural count.
  it('folds a shared reason across two refused children', async () => {
    refuseChildrenWith({ status: 400, reason: CAP });
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([
      `Category updated, but 2 sub-categories couldn't be attached — ${CAP}.`]));
  });

  // [C3] TWO DIFFERENT reasons cannot honestly be summarised as one -> generic tail.
  it('keeps the generic tail when the failures had different reasons', async () => {
    server.once('PATCH', '/categories/parking', { status: 400, reason: CAP });
    server.once('PATCH', '/categories/petrol', { status: 400, reason: 'a sub-category must be in the same bucket as its parent' });
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([
      "Category updated, but 2 sub-categories couldn't be attached — add them from its page."]));
  });

  // [C4] A plain failure has no reason to give -> we must never invent one.
  it('keeps the generic tail for a network failure', async () => {
    refuseChildrenWith('dropped');
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."]));
  });

  // [C5] A reason cannot be attributed to a failure that never gave one.
  it('keeps the generic tail when a reasoned refusal is mixed with a failure that gave no reason', async () => {
    server.once('PATCH', '/categories/parking', { status: 400, reason: CAP });
    server.once('PATCH', '/categories/petrol', { status: 400 }); // petrol fails with nothing to say
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([
      "Category updated, but 2 sub-categories couldn't be attached — add them from its page."]));
  });

  // [C6] A 5xx is our fault, not a rule the user broke — never surface it.
  it('keeps the generic tail for a 500', async () => {
    refuseChildrenWith({ status: 500, reason: 'boom' });
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."]));
  });

  // [C7] WHIT-441/438 — when the destination is ALREADY at its child cap, "add it from its page" is
  // circular: that page refuses for the very same reason. Name the cap instead. A failure with no
  // stated reason is what routes here rather than to the server's own words.
  it('names the child cap instead of the circular advice when the parent is full', async () => {
    const kids = Array.from({ length: 50 }, (_, i) => LIVING(`kid${i}`, `Kid ${i}`, 'transport'));
    categories = [LIVING('transport', 'Transport'), LIVING('spare', 'Spare'), ...kids];
    server.once('PATCH', '/categories/spare', { status: 500 });  // the 'spare' attach fails, no reason
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-spare'));
    await save();

    // Fail-on-revert: restore the unconditional `add … from its page` tail → this reddens.
    await waitFor(() => expect(shownToasts()).toEqual([
      'Category updated, but 1 sub-category couldn\'t be attached — Transport already has the most sub-categories allowed (50).']));
  });
});

describe('categoryEditChildReasonGaps', () => {
  beforeEach(() => { resetMocks({}); });

  // A parent at 49 children is NOT full, so the "names the cap" branch must NOT fire → original advice.
  it('keeps the generic tail when the destination parent is one short of the cap (49)', async () => {
    setParams({ categoryId: 'transport' });
    const kids = Array.from({ length: MAX_CHILDREN_PER_CATEGORY - 1 }, (_, i) => LIVING(`kid${i}`, `Kid ${i}`, 'transport'));
    categories = [LIVING('transport', 'Transport'), LIVING('spare', 'Spare'), ...kids];
    server.once('PATCH', '/categories/spare', { status: 500 });   // 'spare' attach fails, no reason

    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-spare'));
    await save();

    // Fail-on-revert: change the guard to `>= 49` (or `> 50`) and this reddens — 49 must read as NOT full.
    await waitFor(() => expect(shownToasts()).toEqual([
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."]));
  });

  // A NEW parent: its server id is not in the `categories` the save started with, so
  // categories.find(parentId) misses → parentFull is false → original advice, never a bogus cap line.
  it('keeps the generic tail for a NEW category whose parent id is not in the cache yet', async () => {
    // A NEW category defaults to the Lifestyle bucket, and an attach candidate must share it.
    const SPARE: Category = { id: 'spare', name: 'Spare', bucket: 'Lifestyle', icon: 'coffee', color: '#fff', parent: null };
    categories = [SPARE];                                    // the only attachable child
    server.once('PATCH', '/categories/spare', { status: 500 });      // the 'spare' attach fails, no reason

    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Coffee');   // canSave needs a name
    fireEvent.press(screen.getByTestId('attachChild-spare'));
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([
      "Category created, but 1 sub-category couldn't be attached — add it from its page."]));
    expect(patchBodies('spare')).toEqual([{ name: 'Spare', bucket: 'Lifestyle', icon: 'coffee', parent: 'coffee' }]);
  });
});

describe('categoryEditSaveThrow', () => {
  beforeEach(() => { resetMocks({}); });

  // Restore any per-test console.error spy even if a test fails mid-body (targets console.error
  // only, so jest.setup's console.warn silence stays intact).
  afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

  // [A-catsave] CREATE branch: the parent write fails with no reason on the first press (the
  // connection dropped). The silent writer throws, the screen toasts and re-throws for the guard to
  // log. The button must re-enable so a retry sends a second time.
  it('re-enables Save so a retry runs after the parent create fails unexpectedly (create branch)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    server.once('POST', '/categories', 'dropped'); // 1st press: lost connection
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');

    await save(); // fails → guard logs, submitting reset
    await save(); // only fires if re-enabled

    // Sent TWICE = the visible `submitting` flag was reset by the catch (else press #2 early-returns).
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(server.sent('POST', '/categories')).toHaveLength(2);
    // The retry succeeded: the failure line, then the single summary toast.
    expect(shownToasts()).toEqual([GENERIC_SAVE_FAILURE, 'Category created.']);
    expect(errorSpy).toHaveBeenCalled(); // the guard logged the escaped throw (WHIT-249 contract)
  });

  // [A-catsave-update] Same guarantee on the UPDATE branch, where saveCategory is the parent write.
  it('re-enables Save so a retry runs after the parent update fails unexpectedly (edit branch)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport')];
    server.once('PATCH', '/categories/transport', 'dropped'); // 1st press fails
    await drawEdit();

    await save();
    await save();

    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(server.sent('PATCH', '/categories/transport')).toHaveLength(2);
    expect(shownToasts()).toEqual([GENERIC_SAVE_FAILURE, 'Category updated.']);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('categoryEditParentReason', () => {
  beforeEach(() => {
    resetMocks({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport')];
  });

  // [P1] the reason replaces the generic line, and a refused save does not navigate away.
  it('shows the server reason when the parent update is refused', async () => {
    server.once('PATCH', '/categories/transport', { status: 400, reason: 'a sub-category must be in the same bucket as its parent' });
    await drawEdit();
    await save();

    await waitFor(() => expect(shownToasts()).toEqual(['A sub-category must be in the same bucket as its parent.']));
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [P2] the 409 win — retrying a duplicate name never works, so saying "try again" was a lie.
  it('shows a 409 duplicate refusal on create', async () => {
    setParams({});
    categories = [];
    server.once('POST', '/categories', { status: 409, reason: 'category already exists' });
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');
    await save();

    await waitFor(() => expect(shownToasts()).toEqual(['Category already exists.']));
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [P3] WHIT-249: an unexplained failure is still logged. We toast the generic line AND re-throw,
  // so the in-flight guard's logging survives the new catch.
  it('falls back and still lets an unexplained failure reach the guard log', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    server.once('PATCH', '/categories/transport', 'dropped');
    await drawEdit();
    await save();

    await waitFor(() => expect(shownToasts()).toEqual([GENERIC_SAVE_FAILURE]));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // [P4] WHIT-282: a sign-out mid-save must not toast into the next session, even when the server
  // then refuses with a reason.
  it('stays silent when the session changed mid-save', async () => {
    await drawEdit();
    const held = server.hold('/categories/transport');
    await save();
    act(() => setAuthStatus('anon'));
    await act(async () => { held.fail('PATCH', { status: 400, reason: 'a category can have at most 50 sub-categories' }); });

    expect(server.sent('PATCH', '/categories/transport')).toHaveLength(1);
    expect(shownToasts()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });
});

// ===== WHIT-459: folded from categoryEditSignOutGuard.screen.test.tsx (WHIT-282 session-stamp guard) =====
// The parent or child write is held on the server, the user signs out while it waits, then the
// server answers. The screen must say nothing and stay put.
describe('categoryEditSignOutGuard', () => {
  beforeEach(() => { resetMocks({}); });

  // [A-EDIT-PARENT] A session change lands during the parent UPDATE write, which then fails. The
  // epoch guard must bail silently: NO toast, NO router.back().
  // Fail-on-revert: drop the epoch guard after the update → the `if (!ok)` generic toast fires.
  it('a session change on the parent update write shows no toast and does not navigate', async () => {
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport')];
    await drawEdit();
    const held = server.hold('/categories/transport');

    await save();
    act(() => setAuthStatus('anon'));
    await act(async () => { held.fail('PATCH', { status: 500 }); });

    expect(server.sent('PATCH', '/categories/transport')).toHaveLength(1);
    expect(shownToasts()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A-EDIT-CREATE] The parent CREATE path. A session change lands during the create; the guard
  // must bail silently. Holding /categories also holds its reads, so nothing settles in between.
  // Fail-on-revert: drop the epoch guard after the create → the `if (!created)` generic toast fires.
  it('a session change on the parent create write shows no toast and does not navigate', async () => {
    setParams({}); // no categoryId → the create path
    await drawEdit();
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'New cat'); // canSave needs a name
    const held = server.hold('/categories');

    await save();
    act(() => setAuthStatus('anon'));
    await act(async () => { held.fail('POST'); });

    expect(server.sent('POST', '/categories')).toHaveLength(1);
    expect(shownToasts()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A-EDIT-REAUTH] THE CARD'S BUG: a DIFFERENT account fully signs in mid-save. Status is 'authed'
  // again (so the old getStatus()==='anon' guard would PASS), and the server even answers the old
  // save with a success — only the EPOCH tells the screen this isn't its session. The guard must
  // bail: NO 'Category updated' summary toast, NO router.back() into the new session.
  // Fail-on-revert: restore `getStatus() === 'anon'` → status 'authed' → guard passes → toast fires.
  it('a different-account sign-in mid-save (epoch bumped, status authed) shows no toast and does not navigate', async () => {
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport')];
    await drawEdit();
    const held = server.hold('/categories/transport');

    await save();
    act(() => setAuthStatus('anon'));
    act(() => setAuthStatus('authed'));
    await act(async () => { held.release(); });

    expect(server.sent('PATCH', '/categories/transport')).toHaveLength(1);
    expect(shownToasts()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A-EDIT-CHILD] Parent succeeds in-session; the session change lands DURING the child writes.
  // The post-Promise.allSettled guard must bail: NO summary toast, NO nav.
  it('a session change during the child writes fires no summary toast and does not navigate', async () => {
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking')];
    await drawEdit();
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    const held = server.hold('/categories/parking');

    await save();
    await waitFor(() => expect(server.sent('PATCH', '/categories/parking')).toHaveLength(1));
    act(() => setAuthStatus('anon'));
    await act(async () => { held.fail('PATCH'); });

    expect(server.sent('PATCH', '/categories/transport')).toHaveLength(1);
    expect(shownToasts()).toEqual([]);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A-EDIT-CONTROL] Regression: with NO session change, a genuine in-session FAILURE must STILL
  // toast — the guard must not over-suppress the real error path.
  it('an in-session parent-save failure still shows the failure toast (guard does not over-suppress)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setParams({ categoryId: 'transport' });
    categories = [LIVING('transport', 'Transport')];
    server.once('PATCH', '/categories/transport', { status: 500 }); // real failure, same session
    await drawEdit();

    await save();

    await waitFor(() => expect(shownToasts()).toEqual([GENERIC_SAVE_FAILURE]));
    expect(routerSpies.back).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ===== WHIT-459: folded from categoryEditColdSeed.screen.test.tsx (WHIT-203 cold-cache seed guard) =====
// The category list is held on the server, so the screen mounts over a cold taxonomy and it lands
// a beat later on release().
describe('categoryEditColdSeed', () => {
  beforeEach(() => {
    resetMocks({ categoryId: 'coffee' });
    server.seed('/categories', [{ ...COFFEE_RECORD, parent: null }]);
  });

  const drawCold = async () => {
    const held = server.hold('/categories');
    render(<WithApp><CategoryEdit /></WithApp>);
    await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(1));
    return held;
  };

  it('blocks Save while the edited category is still loading (no default-overwrite)', async () => {
    const held = await drawCold();
    // Type a name so the ONLY thing blocking Save is the editing-unloaded guard (not an empty
    // name) — this is what gives the test teeth: without the guard, Save would fire here and
    // write the default bucket/icon over the real category.
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Renamed');
    await save();
    expect(server.sentUnder('PATCH', '/categories')).toEqual([]);
    await refreshInAct(() => held.release());
  });

  it('re-seeds the form once the category resolves (late)', async () => {
    // Cold at mount: the useState initializer seeds blank. This is the case the useEffect
    // exists for — asserting a warm mount would only exercise the initializer, not the fix.
    const held = await drawCold();
    expect(screen.getByPlaceholderText('e.g. Coffee runs').props.value).toBe('');

    // The category list lands a beat later → the useEffect re-seeds the form from it.
    await refreshInAct(() => held.release());
    await waitFor(() => expect(screen.getByDisplayValue('Cafes & Coffee')).toBeTruthy());
  });
});
