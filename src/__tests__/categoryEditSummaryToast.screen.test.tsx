// Category-edit screen tests (WHIT-451 consolidation): the subcategories / summary / parent-pick /
// delete family. Merged from categoryEditSummaryToast + categoryEditSubcategories +
// categoryEditSubcategoriesGaps + categoryEditParentClear + categoryEditParentPick +
// categoryEditDelete. All six drive the real app/category/edit host with an identical (superset)
// mock of ../../src/context, ../../src/queries and expo-router; each suite keeps its own scoped
// beforeEach so its params/seed can't leak. deleteCategory is a hoisted mock so the delete suite can
// assert it; the parent-pick suites never invoke createCategoryInline, so its presence is inert.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { ScrollView } from 'react-native';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true as boolean);
const mockCreateInline = jest.fn(async (form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => ({
  id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null,
}) as unknown as Category | null);
const mockShowToast = jest.fn();
const mockDeleteCategory = jest.fn(async (_id: string) => true);
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, createCategoryInline: mockCreateInline, deleteCategory: mockDeleteCategory, showToast: mockShowToast, getSessionEpoch: () => 0 }) };
});

let mockCategories: Category[] = [];
const mockCategory = (id: string | null) => mockCategories.find((c) => c.id === id);
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
