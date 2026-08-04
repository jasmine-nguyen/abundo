// WHIT-437 — THE CARD'S OWN JOURNEY. Adding sub-categories is where the 50-child limit actually
// fires: the refusal comes from the CHILD writes (edit.tsx attach/create), not the parent save.
// Those children must stay silent — WHIT-240 promises exactly one summary toast — so the reason
// rides back on the rejection and is folded into that single line.
//
// The honesty rule under test: fold a reason ONLY when every failure gave the SAME one. A mix of
// causes summarised as one cause would be a fabricated explanation, which is the bug this card is
// about, one level up.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';
import { ApiError } from '../apiError';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true as boolean);
const mockCreateInline = jest.fn(async (form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => ({
  id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null,
}) as unknown as Category | null);
const mockShowToast = jest.fn();
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, createCategoryInline: mockCreateInline, deleteCategory: jest.fn(), showToast: mockShowToast, getSessionEpoch: () => 0 }) };
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
