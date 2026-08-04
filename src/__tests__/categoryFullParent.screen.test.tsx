// WHIT-441 item 1 — the parent picker greys out a parent already at its 50-child limit, so the
// user can't pick one the server would only refuse. THE LANDMINE: the category's OWN held parent
// must stay selectable even when full — re-saving under it adds no child, and greying it out would
// let a plain rename silently detach the category. Driven through the real edit host.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { Category } from '../context';
import { MAX_CHILDREN_PER_CATEGORY } from '../context';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => true);
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, deleteCategory: jest.fn(), showToast: jest.fn(), getSessionEpoch: () => 0 }) };
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

const cat = (id: string, parent: string | null): Category =>
  ({ id, name: id, bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0, parent });
const childrenOf = (parent: string, n: number, prefix: string): Category[] =>
  Array.from({ length: n }, (_, i) => cat(`${prefix}${i}`, parent));

beforeEach(() => { mockSaveCategory.mockClear(); });

it('greys out a parent at the child cap, and a tap on it does nothing', () => {
  // 'treats' already holds the maximum children; 'coffee' (top-level, being edited) is not one of
  // them, so attaching it would overflow — the chip must be disabled.
  mockCategories = [
    cat('coffee', null),
    cat('treats', null),
    ...childrenOf('treats', MAX_CHILDREN_PER_CATEGORY, 'kid'),
  ];
  render(<CategoryEdit />);

  expect(screen.getByText('treats · full')).toBeTruthy();     // greyed + labelled
  fireEvent.press(screen.getByTestId('parent-treats'));        // disabled → no-op
  act(() => { fireEvent.press(screen.getByText('Save category')); });

  // Fail-on-revert: drop the `full`/disabled logic → the tap selects 'treats' → parent:'treats'.
  expect(mockSaveCategory).toHaveBeenCalledWith('coffee', expect.objectContaining({ parent: null }), { silent: true });
});

it('keeps the category’s OWN full parent selectable — a plain rename never detaches it', () => {
  // 'coffee' already sits under 'treats', which is at the cap (coffee is one of its 50 children).
  // From coffee's side treats is NOT full — re-saving under it adds nothing — so it must stay
  // pickable. This is the landmine: greying the held parent would let a rename drop the link.
  mockCategories = [
    cat('coffee', 'treats'),
    cat('treats', null),
    ...childrenOf('treats', MAX_CHILDREN_PER_CATEGORY - 1, 'kid'),   // + coffee = 50
  ];
  render(<CategoryEdit />);

  expect(screen.queryByText('treats · full')).toBeNull();     // held parent is never greyed
  // Deselect then re-pick the held parent, then save: it must land back on 'treats'.
  fireEvent.press(screen.getByText('None (top-level)'));
  fireEvent.press(screen.getByTestId('parent-treats'));
  act(() => { fireEvent.press(screen.getByText('Save category')); });

  // Fail-on-revert: drop the `p.id !== heldParentId` guard → treats is greyed + disabled → the
  // re-pick is a no-op → save writes parent:null → this assertion fails.
  expect(mockSaveCategory).toHaveBeenCalledWith('coffee', expect.objectContaining({ parent: 'treats' }), { silent: true });
});
