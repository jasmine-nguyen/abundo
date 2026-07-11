// WHIT-237 — adversarial gaps the implementer's categoryEditSubcategories suite leaves open.
// That suite only drives a NEW parent (createCategoryInline path). Here:
//   [A1] editing an EXISTING parent takes the saveCategory(self) branch, THEN attaches;
//   [A2] a child re-parent that fails keeps the parent + fires the warning toast LAST;
//   [A3] a category already parented here shows as "Already nested" and is NOT in the attach list.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown) => true as boolean);
const mockCreateInline = jest.fn(async (form: { name: string; bucket: string; icon: string; parent?: string | null }) => ({
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
// EXISTING category (categoryId supplied) so save() takes the saveCategory(self)+attach path.
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  useLocalSearchParams: () => ({ categoryId: 'transport' }),
}));

import CategoryEdit from '../../app/category/edit';

beforeEach(() => {
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear(); mockShowToast.mockClear(); mockBack.mockClear();
});

// [A1] EXISTING parent: self is UPDATED (saveCategory with its id), not created, then the child
// is re-parented under it. Fail-on-revert: route the existing branch through createCategoryInline
// and the self saveCategory('transport', …) call vanishes.
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
    expect(mockSaveCategory).toHaveBeenCalledWith('transport', expect.objectContaining({ name: 'Transport', bucket: 'Living' }));
    // Child re-parented under it, resending the child's OWN name/bucket/icon.
    expect(mockSaveCategory).toHaveBeenCalledWith('parking', expect.objectContaining({ name: 'Parking', bucket: 'Living', icon: 'car', parent: 'transport' }));
  });
  expect(mockCreateInline).not.toHaveBeenCalled(); // existing parent is never "created"
  expect(mockBack).toHaveBeenCalled();
});

// [A2] A child re-parent that returns false → parent kept, warning toast fires, singular copy,
// and it is the LAST toast (overriding the per-op error the failing writer showed).
it('a failed child attach keeps the parent and fires the warning toast last', async () => {
  mockCategories = [
    { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
    { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
  ];
  // Self saves fine; the child re-parent fails AND toasts its own generic error (like the real writer).
  mockSaveCategory.mockImplementation(async (id: string | null) => {
    if (id === 'parking') { mockShowToast('Could not save category. Please try again.'); return false; }
    return true;
  });
  render(<CategoryEdit />);
  fireEvent.press(screen.getByTestId('attachChild-parking'));
  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining("1 sub-category couldn't be attached")));
  // Singular copy for exactly one failure ("sub-category", not "sub-categories").
  const warning = mockShowToast.mock.calls.map((c) => c[0] as string).find((m) => m.includes("couldn't be attached"))!;
  expect(warning).toContain('sub-category ');
  expect(warning).not.toContain('sub-categories');
  // Fired LAST, so it overrides the per-op error the failing child showed.
  expect(mockShowToast.mock.calls[mockShowToast.mock.calls.length - 1][0]).toBe(warning);
  expect(mockBack).toHaveBeenCalled(); // parent kept; user is returned to its page
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
