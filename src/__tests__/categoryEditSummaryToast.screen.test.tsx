// WHIT-240 — the summary-toast matrix the implementer's happy-path test leaves open.
// Their categoryEditSubcategories suite locks ONLY the CREATE + 2-children (plural, all-ok)
// summary and the no-children create. This adversarial suite drives the real edit.tsx save()
// across the verb x count x failure axes that must read correctly:
//   [B1] UPDATE + 2 ok        -> "Category updated, with 2 sub-categories."   (update verb, plural)
//   [B2] CREATE + 1 ok        -> "Category created, with 1 sub-category."     (singular "with")
//   [B3] UPDATE + 1 fails     -> full "...but 1 sub-category couldn't be attached — add it..."
//   [B4] UPDATE + 2 fail      -> plural "...2 sub-categories... add them..."
//   [B5] CREATE parent fails  -> failure toast, NO summary, router.back NOT called
//   [B6] UPDATE parent fails  -> failure toast, NO summary, router.back NOT called
// Every case asserts the FULL string AND toast-call COUNT (children run silent, so exactly one
// toast may fire — no per-op toast competes). That single-count is the WHIT-240 promise.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true as boolean);
const mockCreateInline = jest.fn(async (form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => ({
  id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null,
}) as unknown as Category | null);
const mockShowToast = jest.fn();
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, createCategoryInline: mockCreateInline, deleteCategory: jest.fn(), showToast: mockShowToast }) };
});

let mockCategories: Category[] = [];
const mockCategory = (id: string | null) => mockCategories.find((c) => c.id === id);
jest.mock('../../src/queries', () => ({
  useCategories: () => ({ category: mockCategory, categories: mockCategories, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
}));

const mockBack = jest.fn();
// Mutable params so one file can drive both the CREATE (no id) and UPDATE (id) branches.
let mockParams: { categoryId?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import CategoryEdit from '../../app/category/edit';

const LIVING = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });

beforeEach(() => {
  mockParams = {};
  mockCategories = [];
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockShowToast.mockClear(); mockBack.mockClear();
});

// [B1] UPDATE verb + plural all-ok. Fail-on-revert: flip `verb` to a constant 'created' and the
// exact-string match fails; drop the summary block and the count assertion fails.
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
