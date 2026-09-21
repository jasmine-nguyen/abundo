// Category-edit screen tests (WHIT-451 + WHIT-459 consolidation): every app/category/edit suite.
// WHIT-451 merged categoryEditSummaryToast + categoryEditSubcategories + categoryEditSubcategoriesGaps
// + categoryEditParentClear + categoryEditParentPick + categoryEditDelete. WHIT-459 folded in the
// reason / save-failure family (categoryEditReasonGaps), the session-stamp guard
// (categoryEditSignOutGuard) and the cold-cache seed guard (categoryEditColdSeed) — see the
// // ===== headers below. All suites drive the real host with a SUPERSET mock of ../../src/context,
// ../../src/queries and expo-router; each keeps its own scoped beforeEach so its params/seed can't
// leak. deleteCategory is a hoisted mock so the delete suite can assert it; createCategoryInline is
// inert for the suites that never call it. The union carries three extras the siblings needed: the
// ../auth stub + the `mockEpoch` session stamp (getSessionEpoch reads it; only SignOutGuard bumps it)
// and a reassignable `mockCategory` (only ColdSeed reassigns it) — all inert for every other suite.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { ScrollView } from 'react-native';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';
import { MAX_CHILDREN_PER_CATEGORY } from '../context';
import { ApiError } from '../apiError';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true as boolean);
const mockCreateInline = jest.fn(async (form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => ({
  id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null,
}) as unknown as Category | null);
const mockShowToast = jest.fn();
const mockDeleteCategory = jest.fn(async (_id: string) => true);
// WHIT-459 union (folded from categoryEditSignOutGuard): the SignOutGuard suite bumps this session
// stamp mid-save; every other suite leaves it 0 (resetMocks / their own beforeEach re-zero it).
let mockEpoch = 0;
// SignOutGuard also stubs ../auth so the real context (requireActual below) resolves its auth import
// deterministically. INERT for every other suite — the screen keys on the epoch, never getStatus.
jest.mock('../../src/auth', () => ({ getStatus: () => 'authed' }));
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, createCategoryInline: mockCreateInline, deleteCategory: mockDeleteCategory, showToast: mockShowToast, getSessionEpoch: () => mockEpoch }) };
});

