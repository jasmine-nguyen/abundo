// WHIT-437 — [A40]-[A47] gaps around app/category/edit.tsx's two new catches.
//
// The implementer's categoryEditChildReason / categoryEditParentReason files pin the fold rules
// and the parent fallback. These add what neither reaches:
//   - the ORDERING guarantee: a refused parent must not leave child writes queued (an
//     unawaited rejection there is an unhandled promise rejection, which RN surfaces as a
//     redbox in dev and is invisible in prod).
//   - the INVERSE of WHIT-249: a HANDLED refusal must NOT be re-thrown into console.error.
//     P3 only proves the null-reason case still logs; nothing proves the reasoned case doesn't.
//   - the createCategoryInline half of the fold (every child test drives saveCategory).
//   - reasons whose characters can break a folded line: a newline, and the 160-char truncation.
// Harness mirrors categoryEditChildReason.screen.test.tsx.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';
import { ApiError } from '../apiError';

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

const mockBack = jest.fn();
let mockParams: { categoryId?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import CategoryEdit from '../../app/category/edit';

const CAP = 'a category can have at most 50 sub-categories';
const LIVING = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });

let errorSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockParams = { categoryId: 'transport' };
  mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
  mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
  mockCreateInline.mockClear();
  mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
  mockShowToast.mockClear(); mockBack.mockClear();
  // useInFlightGuard logs anything that escapes the screen's own handling; every test here
  // asserts on whether it did, so capture it rather than letting it colour the run.
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); });

const save = async () => { await act(async () => { fireEvent.press(screen.getByText('Save category')); }); };
/** Queue a brand-new inline sub-category (the createCategoryInline half of the child writes). */
const addNewChild = (name: string) => {
  fireEvent.press(screen.getByText('＋ New sub-category'));
  fireEvent.changeText(screen.getByPlaceholderText('Category name'), name);
  fireEvent.press(screen.getByText('Add sub-category'));
};

describe('[A40][A45][A46] a refused PARENT is handled, not leaked', () => {
  // The child ops are constructed AFTER the parent await. If the parent catch ever stopped
  // returning, those promises would be created and then dropped — Promise.allSettled is what
  // makes them safe, and nothing outside it awaits them.
  it('never starts the child writes when the parent is refused with a reason', async () => {
    mockSaveCategory.mockRejectedValue(new ApiError(400, CAP));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    addNewChild('Tolls');
    await save();

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      'A category can have at most 50 sub-categories.'));
    expect(mockSaveCategory).toHaveBeenCalledTimes(1);      // the parent only — no attach fired
    expect(mockSaveCategory).toHaveBeenCalledWith('transport', expect.anything(), { silent: true });
    expect(mockCreateInline).not.toHaveBeenCalled();        // no orphan sub created under nothing
    expect(mockShowToast).toHaveBeenCalledTimes(1);         // WHIT-240: still exactly one toast
    expect(mockBack).not.toHaveBeenCalled();
  });

  // The inverse of P3. `if (reason === null) throw error` is what keeps a HANDLED refusal out of
  // the log; drop the condition and every 50-cap refusal becomes a console.error too.
  it('does not re-throw a refusal it already explained', async () => {
    mockSaveCategory.mockRejectedValue(new ApiError(400, CAP));
    render(<CategoryEdit />);
    await save();

    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // WHIT-249: the button must come back so the user can shorten the name / pick a new parent.
  it('re-enables Save after a refusal so the user can retry', async () => {
    mockSaveCategory.mockRejectedValue(new ApiError(400, CAP));
    render(<CategoryEdit />);
    await save();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledTimes(1));

    await save();
    await waitFor(() => expect(mockSaveCategory).toHaveBeenCalledTimes(2));
  });
});

describe('[A41][A44][A47] the fold covers both child writers and ignores the successes', () => {
  // A SUCCESS must not dilute the shared reason — `reasons` is derived from `failures` only.
  // Invert that (map over `results`) and this goes red while every existing child test stays green.
  it('quotes the reason when one child succeeded and one was refused', async () => {
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport' || id === 'parking') return true;
      throw new ApiError(400, CAP);
    });
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await save();

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  // The 50-cap fires on CREATING a new sub as readily as on attaching one, and that path goes
  // through createCategoryInline — untouched by every existing child test.
  it('folds a reason from a refused NEW inline sub-category', async () => {
    mockCreateInline.mockRejectedValue(new ApiError(400, CAP));
    render(<CategoryEdit />);
    addNewChild('Tolls');
    await save();

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  // The realistic 50-cap shape: an attach AND a create, both refused by the same rule, via two
  // DIFFERENT writers. `reasons[0]` comparison is by string, so this must still fold.
  it('folds one shared reason across an attach and a create', async () => {
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      throw new ApiError(400, CAP);
    });
    mockCreateInline.mockRejectedValue(new ApiError(400, CAP));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    addNewChild('Tolls');
    await save();

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      `Category updated, but 2 sub-categories couldn't be attached — ${CAP}.`));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
});

describe('[A42][A43] reason text that could break the folded line', () => {
  // Nothing between the server and this toast strips control characters: failed() only .trim()s
  // the ends. A multi-line reason must still produce ONE toast with the text intact — this pins
  // the current behaviour so a future sanitiser is a deliberate, visible change.
  it('folds a multi-line reason verbatim into a single toast', async () => {
    const multi = 'cannot attach:\nthe parent already has 50 sub-categories';
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      throw new ApiError(400, multi);
    });
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      `Category updated, but 1 sub-category couldn't be attached — ${multi}.`));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });

  // The summary tail uses endSentence(reason) directly rather than writeFailureMessage, so the
  // "no full stop after the ellipsis" rule has to hold on THIS path too.
  it('ends a truncated reason with the ellipsis and no extra full stop', async () => {
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      throw new ApiError(400, 'z'.repeat(200));
    });
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledTimes(1));
    const line = mockShowToast.mock.calls[0][0] as string;
    expect(line).toBe(`Category updated, but 1 sub-category couldn't be attached — ${'z'.repeat(159)}…`);
    expect(line.endsWith('….')).toBe(false);
  });

  // A refusal that already ends in a full stop must not gain a second one.
  it('does not double the full stop on an already-terminated reason', async () => {
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      throw new ApiError(409, 'that name is taken.');
    });
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await save();

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 1 sub-category couldn't be attached — that name is taken."));
  });
});
