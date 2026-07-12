// WHIT-249 — [A-catsave] the category CREATE/SAVE button re-enables after an UNEXPECTED
// writer throw. Gap: the WHIT-249 caller re-enable pattern is tested for goal save/delete,
// budget save, and category DELETE — but NOT for this screen's `save` handler, whose body is
// the most complex (parent write + child Promise.allSettled + summary toast) and whose known-
// failure branches (`!ok`/`!created`) reset `submitting` while a THROW skips them. The handler
// now resets `submitting` in a catch (and re-throws so the useInFlightGuard logs it).
// Fail-on-revert: drop the catch in app/category/edit.tsx save() → the first (throwing) press
// leaves `submitting` stuck true → `canSave` stays false → the 2nd press early-returns →
// createCategoryInline is called ONCE, not twice → this reddens.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
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
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, createCategoryInline: mockCreateInline, deleteCategory: jest.fn(), showToast: mockShowToast }) };
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

beforeEach(() => {
  mockParams = {};
  mockCategories = [];
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockShowToast.mockClear(); mockBack.mockClear();
});

// Restore any per-test console.error spy even if a test fails mid-body (targets console.error
// only, so jest.setup's console.warn silence stays intact).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

// [A-catsave] CREATE branch: the parent write THROWS on the first press (network/JSON blew up,
// not a handled false). The button must re-enable so a retry runs the writer a second time.
it('re-enables Save so a retry runs after the parent create throws (create branch)', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockParams = {}; // no categoryId → CREATE → createCategoryInline is the parent write
  mockCategories = [];
  mockCreateInline.mockRejectedValueOnce(new Error('network blew up')); // 1st press: unexpected throw
  render(<CategoryEdit />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');

  await act(async () => { fireEvent.press(screen.getByText('Save category')); }); // throws → guard logs, submitting reset
  await act(async () => { fireEvent.press(screen.getByText('Save category')); }); // only fires if re-enabled

  // Called TWICE = the visible `submitting` flag was reset by the catch (else press #2 early-returns).
  expect(mockCreateInline).toHaveBeenCalledTimes(2);
  // The retry succeeded: single summary toast + navigation.
  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category created.'));
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(errorSpy).toHaveBeenCalled(); // the guard logged the escaped throw (WHIT-249 contract)
});

// [A-catsave-update] Same guarantee on the UPDATE branch, where saveCategory is the parent write.
it('re-enables Save so a retry runs after the parent update throws (edit branch)', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockParams = { categoryId: 'transport' };
  mockCategories = [{ id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null }];
  mockSaveCategory.mockRejectedValueOnce(new Error('network blew up')); // 1st press throws
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  expect(mockSaveCategory).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category updated.'));
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(errorSpy).toHaveBeenCalled();
});
