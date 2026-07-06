// WHIT-203 GAP — category/edit seeds its form from the cached taxonomy, which may resolve
// AFTER mount (cold cache / deep-link). Locks the two safety properties of that fix:
//   (1) while editing a category whose taxonomy hasn't loaded, Save is BLOCKED (else a save
//       would write the default bucket/icon over the real category — data loss);
//   (2) once the category resolves, the form re-seeds from it (name shows the real value).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { Category } from '../context';

const mockSaveCategory = jest.fn(async () => true);
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, deleteCategory: jest.fn() }) };
});

let mockCategory: (id: string | null) => Category | undefined;
jest.mock('../../src/queries', () => ({ useCategories: () => ({ category: mockCategory, categories: [], isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }) }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({ categoryId: 'coffee' }), // editing an existing category
}));

import CategoryEdit from '../../app/category/edit';

const COFFEE: Category = { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 };

beforeEach(() => { mockSaveCategory.mockClear(); });

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
