// WHIT-250: happy-path tap test for the Delete-category button. The WHIT-241 double-tap
// latch is unit-covered, but nothing ever PRESSED the real button — so an onPress rewired to
// the wrong handler (or a future refactor dropping the guard wrapper) would slip through.
// This presses the real button and asserts the writer fires once + navigation, so a revert
// (rewire onPress in app/category/edit.tsx) turns it red.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';
import type { Category } from '../context';

// Hoisted module-scope mocks so navigation + the writer are assertable across renders:
// useRouter() returns a FRESH object each render, so an inline jest.fn() couldn't be checked.
const mockDeleteCategory = jest.fn(async (_id: string) => true);
const mockBack = jest.fn();

jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ deleteCategory: mockDeleteCategory, saveCategory: jest.fn(async () => true), createCategoryInline: jest.fn(), showToast: jest.fn(), getSessionEpoch: () => 0 }) };
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

// Restore any per-test console.error spy even if a test fails mid-body (targets console.error
// only, so jest.setup's console.warn silence stays intact).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

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

// WHIT-249: an UNEXPECTED deleteCategory throw used to leave Delete stuck disabled (the caller's
// setSubmitting(false) sits on the else branch a throw skips). The handler now resets `submitting`
// in a catch (and re-throws so the guard logs). Fail-on-revert: drop the catch → the 2nd press
// early-returns on the stuck `submitting` flag → deleteCategory called only once.
it('re-enables Delete so a retry runs after deleteCategory throws', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockCategories = [
    { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', recent: 0, parent: null },
  ];
  mockDeleteCategory.mockRejectedValueOnce(new Error('network blew up'));
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Delete category')); }); // throws → guard logs
  await act(async () => { fireEvent.press(screen.getByText('Delete category')); }); // only fires if re-enabled

  expect(mockDeleteCategory).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(errorSpy).toHaveBeenCalled();
});

// The Save + Delete buttons live at the bottom of the form scroll, so the keyboard opens over
// them. The scroll must inset for the keyboard AND keep taps alive, or they're unreachable while
// typing. Fail-on-revert: drop the props in app/category/edit.tsx → find() returns undefined.
it('wraps the form in a keyboard-inset, tap-persisting scroll so Save/Delete stay reachable', () => {
  mockCategories = [{ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a87c', recent: 0, parent: null }];
  const { UNSAFE_getAllByType } = render(<CategoryEdit />);
  const formScroll = UNSAFE_getAllByType(ScrollView).find(
    (sv) => sv.props.automaticallyAdjustKeyboardInsets === true && sv.props.keyboardShouldPersistTaps === 'handled',
  );
  expect(formScroll).toBeTruthy();
  // Save must live INSIDE that insetted scroll — that's what keeps it reachable over the keyboard.
  expect(formScroll!.findAll((n) => n === screen.getByText('Save category'))).toHaveLength(1);
});
