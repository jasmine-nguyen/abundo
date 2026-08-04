// WHIT-437 — the PARENT write on the edit screen. It runs silent so the screen owns the one
// toast; now that a silent writer rejects instead of returning falsy, the screen has to speak the
// reason itself. The WHIT-249 log contract and the WHIT-282 session guard both run through the
// same new catch, so they are pinned here too.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';
import { ApiError } from '../apiError';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true as boolean);
const mockCreateInline = jest.fn(async (_form: unknown, _opts?: { silent?: boolean }) => null as Category | null);
const mockShowToast = jest.fn();
let mockEpoch = 0;
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
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport')];
  mockEpoch = 0;
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockShowToast.mockClear(); mockBack.mockClear();
});

// [P1] the reason replaces the generic line, and a refused save does not navigate away.
it('shows the server reason when the parent update is refused', async () => {
  mockSaveCategory.mockRejectedValue(new ApiError(400, 'a sub-category must be in the same bucket as its parent'));
  render(<CategoryEdit />);
  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
    'A sub-category must be in the same bucket as its parent.'));
  expect(mockShowToast).toHaveBeenCalledTimes(1);
  expect(mockBack).not.toHaveBeenCalled();
});

// [P2] the 409 win — retrying a duplicate name never works, so saying "try again" was a lie.
it('shows a 409 duplicate refusal on create', async () => {
  mockParams = {};
  mockCategories = [];
  mockCreateInline.mockRejectedValue(new ApiError(409, 'category already exists'));
  render(<CategoryEdit />);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Coffee runs'), 'Groceries');
  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Category already exists.'));
  expect(mockBack).not.toHaveBeenCalled();
});

// [P3] WHIT-249: an unexplained failure is still logged. We toast the generic line AND re-throw,
// so the in-flight guard's logging survives the new catch.
it('falls back and still lets an unexplained failure reach the guard log', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockSaveCategory.mockRejectedValue(new Error('network blew up'));
  render(<CategoryEdit />);
  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not save category. Please try again.'));
  expect(errorSpy).toHaveBeenCalled();
  errorSpy.mockRestore();
});

// [P4] WHIT-282: a sign-out mid-save must not toast into the next session.
it('stays silent when the session changed mid-save', async () => {
  mockSaveCategory.mockImplementation(async () => { mockEpoch = 1; throw new ApiError(400, 'a category can have at most 50 sub-categories'); });
  render(<CategoryEdit />);
  await act(async () => { fireEvent.press(screen.getByText('Save category')); });

  expect(mockShowToast).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});