let mockCategories: Category[] = [];
// `let` (was const) so the WHIT-459-folded ColdSeed suite can reassign it to model a cold/late
// taxonomy resolve; every other suite leaves this default derivation in place (ColdSeed is folded
// LAST so its reassignment can't leak into another suite).
let mockCategory: (id: string | null) => Category | undefined = (id) => mockCategories.find((c) => c.id === id);
jest.mock('../../src/queries', () => ({
  useCategories: () => ({ category: mockCategory, categories: mockCategories, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
}));

const mockBack = jest.fn();
let mockParams: { categoryId?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import CategoryEdit from '../../app/category/edit';

const LIVING = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });

// Reset EVERY shared mock to a clean default per test — clearMocks wipes calls but NOT
// implementations or the module-level `mockParams`/`mockCategories`, so each suite's beforeEach must
// re-establish them or a prior suite's override leaks in.
function resetMocks(params: { categoryId?: string }) {
  mockParams = params;
  mockCategories = [];
  mockEpoch = 0;
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockShowToast.mockClear();
  mockDeleteCategory.mockClear(); mockDeleteCategory.mockImplementation(async () => true);
  mockBack.mockClear();
}

describe('categoryEditSummaryToast', () => {
  beforeEach(() => { resetMocks({}); });

  it('editing a parent and attaching 2 children shows one "Category updated, with 2 sub-categories."', async () => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category updated, with 2 sub-categories.'));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockBack).toHaveBeenCalled();
  });
  
  // [B2] CREATE verb + SINGULAR "with 1 sub-category" (not "sub-categories"). Fail-on-revert:
  // change the `n === 1 ? 'y' : 'ies'` ternary and this exact string breaks.
  it('creating a parent with 1 attached child shows one "Category created, with 1 sub-category."', async () => {
    mockParams = {};
    mockCategories = [LIVING('parking', 'Parking')];
    render(<CategoryEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Transport');
    fireEvent.press(screen.getByText('Living'));
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category created, with 1 sub-category.'));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [B3] UPDATE + one child fails: the FULL partial-failure string (leading "Category updated," +
  // singular "it") and it is the ONLY toast — children ran silent so nothing competes. The existing
  // Gaps [A2] test only asserts stringContaining and injects its own competing toast, so it cannot
  // prove the single-count nor the leading verb clause. This does.
  it('a single failed child shows exactly one full "Category updated, but 1 sub-category couldn\'t be attached — add it from its page."', async () => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking')];
    mockSaveCategory.mockImplementation(async (id) => id !== 'parking'); // self ok, child fails, NO per-op toast
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockBack).toHaveBeenCalled(); // Option A: good parent is kept, not rolled back
  });
  
  // [B4] Two failures -> plural "sub-categories" + "add them". Fail-on-revert: the failed===1
  // singular branch would wrongly render "it"/"sub-category" here.
  it('two failed children show one plural "...2 sub-categories couldn\'t be attached — add them from its page."', async () => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
    mockSaveCategory.mockImplementation(async (id) => id === 'transport'); // self ok, both children fail
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 2 sub-categories couldn't be attached — add them from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [B5] CREATE where the PARENT write fails: this screen OWNS the failure toast (the writer went
  // silent), fires NO summary, does NOT navigate back, and never attempts child ops.
  it('a failed parent create shows the failure toast, no summary, and does not navigate back', async () => {
    mockParams = {};
    mockCategories = [];
    mockCreateInline.mockResolvedValue(null); // parent create fails
    render(<CategoryEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not save category. Please try again.'));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockCreateInline).toHaveBeenCalledTimes(1); // parent only — bailed before any child op
    expect(mockSaveCategory).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });
  
  // [B6] UPDATE where the parent self-save fails: same ownership as [B5] on the update branch.
  it('a failed parent update shows the failure toast, no summary, and does not navigate back', async () => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport')];
    mockSaveCategory.mockResolvedValue(false); // self update fails
    render(<CategoryEdit />);
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not save category. Please try again.'));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockCreateInline).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('categoryEditSubcategories', () => {
  beforeEach(() => { resetMocks({}); });

  it('creates the parent first, then attaches the picked child and creates the new inline child under it', async () => {
    mockCategories = [
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', recent: 0, parent: null },
    ];
    render(<CategoryEdit />);
  
    // Name the new parent + move it to Living (so the Living 'parking' becomes attachable).
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Transport');
    fireEvent.press(screen.getByText('Living'));
    // Attach the existing Living category 'parking'.
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    // Add a brand-new inline sub 'Tolls'.
    fireEvent.press(screen.getByText('＋ New sub-category'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Tolls');
    fireEvent.press(screen.getByText('Add sub-category'));
  
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    // Parent persisted first (top-level), yielding id 'transport'.
    expect(mockCreateInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'Transport', bucket: 'Living', parent: null }), { silent: true });
    await waitFor(() => {
      // Existing child re-parented under the new parent (resends its own name/bucket/icon).
      expect(mockSaveCategory).toHaveBeenCalledWith('parking', expect.objectContaining({ parent: 'transport', bucket: 'Living' }), { silent: true });
      // New inline child created under the new parent.
      expect(mockCreateInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'Tolls', bucket: 'Living', parent: 'transport' }), { silent: true });
    });
    // WHIT-240: the parent + both children ran silent, so this screen fires exactly ONE summary
    // toast for the whole save — not the 3 per-op toasts that used to flicker. Fail-on-revert:
    // drop the success summary in edit.tsx and this is called 0 times.
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category created, with 2 sub-categories.'));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  it('shows one plain toast when a new category is saved with no sub-categories', async () => {
    // WHIT-240: the no-children path still owns exactly one toast, matching the writer's old copy.
    mockCategories = [];
    render(<CategoryEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
    await waitFor(() => expect(mockCreateInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'Groceries' }), { silent: true }));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith('Category created.');
  });
  
  it('a cross-bucket category is not offered as an attachable child', () => {
    mockCategories = [
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', recent: 0, parent: null },
    ];
    render(<CategoryEdit />);
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
    mockCategories = [
      { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
    ];
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => {
      // Self persisted via UPDATE (its own id), not created.
      expect(mockSaveCategory).toHaveBeenCalledWith('transport', expect.objectContaining({ name: 'Transport', bucket: 'Living' }), { silent: true });
      // Child re-parented under it, resending the child's OWN name/bucket/icon.
      expect(mockSaveCategory).toHaveBeenCalledWith('parking', expect.objectContaining({ name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' }), { silent: true });
    });
    expect(mockCreateInline).not.toHaveBeenCalled(); // existing parent is never "created"
    expect(mockBack).toHaveBeenCalled();
  });
  
  // [A3] A category already parented under this one is listed as "Already nested" and is NOT
  // re-offered in the attach list. Fail-on-revert: drop the `c.parent !== categoryId` filter and
  // attachChild-parking renders.
  it('a current child shows as Already nested and is not offered to re-attach', () => {
    mockCategories = [
      { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: 'transport' }, // already a child
      { id: 'petrol', name: 'Petrol', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },         // free to attach
    ];
    render(<CategoryEdit />);
    expect(screen.getByText(/Already nested: Parking/)).toBeTruthy();
    expect(screen.queryByTestId('attachChild-parking')).toBeNull();  // not re-offered
    expect(screen.getByTestId('attachChild-petrol')).toBeTruthy();   // an unrelated one still is
  });
});

describe('categoryEditParentClear', () => {
  beforeEach(() => { resetMocks({ categoryId: 'coffee' }); });

  it('drops a stale cross-bucket parent to top-level before saving', () => {
    // coffee (Lifestyle) has a corrupt/legacy parent pointing at rent (Living) — a
    // cross-bucket link the server's same-bucket rule would never allow on write.
    mockCategories = [
      { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0, parent: 'rent' },
      { id: 'rent', name: 'Rent', bucket: 'Living', icon: 'home', color: '#8AB4F8', recent: 0, parent: null },
    ];
    render(<CategoryEdit />);
  
    act(() => { fireEvent.press(screen.getByText('Save category')); });
  
    // Saved with parent cleared to null — the invisible cross-bucket link is not re-persisted.
    expect(mockSaveCategory).toHaveBeenCalledWith('coffee', expect.objectContaining({ parent: null }), { silent: true });
  });
  
  it('keeps a valid same-bucket parent through a save', () => {
    mockCategories = [
      { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0, parent: 'treats' },
      { id: 'treats', name: 'Treats', bucket: 'Lifestyle', icon: 'gift', color: '#F0B27A', recent: 0, parent: null },
    ];
    render(<CategoryEdit />);
  
    act(() => { fireEvent.press(screen.getByText('Save category')); });
  
    expect(mockSaveCategory).toHaveBeenCalledWith('coffee', expect.objectContaining({ parent: 'treats' }), { silent: true });
  });
});

describe('categoryEditParentPick', () => {
  beforeEach(() => { resetMocks({ categoryId: 'coffee' }); });

  it('picking a parent in the shared picker stamps it onto the saved category', () => {
    // coffee (editing) starts top-level; treats is a same-bucket, eligible parent.
    mockCategories = [
      { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0, parent: null },
      { id: 'treats', name: 'Treats', bucket: 'Lifestyle', icon: 'gift', color: '#F0B27A', recent: 0, parent: null },
    ];
    render(<CategoryEdit />);
    // 'Treats' shows twice: as the parent-picker chip (CategoryFields, rendered first) AND as an
    // attachable sub-category below. The parent chip is the first match — pick it, then save.
    const treatsChips = screen.getAllByText('Treats');
    expect(treatsChips.length).toBe(2); // guards the assumption: parent chip + attach chip
    fireEvent.press(treatsChips[0]);
    act(() => { fireEvent.press(screen.getByText('Save category')); });
  
    expect(mockSaveCategory).toHaveBeenCalledWith('coffee', expect.objectContaining({ parent: 'treats' }), { silent: true });
  });
});

describe('categoryEditDelete', () => {
  beforeEach(() => { resetMocks({ categoryId: 'coffee' }); });
  afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

  it('pressing Delete category calls deleteCategory once and navigates back', async () => {
    mockCategories = [
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', recent: 0, parent: null },
    ];
    render(<CategoryEdit />);
  
    await act(async () => { fireEvent.press(screen.getByText('Delete category')); });
  
    // The real onPress→remove()→deleteCategory chain fired (the mock is only the writer boundary).
    expect(mockDeleteCategory).toHaveBeenCalledTimes(1);
    expect(mockDeleteCategory).toHaveBeenCalledWith('coffee');
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });
  
  // WHIT-249: an UNEXPECTED deleteCategory throw used to leave Delete stuck disabled (the caller's
  // setSubmitting(false) sits on the else branch a throw skips). The handler now resets `submitting`
  // in a catch (and re-throws so the guard logs). Fail-on-revert: drop the catch → the 2nd press
  // early-returns on the stuck `submitting` flag → deleteCategory called only once.
  it('re-enables Delete so a retry runs after deleteCategory throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockCategories = [
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', recent: 0, parent: null },
    ];
    mockDeleteCategory.mockRejectedValueOnce(new Error('network blew up'));
    render(<CategoryEdit />);
  
    await act(async () => { fireEvent.press(screen.getByText('Delete category')); }); // throws → guard logs
    await act(async () => { fireEvent.press(screen.getByText('Delete category')); }); // only fires if re-enabled
  
    expect(mockDeleteCategory).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled();
  });
  
  // The Save + Delete buttons live at the bottom of the form scroll, so the keyboard opens over
  // them. The scroll must inset for the keyboard AND keep taps alive, or they're unreachable while
  // typing. Fail-on-revert: drop the props in app/category/edit.tsx → find() returns undefined.
  it('wraps the form in a keyboard-inset, tap-persisting scroll so Save/Delete stay reachable', () => {
    mockCategories = [{ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', recent: 0, parent: null }];
    const { UNSAFE_getAllByType } = render(<CategoryEdit />);
    const formScroll = UNSAFE_getAllByType(ScrollView).find(
      (sv) => sv.props.automaticallyAdjustKeyboardInsets === true && sv.props.keyboardShouldPersistTaps === 'handled',
    );
    expect(formScroll).toBeTruthy();
    // Save must live INSIDE that insetted scroll — that's what keeps it reachable over the keyboard.
    expect(formScroll!.findAll((n) => n === screen.getByText('Save category'))).toHaveLength(1);
  });
});

// ===== WHIT-459: folded from categoryEditReasonGaps.screen.test.tsx (WHIT-451 reason / save-failure family, 24 its) =====
describe('categoryEditReasonGaps', () => {
  
  const CAP = 'a category can have at most 50 sub-categories';
  const LIVING = (id: string, name: string, parent: string | null = null): Category =>
    ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });
  
  let errorSpy: ReturnType<typeof jest.spyOn>;
  
  beforeEach(() => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
    mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
    mockCreateInline.mockClear();
    mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
    mockShowToast.mockClear(); mockBack.mockClear();
    // useInFlightGuard logs anything that escapes the screen's own handling; every test here
    // asserts on whether it did, so capture it rather than letting it colour the run.
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { errorSpy.mockRestore(); });
  
  const save = async () => { await act(async () => { fireEvent.press(screen.getByText('Save category')); }); };
  /** Queue a brand-new inline sub-category (the createCategoryInline half of the child writes). */
  const addNewChild = (name: string) => {
    fireEvent.press(screen.getByText('＋ New sub-category'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), name);
    fireEvent.press(screen.getByText('Add sub-category'));
  };
  
  describe('[A40][A45][A46] a refused PARENT is handled, not leaked', () => {
    // The child ops are constructed AFTER the parent await. If the parent catch ever stopped
    // returning, those promises would be created and then dropped — Promise.allSettled is what
    // makes them safe, and nothing outside it awaits them.
    it('never starts the child writes when the parent is refused with a reason', async () => {
      mockSaveCategory.mockRejectedValue(new ApiError(400, CAP));
      render(<CategoryEdit />);
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      addNewChild('Tolls');
      await save();
  
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
        'A category can have at most 50 sub-categories.'));
      expect(mockSaveCategory).toHaveBeenCalledTimes(1);      // the parent only — no attach fired
      expect(mockSaveCategory).toHaveBeenCalledWith('transport', expect.anything(), { silent: true });
      expect(mockCreateInline).not.toHaveBeenCalled();        // no orphan sub created under nothing
      expect(mockShowToast).toHaveBeenCalledTimes(1);         // WHIT-240: still exactly one toast
      expect(mockBack).not.toHaveBeenCalled();
    });
  
    // The inverse of P3. `if (reason === null) throw error` is what keeps a HANDLED refusal out of
    // the log; drop the condition and every 50-cap refusal becomes a console.error too.
    it('does not re-throw a refusal it already explained', async () => {
      mockSaveCategory.mockRejectedValue(new ApiError(400, CAP));
      render(<CategoryEdit />);
      await save();
  
      await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
      expect(errorSpy).not.toHaveBeenCalled();
    });
  
    // WHIT-249: the button must come back so the user can shorten the name / pick a new parent.
    it('re-enables Save after a refusal so the user can retry', async () => {
      mockSaveCategory.mockRejectedValue(new ApiError(400, CAP));
      render(<CategoryEdit />);
      await save();
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledTimes(1));
  
      await save();
      await waitFor(() => expect(mockSaveCategory).toHaveBeenCalledTimes(2));
    });
  });
  
  describe('[A41][A44][A47] the fold covers both child writers and ignores the successes', () => {
    // A SUCCESS must not dilute the shared reason — `reasons` is derived from `failures` only.
    // Invert that (map over `results`) and this goes red while every existing child test stays green.
    it('quotes the reason when one child succeeded and one was refused', async () => {
      mockSaveCategory.mockImplementation(async (id) => {
        if (id === 'transport' || id === 'parking') return true;
        throw new ApiError(400, CAP);
      });
      render(<CategoryEdit />);
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      fireEvent.press(screen.getByTestId('attachChild-petrol'));
      await save();
  
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
        `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`));
      expect(mockShowToast).toHaveBeenCalledTimes(1);
    });
  
    // The 50-cap fires on CREATING a new sub as readily as on attaching one, and that path goes
    // through createCategoryInline — untouched by every existing child test.
    it('folds a reason from a refused NEW inline sub-category', async () => {
      mockCreateInline.mockRejectedValue(new ApiError(400, CAP));
      render(<CategoryEdit />);
      addNewChild('Tolls');
      await save();
  
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
        `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`));
      expect(mockShowToast).toHaveBeenCalledTimes(1);
    });
  
    // The realistic 50-cap shape: an attach AND a create, both refused by the same rule, via two
    // DIFFERENT writers. `reasons[0]` comparison is by string, so this must still fold.
    it('folds one shared reason across an attach and a create', async () => {
      mockSaveCategory.mockImplementation(async (id) => {
        if (id === 'transport') return true;
        throw new ApiError(400, CAP);
      });
      mockCreateInline.mockRejectedValue(new ApiError(400, CAP));
      render(<CategoryEdit />);
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      addNewChild('Tolls');
      await save();
  
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
        `Category updated, but 2 sub-categories couldn't be attached — ${CAP}.`));
      expect(mockShowToast).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('[A42][A43] reason text that could break the folded line', () => {
    // Nothing between the server and this toast strips control characters: failed() only .trim()s
    // the ends. A multi-line reason must still produce ONE toast with the text intact — this pins
    // the current behaviour so a future sanitiser is a deliberate, visible change.
    it('folds a multi-line reason verbatim into a single toast', async () => {
      const multi = 'cannot attach:\nthe parent already has 50 sub-categories';
      mockSaveCategory.mockImplementation(async (id) => {
        if (id === 'transport') return true;
        throw new ApiError(400, multi);
      });
      render(<CategoryEdit />);
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      await save();
  
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
        `Category updated, but 1 sub-category couldn't be attached — ${multi}.`));
      expect(mockShowToast).toHaveBeenCalledTimes(1);
    });
  
    // The summary tail uses endSentence(reason) directly rather than writeFailureMessage, so the
    // "no full stop after the ellipsis" rule has to hold on THIS path too.
    it('ends a truncated reason with the ellipsis and no extra full stop', async () => {
      mockSaveCategory.mockImplementation(async (id) => {
        if (id === 'transport') return true;
        throw new ApiError(400, 'z'.repeat(200));
      });
      render(<CategoryEdit />);
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      await save();
  
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledTimes(1));
      const line = mockShowToast.mock.calls[0][0] as string;
      expect(line).toBe(`Category updated, but 1 sub-category couldn't be attached — ${'z'.repeat(159)}…`);
      expect(line.endsWith('….')).toBe(false);
    });
  
    // A refusal that already ends in a full stop must not gain a second one.
    it('does not double the full stop on an already-terminated reason', async () => {
      mockSaveCategory.mockImplementation(async (id) => {
        if (id === 'transport') return true;
        throw new ApiError(409, 'that name is taken.');
      });
      render(<CategoryEdit />);
      fireEvent.press(screen.getByTestId('attachChild-parking'));
      await save();
  
      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
        "Category updated, but 1 sub-category couldn't be attached — that name is taken."));
    });
  });
});

