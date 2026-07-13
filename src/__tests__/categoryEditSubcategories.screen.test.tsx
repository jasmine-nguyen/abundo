// WHIT-237: build the family from the parent's page. Creating a NEW parent with children
// must persist the parent FIRST (to get its id), then re-parent the picked existing children
// and create the new inline ones UNDER that id.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true);
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

// NEW category (no categoryId) so save() takes the create-then-attach path.
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

import CategoryEdit from '../../app/category/edit';

beforeEach(() => { mockSaveCategory.mockClear(); mockCreateInline.mockClear(); mockShowToast.mockClear(); });

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
