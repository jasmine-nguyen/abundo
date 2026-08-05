// Category-edit screen tests (WHIT-451 consolidation): the reason / save-failure family. Merged
// from categoryEditReasonGaps + categoryEditChildReason + categoryEditChildReasonGaps +
// categoryEditSaveThrow + categoryEditParentReason. All five drive the real app/category/edit host
// with an identical (superset) mock of ../../src/context, ../../src/queries and expo-router; each
// suite keeps its own scoped consts + beforeEach so its setup can't leak. `getSessionEpoch` reads a
// shared `mockEpoch` (only the ParentReason suite bumps it, and it runs last).
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { Category } from '../context';
import { MAX_CHILDREN_PER_CATEGORY } from '../context';
import { ApiError } from '../apiError';

const mockSaveCategory = jest.fn(async (_id: string | null, _form: unknown, _opts?: { silent?: boolean }) => true as boolean);
const mockCreateInline = jest.fn(async (form: { name: string; bucket: string; icon: string; parent?: string | null }, _opts?: { silent?: boolean }) => ({
  id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null,
}) as unknown as Category | null);
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

describe('categoryEditReasonGaps', () => {
  
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
});

describe('categoryEditChildReason', () => {
  
  const CAP = 'a category can have at most 50 sub-categories';
  const LIVING = (id: string, name: string, parent: string | null = null): Category =>
    ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });
  
  beforeEach(() => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport'), LIVING('parking', 'Parking'), LIVING('petrol', 'Petrol')];
    mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
    mockCreateInline.mockClear();
    mockCreateInline.mockImplementation(async (form) => ({ id: form.name.toLowerCase(), name: form.name, bucket: form.bucket, icon: form.icon, color: '#fff', recent: 0, parent: form.parent ?? null } as unknown as Category | null));
    mockShowToast.mockClear(); mockBack.mockClear();
  });
  
  // The parent save is call #1; the child attaches follow. Reject only the child ones.
  const rejectChildrenWith = (error: unknown) =>
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      throw error;
    });
  
  // [C1] ONE child refused for a stated reason -> the reason replaces the generic tail.
  it('folds a single child refusal reason into the one summary toast', async () => {
    rejectChildrenWith(new ApiError(400, CAP));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      `Category updated, but 1 sub-category couldn't be attached — ${CAP}.`));
    expect(mockShowToast).toHaveBeenCalledTimes(1);   // WHIT-240 still holds
    expect(mockBack).toHaveBeenCalled();             // WHIT-237 Option A: a good parent is kept
  });
  
  // [C2] TWO children refused for the SAME reason -> one cause, stated once, plural count.
  it('folds a shared reason across two refused children', async () => {
    rejectChildrenWith(new ApiError(400, CAP));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      `Category updated, but 2 sub-categories couldn't be attached — ${CAP}.`));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C3] TWO DIFFERENT reasons cannot honestly be summarised as one -> generic tail.
  it('keeps the generic tail when the failures had different reasons', async () => {
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      throw new ApiError(400, id === 'parking' ? CAP : 'a sub-category must be in the same bucket as its parent');
    });
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 2 sub-categories couldn't be attached — add them from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C4] A plain failure has no reason to give -> we must never invent one.
  it('keeps the generic tail for a network failure', async () => {
    rejectChildrenWith(new Error('network blew up'));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C5] A reason cannot be attributed to a failure that never gave one.
  it('keeps the generic tail when a reasoned refusal is mixed with a bare falsy failure', async () => {
    mockSaveCategory.mockImplementation(async (id) => {
      if (id === 'transport') return true;
      if (id === 'parking') throw new ApiError(400, CAP);
      return false;                                   // petrol fails with nothing to say
    });
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    fireEvent.press(screen.getByTestId('attachChild-petrol'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 2 sub-categories couldn't be attached — add them from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C6] A 5xx is our fault, not a rule the user broke — never surface it.
  it('keeps the generic tail for a 500', async () => {
    rejectChildrenWith(new ApiError(500, 'boom'));
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-parking'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      "Category updated, but 1 sub-category couldn't be attached — add it from its page."));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
  
  // [C7] WHIT-441/438 — when the destination is ALREADY at its child cap, "add it from its page" is
  // circular: that page refuses for the very same reason. Name the cap instead. A failure with no
  // stated reason (a bare falsy result) is what routes here rather than to the server's own words.
  it('names the child cap instead of the circular advice when the parent is full', async () => {
    const kids = Array.from({ length: 50 }, (_, i) => LIVING(`kid${i}`, `Kid ${i}`, 'transport'));
    mockCategories = [LIVING('transport', 'Transport'), LIVING('spare', 'Spare'), ...kids];
    mockSaveCategory.mockImplementation(async (id) => id === 'transport');  // the 'spare' attach fails, no reason
    render(<CategoryEdit />);
    fireEvent.press(screen.getByTestId('attachChild-spare'));
    await act(async () => { fireEvent.press(screen.getByText('Save category')); });
  
    // Fail-on-revert: restore the unconditional `add … from its page` tail → this reddens.
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(
      'Category updated, but 1 sub-category couldn\'t be attached — Transport already has the most sub-categories allowed (50).'));
    expect(mockShowToast).toHaveBeenCalledTimes(1);
  });
});

describe('categoryEditChildReasonGaps', () => {
  
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
});

describe('categoryEditSaveThrow', () => {
  
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
});

describe('categoryEditParentReason', () => {
  
  const LIVING = (id: string, name: string, parent: string | null = null): Category =>
    ({ id, name, bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent });
  
  beforeEach(() => {
    mockParams = { categoryId: 'transport' };
    mockCategories = [LIVING('transport', 'Transport')];
    mockEpoch = 0;
    mockSaveCategory.mockClear(); mockSaveCategory.mockImplementation(async () => true);
    mockCreateInline.mockClear();
    mockCreateInline.mockImplementation(async () => null); // ParentReason's original module default
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
});