describe('categoryEditChildReason', () => {
  
  const CAP = 'a category can have at most 50 sub-categories';
  const LIVING = (id: string, name: string, parent: string | null = null): Category =>
    ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });
  
  beforeEach(() => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
    mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
    mockCreateInline.mockClear();
    mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
    mockShowToast.mockClear(); mockBack.mockClear();
  });
  
  // The parent save is call #1; the child attaches follow. Reject only the child ones.
  const rejectChildrenWith = (error: unknown) =>
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      throw error;
    });
  
  // [C1] ONE child refused for a stated reason -> the reason replaces the generic tail.
  it('folds a single child refusal reason into the one summary toast', async () => {
    rejectChildrenWith(new ApiError(400, CAP));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`));
    expect(mockShowToast).toHaveBeenCalledTimes(1);   // WHIT-240 still holds
    expect(mockBack).toHaveBeenCalled();             // WHIT-237 Option A: a good parent is kept
  });
  
  // [C2] TWO children refused for the SAME reason -> one cause, stated once, plural count.
  it('folds a shared reason across two refused children', async () => {
    rejectChildrenWith(new ApiError(400, CAP));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      `Category updated, but 2 sub-categories couldn't be attached — ${CAP}.`));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C3] TWO DIFFERENT reasons cannot honestly be summarised as one -> generic tail.
  it('keeps the generic tail when the failures had different reasons', async () => {
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      throw new ApiError(400, id === 'parking' ? CAP : 'a sub-category must be in the same bucket as its parent');
    });
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 2 sub-categories couldn't be attached — add them from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C4] A plain failure has no reason to give -> we must never invent one.
  it('keeps the generic tail for a network failure', async () => {
    rejectChildrenWith(new Error('network blew up'));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C5] A reason cannot be attributed to a failure that never gave one.
  it('keeps the generic tail when a reasoned refusal is mixed with a bare falsy failure', async () => {
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      if (id === 'parking') throw new ApiError(400, CAP);
      return false;                                   // petrol fails with nothing to say
    });
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 2 sub-categories couldn't be attached — add them from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C6] A 5xx is our fault, not a rule the user broke — never surface it.
  it('keeps the generic tail for a 500', async () => {
    rejectChildrenWith(new ApiError(500, 'boom'));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C7] WHIT-441/438 — when the destination is ALREADY at its child cap, "add it from its page" is
  // circular: that page refuses for the very same reason. Name the cap instead. A failure with no
  // stated reason (a bare falsy result) is what routes here rather than to the server's own words.
  it('names the child cap instead of the circular advice when the parent is full', async () => {
    const kids = Array.from({ length: 50 }, (_, i) => LIVING(`kid${i}`, `Kid ${i}`, 'transport'));
    mockCategories = [LIVING('transport', 'Transport'), LIVING('spare', 'Spare'), ...kids];
    mockSaveCategory.mockImplementation(async (id) => id === 'transport');  // the 'spare' attach fails, no reason
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-spare'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    // Fail-on-revert: restore the unconditional `add … from its page` tail → this reddens.
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      'Category updated, but 1 sub-category couldn\'t be attached — Transport already has the most sub-categories allowed (50).'));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
});

describe('categoryEditChildReasonGaps', () => {
  
  const LIVING = (id: string, name: string, parent: string | null = null): Category =>
    ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });
  
  beforeEach(() => {
    mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
    mockCreateInline.mockClear();
    mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
    mockShowToast.mockClear();
  });
  
  // A parent at 49 children is NOT full, so the "names the cap" branch must NOT fire → original advice.
  it('keeps the generic tail when the destination parent is one short of the cap (49)', async () => {
    mockParams = { categoryId: 'transport' };
    const kids = Array.from({ length: MAX_CHILDREN_PER_CATEGORY - 1 }, (_, i) => LIVING(`kid${i}`, `Kid ${i}`, 'transport'));
    mockCategories = [LIVING('transport', 'Transport'), LIVING('spare', 'Spare'), ...kids];
    mockSaveCategory.mockImplementation(async (id) => id === 'transport');   // 'spare' attach fails, no reason
  
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-spare'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    // Fail-on-revert: change the guard to `>= 49` (or `> 50`) and this reddens — 49 must read as NOT full.
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // A NEW parent: its server id (from createCategoryInline) is not in the cached `categories`, so
  // categories.find(parentId) misses → parentFull is false → original advice, never a bogus cap line.
  it('keeps the generic tail for a NEW category whose parent id is not in the cache yet', async () => {
    mockParams = {};                                             // create mode, no categoryId
    // A NEW category defaults to the Lifestyle bucket, and an attach candidate must share it.
    const SPARE: Category = { id: 'spare', name: 'Spare', bucket: 'Lifestyle', icon: 'coffee', color: '#fff', recent: 0, parent: null };
    mockCategories = [SPARE];                                    // the only attachable child
    mockCreateInline.mockImplementation(async (form) => ({ id: 'coffee', name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
    mockSaveCategory.mockImplementation(async () => false);      // the 'spare' attach fails, no reason
  
    render(<CategoryEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Coffee');   // canSave needs a name
    fireEvent.press(screen.getByTestId('attachChild-spare'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category created, but 1 sub-category couldn't be attached — add it from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
});

describe('categoryEditSaveThrow', () => {
  
  beforeEach(() => {
    mockParams = {};
    mockCategories = [];
    mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
    mockCreateInline.mockClear();
    mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
    mockShowToast.mockClear(); mockBack.mockClear();
  });
  
  // Restore any per-test console.error spy even if a test fails mid-body (targets console.error
  // only, so jest.setup's console.warn silence stays intact).
  afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });
  
  // [A-catsave] CREATE branch: the parent write THROWS on the first press (network/JSON blew up,
  // not a handled false). The button must re-enable so a retry runs the writer a second time.
  it('re-enables Save so a retry runs after the parent create throws (create branch)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockParams = {}; // no categoryId → CREATE → createCategoryInline is the parent write
    mockCategories = [];
    mockCreateInline.mockRejectedValueOnce(new Error('network blew up')); // 1st press: unexpected throw
    render(<CategoryEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');
  
    await act(async () => { fireEvent.press(screen.getByText('Save category')); }); // throws → guard logs, submitting reset
    await act(async () => { fireEvent.press(screen.getByText('Save category')); }); // only fires if re-enabled
  
    // Called TWICE = the visible `submitting` flag was reset by the catch (else press #2 early-returns).
    expect(mockCreateInline).toHaveBeenCalledTimes(2);
    // The retry succeeded: single summary toast + navigation.
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category created.'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled(); // the guard logged the escaped throw (WHIT-249 contract)
  });
  
  // [A-catsave-update] Same guarantee on the UPDATE branch, where saveCategory is the parent write.
  it('re-enables Save so a retry runs after the parent update throws (edit branch)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockParams = { categoryId: 'transport' };
    mockCategories = [{ id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null }];
    mockSaveCategory.mockRejectedValueOnce(new Error('network blew up')); // 1st press throws
    render(<CategoryEdit />);
  
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    expect(mockSaveCategory).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category updated.'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('categoryEditParentReason', () => {
  
  const LIVING = (id: string, name: string, parent: string | null = null): Category =>
    ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });
  
  beforeEach(() => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport')];
    mockEpoch = 0;
    mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
    mockCreateInline.mockClear();
    mockCreateInline.mockImplementation(async () => null); // ParentReason's original module default
    mockShowToast.mockClear(); mockBack.mockClear();
  });
  
  // [P1] the reason replaces the generic line, and a refused save does not navigate away.
  it('shows the server reason when the parent update is refused', async () => {
    mockSaveCategory.mockRejectedValue(new ApiError(400, 'a sub-category must be in the same bucket as its parent'));
    render(<CategoryEdit />);
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      'A sub-category must be in the same bucket as its parent.'));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockBack).not.toHaveBeenCalled();
  });
  
  // [P2] the 409 win — retrying a duplicate name never works, so saying "try again" was a lie.
  it('shows a 409 duplicate refusal on create', async () => {
    mockParams = {};
    mockCategories = [];
    mockCreateInline.mockRejectedValue(new ApiError(409, 'category already exists'));
    render(<CategoryEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category already exists.'));
    expect(mockBack).not.toHaveBeenCalled();
  });
  
  // [P3] WHIT-249: an unexplained failure is still logged. We toast the generic line AND re-throw,
  // so the in-flight guard's logging survives the new catch.
  it('falls back and still lets an unexplained failure reach the guard log', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSaveCategory.mockRejectedValue(new Error('network blew up'));
    render(<CategoryEdit />);
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not save category. Please try again.'));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
  
  // [P4] WHIT-282: a sign-out mid-save must not toast into the next session.
  it('stays silent when the session changed mid-save', async () => {
    mockSaveCategory.mockImplementation(async () => { mockEpoch = 1; throw new ApiError(400, 'a category can have at most 50 sub-categories'); });
    render(<CategoryEdit />);
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });
});

// ===== WHIT-459: folded from categoryEditSignOutGuard.screen.test.tsx (WHIT-282 session-stamp guard, 5 its) =====
// Its top-level beforeEach is scoped here so it can't run before the other suites' tests.
describe('categoryEditSignOutGuard', () => {
const LIVING = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });

beforeEach(() => {
  mockEpoch = 0;
  mockParams = {};
  mockCategories = [];
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockShowToast.mockClear(); mockBack.mockClear();
});

// [A-EDIT-PARENT] A session change lands during the parent UPDATE write (writer bumps the epoch and
// returns its failure sentinel). The :100 guard must bail silently: NO toast, NO router.back().
// Fail-on-revert: drop the :100 epoch guard → the `if (!ok)` generic toast fires → this test fails.
it('a session change on the parent update write shows no toast and does not navigate', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  mockSaveCategory.mockImplementation(async () => { mockEpoch += 1; return false; });
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockSaveCategory).toHaveBeenCalled());
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-CREATE] The parent CREATE path (:104), previously unpinned. A session change lands during
// createCategoryInline (bumps the epoch, returns null). The :104 guard must bail silently.
// Fail-on-revert: drop the :104 epoch guard → the `if (!created)` generic toast fires → fails.
it('a session change on the parent create write shows no toast and does not navigate', async () => {
  mockParams = {}; // no categoryId → the create path
  render(<CategoryEdit />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'New cat'); // canSave needs a name
  mockCreateInline.mockImplementation(async () => { mockEpoch += 1; return null; });

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockCreateInline).toHaveBeenCalled());
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-REAUTH] THE CARD'S BUG: a DIFFERENT account fully signs in mid-save. Status is 'authed'
// again (so the old getStatus()==='anon' guard would PASS), but the epoch bumped. The writer even
// returns a SUCCESS-shaped value — so only the EPOCH tells the screen this isn't its session. The
// guard must bail: NO 'Category updated' summary toast, NO router.back() into the new session.
// Fail-on-revert: restore `getStatus() === 'anon'` → status 'authed' → guard passes → toast + nav fire.
it('a different-account sign-in mid-save (epoch bumped, status authed) shows no toast and does not navigate', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  mockSaveCategory.mockImplementation(async () => { mockEpoch += 1; return true; }); // re-auth: success-shaped, new session
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockSaveCategory).toHaveBeenCalled());
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-CHILD] Parent succeeds in-session (epoch unchanged, ok=true); the session change lands
// DURING the child writes. The post-Promise.allSettled guard (:122) must bail: NO summary toast, NO nav.
it('a session change during the child writes fires no summary toast and does not navigate', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking')];
  let call = 0;
  mockSaveCategory.mockImplementation(async () => {
    call += 1;
    if (call === 1) return true; // parent self-save succeeds in-session
    mockEpoch += 1;              // session change lands during the child write
    return false;
  });
  render(<CategoryEdit />);
  fireEvent.press(screen.getByTestId('attachChild-parking'));

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockSaveCategory).toHaveBeenCalledTimes(2));
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-CONTROL] Regression: with NO session change (epoch stays 0), a genuine in-session FAILURE
// must STILL toast — the guard must not over-suppress the real error path.
it('an in-session parent-save failure still shows the failure toast (guard does not over-suppress)', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  mockSaveCategory.mockResolvedValue(false); // real failure, epoch unchanged
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not save category. Please try again.'));
  expect(mockBack).not.toHaveBeenCalled();
});
});

