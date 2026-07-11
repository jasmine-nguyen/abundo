// WHIT-221 hardening: the category-edit parent picker must never silently re-save a
// stale/cross-bucket parent link. If the edited category loads with a parent that isn't
// a valid same-bucket option, the validity effect drops it to top-level, so Save writes
// parent: null rather than persisting the bad link the picker can't even show.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { Category } from '../context';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => true);
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, deleteCategory: jest.fn(), showToast: jest.fn() }) };
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
