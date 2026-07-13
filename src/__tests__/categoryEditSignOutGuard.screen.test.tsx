// WHIT-271 round-2 — the app/category/edit.tsx SCREEN guard `if (getStatus() === 'anon')`, added
// after the parent-save await (line ~100) AND after the child-ops Promise.allSettled (line ~122).
// Round-1 F1: this screen toasts on BOTH success and failure and router.back()s, so a writer that
// merely returns its FAILURE sentinel after a mid-save sign-out would still leak a generic toast +
// navigate into the next session. The screen guard bails silently. Every committed WHIT-271 test is
// hook/provider-level — NONE renders app/category/edit.tsx, so this screen guard is otherwise
// unpinned. Mock pattern mirrors categoryEditSummaryToast.screen.test.tsx.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';

// A controllable auth status so a mock writer can flip the session to 'anon' mid-save, exactly
// like a real sign-out landing during the round-trip. `mock`-prefixed so the jest.mock factory
// may reference it (jest's out-of-scope-variable allowance).
let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
jest.mock('../../src/auth', () => ({ getStatus: () => mockStatus }));

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

const LIVING = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });

beforeEach(() => {
  mockStatus = 'authed';
  mockParams = {};
  mockCategories = [];
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockShowToast.mockClear(); mockBack.mockClear();
});

// [A-EDIT-PARENT] The writer returns its FAILURE sentinel (false) after a mid-save sign-out AND the
// session is now 'anon'. The screen guard must bail silently: NO 'Could not save category' toast,
// NO router.back(). Fail-on-revert: delete the `if (getStatus() === 'anon')` line after the parent
// await and the `if (!ok)` branch fires the generic toast → this test fails.
it('a mid-save sign-out on the parent write shows no toast and does not navigate', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  // Model the real post-sign-out state: the writer returns false AND getStatus is now 'anon'.
  mockSaveCategory.mockImplementation(async () => { mockStatus = 'anon'; return false; });
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  // Give any un-awaited summary/toast a chance to fire, then assert it never did.
  await waitFor(() => expect(mockSaveCategory).toHaveBeenCalled());
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-CHILD] Parent saves fine IN-SESSION (status stays 'authed', ok=true), then the sign-out
// lands DURING the child writes. The post-child guard must bail: NO summary toast, NO router.back().
// Fail-on-revert: delete the `if (getStatus() === 'anon')` line after the Promise.allSettled and the
// summary toast ("Category updated, but 1 sub-category couldn't be attached…") + router.back() fire.
it('a sign-out during the child writes fires no summary toast and does not navigate', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking')];
  let call = 0;
  mockSaveCategory.mockImplementation(async () => {
    call += 1;
    if (call === 1) return true;      // parent self-save succeeds in-session (status still 'authed')
    mockStatus = 'anon';              // sign-out lands during the child write
    return false;                     // writer's post-sign-out sentinel
  });
  render(<CategoryEdit />);
  fireEvent.press(screen.getByTestId('attachChild-parking'));

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockSaveCategory).toHaveBeenCalledTimes(2)); // parent + child both ran
  expect(mockShowToast).not.toHaveBeenCalled(); // no summary toast into the next session
  expect(mockBack).not.toHaveBeenCalled();      // no navigation into the next session
});

// [A-EDIT-CONTROL] Regression: with NO sign-out (status stays 'authed'), a genuine in-session
// FAILURE must STILL toast — the guard must not over-suppress the real error path. Proves
// `getStatus() === 'anon'` is the ONLY thing the guard keys on.
it('an in-session parent-save failure still shows the failure toast (guard does not over-suppress)', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  mockSaveCategory.mockResolvedValue(false); // real failure, status stays 'authed'
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not save category. Please try again.'));
  expect(mockBack).not.toHaveBeenCalled();
});
