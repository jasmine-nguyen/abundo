// WHIT-282 — the app/category/edit.tsx SCREEN guard now keys on the SESSION STAMP
// (`s.getSessionEpoch()`) captured at save start, not `getStatus() === 'anon'`. This screen toasts
// on BOTH success and failure and router.back()s from its OWN local result, so it needs a guard the
// writers' return-false can't provide. Keying on the epoch makes it bail on ANY session change
// mid-save — sign-out OR a different-account re-auth (status back to 'authed'), the case the old
// getStatus check missed. Three guard sites: after the parent UPDATE (:100), the parent CREATE
// (:104), and the child Promise.allSettled (:122). This screen is otherwise unpinned.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';

// The session stamp the screen captures at save start and re-reads across the await. A writer bumps
// it mid-save to model a session change (sign-out OR re-auth). `mock`-prefixed for jest's factory rule.
let mockEpoch = 0;
// The screen no longer reads getStatus, but the real context module (requireActual below) imports
// ../auth at load — stub it so that import resolves without pulling the real auth module.
jest.mock('../../src/auth', () => ({ getStatus: () => 'authed' }));

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true as boolean);
const mockCreateInline = jest.fn(async (form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => ({
  id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null,
}) as unknown as Category | null);
const mockShowToast = jest.fn();
jest.mock('../../src/context', () => {
  const actual = jest.requireActual('../../src/context') as typeof import('../../src/context');
  return { ...actual, useAppContext: () => ({ saveCategory: mockSaveCategory, createCategoryInline: mockCreateInline, deleteCategory: jest.fn(), showToast: mockShowToast, getSessionEpoch: () => mockEpoch }) };
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
  mockEpoch = 0;
  mockParams = {};
  mockCategories = [];
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockShowToast.mockClear(); mockBack.mockClear();
});

// [A-EDIT-PARENT] A session change lands during the parent UPDATE write (writer bumps the epoch and
// returns its failure sentinel). The :100 guard must bail silently: NO toast, NO router.back().
// Fail-on-revert: drop the :100 epoch guard → the `if (!ok)` generic toast fires → this test fails.
it('a session change on the parent update write shows no toast and does not navigate', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  mockSaveCategory.mockImplementation(async () => { mockEpoch += 1; return false; });
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockSaveCategory).toHaveBeenCalled());
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-CREATE] The parent CREATE path (:104), previously unpinned. A session change lands during
// createCategoryInline (bumps the epoch, returns null). The :104 guard must bail silently.
// Fail-on-revert: drop the :104 epoch guard → the `if (!created)` generic toast fires → fails.
it('a session change on the parent create write shows no toast and does not navigate', async () => {
  mockParams = {}; // no categoryId → the create path
  render(<CategoryEdit />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'New cat'); // canSave needs a name
  mockCreateInline.mockImplementation(async () => { mockEpoch += 1; return null; });

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockCreateInline).toHaveBeenCalled());
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-REAUTH] THE CARD'S BUG: a DIFFERENT account fully signs in mid-save. Status is 'authed'
// again (so the old getStatus()==='anon' guard would PASS), but the epoch bumped. The writer even
// returns a SUCCESS-shaped value — so only the EPOCH tells the screen this isn't its session. The
// guard must bail: NO 'Category updated' summary toast, NO router.back() into the new session.
// Fail-on-revert: restore `getStatus() === 'anon'` → status 'authed' → guard passes → toast + nav fire.
it('a different-account sign-in mid-save (epoch bumped, status authed) shows no toast and does not navigate', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  mockSaveCategory.mockImplementation(async () => { mockEpoch += 1; return true; }); // re-auth: success-shaped, new session
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockSaveCategory).toHaveBeenCalled());
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-CHILD] Parent succeeds in-session (epoch unchanged, ok=true); the session change lands
// DURING the child writes. The post-Promise.allSettled guard (:122) must bail: NO summary toast, NO nav.
it('a session change during the child writes fires no summary toast and does not navigate', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking')];
  let call = 0;
  mockSaveCategory.mockImplementation(async () => {
    call += 1;
    if (call === 1) return true; // parent self-save succeeds in-session
    mockEpoch += 1;              // session change lands during the child write
    return false;
  });
  render(<CategoryEdit />);
  fireEvent.press(screen.getByTestId('attachChild-parking'));

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockSaveCategory).toHaveBeenCalledTimes(2));
  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

// [A-EDIT-CONTROL] Regression: with NO session change (epoch stays 0), a genuine in-session FAILURE
// must STILL toast — the guard must not over-suppress the real error path.
it('an in-session parent-save failure still shows the failure toast (guard does not over-suppress)', async () => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  mockSaveCategory.mockResolvedValue(false); // real failure, epoch unchanged
  render(<CategoryEdit />);

  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not save category. Please try again.'));
  expect(mockBack).not.toHaveBeenCalled();
});