// ===== WHIT-459: folded from categoryEditColdSeed.screen.test.tsx (WHIT-203 cold-cache seed guard, 2 its) =====
// Folded LAST: its it bodies reassign the shared `mockCategory`, so no other suite may run after it.
// The scoped beforeEach re-establishes ColdSeed's original fixture (categoryId:'coffee', empty
// taxonomy, default derivation) that the now-shared expo-router / queries mocks otherwise wouldn't give it.
describe('categoryEditColdSeed', () => {
const COFFEE: Category = { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 };
  beforeEach(() => {
    mockParams = { categoryId: 'coffee' };
    mockCategories = [];
    mockCategory = (id) => mockCategories.find((c) => c.id === id);
    mockSaveCategory.mockClear();
  });

it('blocks Save while the edited category is still loading (no default-overwrite)', () => {
  mockCategory = () => undefined; // taxonomy not loaded yet
  render(<CategoryEdit />);
  // Type a name so the ONLY thing blocking Save is the editing-unloaded guard (not an empty
  // name) — this is what gives the test teeth: without the guard, Save would fire here and
  // write the default bucket/icon over the real category.
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Renamed');
  fireEvent.press(screen.getByText('Save category'));
  expect(mockSaveCategory).not.toHaveBeenCalled();
});

it('re-seeds the form once the category resolves (late)', () => {
  // Cold at mount: the useState initializer seeds blank. This is the case the useEffect
  // exists for — asserting a warm mount would only exercise the initializer, not the fix.
  mockCategory = () => undefined;
  const { rerender } = render(<CategoryEdit />);
  expect(screen.getByPlaceholderText('e.g. Coffee runs').props.value).toBe('');

  // The category resolves a beat later → the useEffect re-seeds the form from it.
  mockCategory = (id) => (id === 'coffee' ? COFFEE : undefined);
  rerender(<CategoryEdit />);
  expect(screen.getByDisplayValue('Cafes & Coffee')).toBeTruthy();
});
});
