// WHIT-250: happy-path tap test for the Delete-category button. The WHIT-241 double-tap
// latch is unit-covered, but nothing ever PRESSED the real button — so an onPress rewired to
// the wrong handler (or a future refactor dropping the guard wrapper) would slip through.
// This presses the real button and asserts the writer fires once + navigation, so a revert
// (rewire onPress in app/category/edit.tsx) turns it red.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';

// Hoisted module-scope mocks so navigation + the writer are assertable across renders:
// useRouter() returns a FRESH object each render, so an inline jest.fn() couldn't be checked.
const mockDeleteCategory = jest.fn(async (_id: string) => true);
const mockBack = jest.fn();

jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ deleteCategory: mockDeleteCategory, saveCategory: jest.fn(async () => true), createCategoryInline: jest.fn(), showToast: jest.fn() }) };
});

let mockCategories: Category[] = [];
const mockCategory = (id: string | null) => mockCategories.find((c) => c.id === id);
jest.mock('../../src/queries', () => ({
  useCategories: () => ({ category: mockCategory, categories: mockCategories, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
}));

// categoryId set → the Delete button mounts (it renders only for an existing category).
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  useLocalSearchParams: () => ({ categoryId: 'coffee' }),
}));

import CategoryEdit from '../../app/category/edit';

beforeEach(() => { mockDeleteCategory.mockClear(); mockBack.mockClear(); });

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
