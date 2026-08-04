// WHIT-441 item 5 (gaps) — the "parent is full → name the cap" tail must ONLY fire when the
// destination is a KNOWN, actually-full parent. The implementer's [C7] covers the full case. These
// pin the two ways parentFull must stay FALSE so the original "add it from its page" advice is kept:
//   (1) a partially-full destination (exactly 49 children) — the boundary just below the cap;
//   (2) a BRAND-NEW parent whose server id isn't in the cache yet — categories.find() misses it.
// Driven through the real edit host; context + queries + router mocked as in the sibling suite.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';
import { MAX_CHILDREN_PER_CATEGORY } from '../context';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true as boolean);
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

let mockParams: { categoryId?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import CategoryEdit from '../../app/category/edit';

const LIVING = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });

beforeEach(() => {
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockShowToast.mockClear();
});

// A parent at 49 children is NOT full, so the "names the cap" branch must NOT fire → original advice.
it('keeps the generic tail when the destination parent is one short of the cap (49)', async () => {
  mockParams = { categoryId: 'transport' };
  const kids = Array.from({ length: MAX_CHILDREN_PER_CATEGORY - 1 }, (_, i) => LIVING(`kid${i}`, `Kid ${i}`, 'transport'));
  mockCategories = [LIVING('transport', 'Transport'), LIVING('spare', 'Spare'), ...kids];
  mockSaveCategory.mockImplementation(async (id) => id === 'transport');   // 'spare' attach fails, no reason

  render(<CategoryEdit />);
  fireEvent.press(screen.getByTestId('attachChild-spare'));
  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  // Fail-on-revert: change the guard to `>= 49` (or `> 50`) and this reddens — 49 must read as NOT full.
  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
    "Category updated, but 1 sub-category couldn't be attached — add it from its page."));
  expect(mockShowToast).toHaveBeenCalledTimes(1);
});

// A NEW parent: its server id (from createCategoryInline) is not in the cached `categories`, so
// categories.find(parentId) misses → parentFull is false → original advice, never a bogus cap line.
it('keeps the generic tail for a NEW category whose parent id is not in the cache yet', async () => {
  mockParams = {};                                             // create mode, no categoryId
  // A NEW category defaults to the Lifestyle bucket, and an attach candidate must share it.
  const SPARE: Category = { id: 'spare', name: 'Spare', bucket: 'Lifestyle', icon: 'coffee', color: '#fff', recent: 0, parent: null };
  mockCategories = [SPARE];                                    // the only attachable child
  mockCreateInline.mockImplementation(async (form) => ({ id: 'coffee', name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockSaveCategory.mockImplementation(async () => false);      // the 'spare' attach fails, no reason

  render(<CategoryEdit />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Coffee');   // canSave needs a name
  fireEvent.press(screen.getByTestId('attachChild-spare'));
  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
    "Category created, but 1 sub-category couldn't be attached — add it from its page."));
  expect(mockShowToast).toHaveBeenCalledTimes(1);
});
