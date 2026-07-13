// WHIT-237 — adversarial gaps the implementer's categoryEditSubcategories suite leaves open.
// That suite only drives a NEW parent (createCategoryInline path). Here:
//   [A1] editing an EXISTING parent takes the saveCategory(self) branch, THEN attaches;
//   [A3] a category already parented here shows as "Already nested" and is NOT in the attach list.
// (Partial-failure summary copy — parent kept, single warning toast — is covered by the
//  verb×count×failure matrix in categoryEditSummaryToast [B3]/[B4], WHIT-240.)
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
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, createCategoryInline: mockCreateInline, deleteCategory: jest.fn(), showToast: mockShowToast, getSessionEpoch: () => 0 }) };
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
