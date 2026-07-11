// WHIT-239 GAP (host regression) — the edit screen's parent picker is now rendered by the shared
// CategoryFields, wired parent→setParent via onParentChange. The implementer's categoryEditParentClear
// suite only proves a parent that was ALREADY loaded survives (or is dropped) through save; it never
// proves that a parent the USER picks in the (extracted) picker flows onto the saved category. This
// closes that gap through the real host: tap the 'Treats' chip → Save writes parent:'treats'.
// Fail-on-revert: unwire onParentChange in CategoryFields and the tap is a no-op → save writes null.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { Category } from '../context';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: { name: string; bucket: string; icon: string; parent?: string | null }) => true);
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, deleteCategory: jest.fn() }) };
});

let mockCategories: Category[] = [];
const mockCategory = (id: string | null) => mockCategories.find((c) => c.id === id);
jest.mock('../../src/queries', () => ({
  useCategories: () => ({ category: mockCategory, categories: mockCategories, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({ categoryId: 'coffee' }),
}));

import CategoryEdit from '../../app/category/edit';

beforeEach(() => { mockSaveCategory.mockClear(); });

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

  expect(mockSaveCategory).toHaveBeenCalledWith('coffee', expect.objectContaining({ parent: 'treats' }));
});
