// WHIT-273: the categorise picker groups sub-categories under their parent — indented, with a
// per-parent chevron that folds/unfolds its subs. These drive the real Overlays host and lock:
// grouped render (expanded by default), selecting a parent AND a child, fold/unfold hiding the
// right rows, the fold tap NOT firing a select (separate targets), deep nesting, and orphans.
// Client state and writers come from the mocked context; the tapped charge and the categories come
// from the fake server through the real query hooks (WHIT-670).
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { Category } from '../types';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

const setMockState = (next: AppContext) => { mockState = next; };

const TX = { transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' };

// Seed the tapped charge (feed + recent list, which the picker resolves it from) and the
// categories, then open the picker on it over the loaded screens.
function openPicker(categories: unknown[], fns: Record<string, unknown>) {
  server.seed('/categories', categories);
  server.seed('/transactions', [TX]);
  server.seed('/transactions/feed', { transactions: [TX], nextCursor: null });
  const state = { sheet: { mode: 'picker', txId: 't1' }, toast: null, ...fns } as unknown as AppContext;
  return openOverlays(state, setMockState);
}

const COFFEE = { id: 'coffee', name: 'Coffee', icon: 'coffee', bucket: 'Lifestyle', parent: null };

describe('picker category tree', () => {
  const cat = (id: string, name: string, parent: string | null = null) =>
    ({ id, name, icon: 'tag', bucket: 'Lifestyle', parent });

  const fns = { chooseCategory: jest.fn(), setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {} };

  // Food [Dining, Groceries] + a top-level Transport. Siblings/roots supplied out of A–Z order.
  const FAMILY = [cat('groceries', 'Groceries', 'food'), cat('transport', 'Transport'), cat('food', 'Food'), cat('dining', 'Dining', 'food')];

  beforeEach(() => { fns.chooseCategory.mockClear(); });
  it('renders parents with their subs nested and everything expanded by default', async () => {
    await openPicker(FAMILY, fns);
    // All four visible on open — parent, both subs, and the unrelated top-level.
    expect(screen.getByText('Food')).toBeTruthy();
    expect(screen.getByText('Dining')).toBeTruthy();
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.getByText('Transport')).toBeTruthy();
    // The parent (has subs) gets a fold chevron; a leaf does not.
    expect(screen.getByTestId('pickerCat-toggle-food')).toBeTruthy();
    expect(screen.queryByTestId('pickerCat-toggle-transport')).toBeNull();
  });

  it.each([
    ['a parent', 'Food', 'food'],
    ['a child', 'Groceries', 'groceries'],
  ])('tapping %s name selects it', async (_case, name, id) => {
    await openPicker(FAMILY, fns);
    fireEvent.press(screen.getByText(name));
    expect(fns.chooseCategory).toHaveBeenCalledWith(id);
  });

  // [A7] (P0)
  it('[A7] a toast landing keeps the picker open, its fold state intact, and fires no pick', async () => {
    const { rerender } = await openPicker(FAMILY, fns);
    fireEvent.press(screen.getByTestId('pickerCat-toggle-food'));
    expect(screen.queryByText('Dining')).toBeNull();

    await act(async () => {
      mockState = { ...mockState, toast: 'Filed something elsewhere' } as unknown as AppContext;
      rerender(overlaysTree());
    });

    expect(screen.getByText('Categorize')).toBeTruthy();
    expect(screen.queryByText('Dining')).toBeNull();
    expect((screen.getByTestId('pickerCat-toggle-food').props as any).accessibilityState.expanded).toBe(false);
    expect(fns.chooseCategory).not.toHaveBeenCalled();
  });

  it('tapping a parent chevron folds its subs away without selecting anything', async () => {
    await openPicker(FAMILY, fns);
    fireEvent.press(screen.getByTestId('pickerCat-toggle-food'));
    // Subs gone; parent and the unrelated top-level stay.
    expect(screen.queryByText('Dining')).toBeNull();
    expect(screen.queryByText('Groceries')).toBeNull();
    expect(screen.getByText('Food')).toBeTruthy();
    expect(screen.getByText('Transport')).toBeTruthy();
    // The chevron is a separate target — folding must never file the transaction.
    expect(fns.chooseCategory).not.toHaveBeenCalled();
  });

  it('unfolding a parent brings its subs back', async () => {
    await openPicker(FAMILY, fns);
    fireEvent.press(screen.getByTestId('pickerCat-toggle-food'));
    expect(screen.queryByText('Dining')).toBeNull();
    fireEvent.press(screen.getByTestId('pickerCat-toggle-food'));
    expect(screen.getByText('Dining')).toBeTruthy();
    expect(screen.getByText('Groceries')).toBeTruthy();
  });

  it('folding a top parent hides grandchildren too (deep nest)', async () => {
    // Food > Restaurants > Fast food.
    const deep = [cat('food', 'Food'), cat('restaurants', 'Restaurants', 'food'), cat('fastfood', 'Fast food', 'restaurants')];
    await openPicker(deep, fns);
    expect(screen.getByText('Fast food')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pickerCat-toggle-food'));
    expect(screen.queryByText('Restaurants')).toBeNull();
    expect(screen.queryByText('Fast food')).toBeNull();
  });
});

// ===== WHIT-273 adversarial gaps (folded from pickerSheetTreeGaps):
// chevron a11y. Own block-scoped cat. =====
describe('picker tree — gaps (WHIT-273)', () => {
  const cat = (id: string, name: string, parent: string | null = null) =>
    ({ id, name, icon: 'tag', bucket: 'Lifestyle', parent });

  const fns = { chooseCategory: jest.fn(), setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {} };

  beforeEach(() => { fns.chooseCategory.mockClear(); });

  describe('picker tree — chevron accessibility state', () => {
    it('[A-A11Y] the parent chevron reports expanded=true, then expanded=false after folding', async () => {
      await openPicker([cat('food', 'Food'), cat('dining', 'Dining', 'food')], fns);
      const toggle = () => screen.getByTestId('pickerCat-toggle-food');
      expect((toggle().props as any).accessibilityState.expanded).toBe(true);
      fireEvent.press(toggle());
      expect((toggle().props as any).accessibilityState.expanded).toBe(false);
      // And the fold reports through a11y without ever firing a select.
      expect(fns.chooseCategory).not.toHaveBeenCalled();
    });
  });
});

// ===== WHIT-238 inline-create (folded from pickerSheetInlineCreate). Own fns with a tracked
// createCategoryInline. =====
describe('picker inline-create (WHIT-238)', () => {
  const NEW_CAT: Category = { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#fff', parent: null };
  const fns = {
    createCategoryInline: jest.fn(async (_form: unknown) => NEW_CAT as Category | null),
    chooseCategory: jest.fn(),
    setSheet: jest.fn(),
    readSheetDraft: () => undefined,
    writeSheetDraft: () => {},
  };

  beforeEach(() => { fns.createCategoryInline.mockClear(); fns.chooseCategory.mockClear(); });

  it('creating files the transaction into the new category', async () => {
    await openPicker([COFFEE], fns);
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
    await act(async () => { fireEvent.press(screen.getByText('Create & file')); });

    expect(fns.createCategoryInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gym', bucket: 'Lifestyle', parent: null }));
    // ...then files THIS transaction into the just-created category (advances to confirm).
    await waitFor(() => expect(fns.chooseCategory).toHaveBeenCalledWith('gym'));
  });

  it('does not file when creation fails (chooseCategory not called)', async () => {
    fns.createCategoryInline.mockResolvedValueOnce(null);
    await openPicker([COFFEE], fns);
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
    await act(async () => { fireEvent.press(screen.getByText('Create & file')); });

    expect(fns.createCategoryInline).toHaveBeenCalled();
    expect(fns.chooseCategory).not.toHaveBeenCalled();
  });
});

// ===== WHIT-249 create&file re-enable after a throw (folded from pickerSheetCreateFileThrow). Its
// beforeEach installs a persistent createCategoryInline impl and its afterEach restores the
// console.error spy — both stay INSIDE this block. =====
describe('picker create&file throw re-enable (WHIT-249)', () => {
  const NEW_CAT: Category = { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#fff', parent: null };
  const fns = {
    createCategoryInline: jest.fn(async (_form: unknown) => NEW_CAT as Category | null),
    chooseCategory: jest.fn(),
    setSheet: jest.fn(),
    readSheetDraft: () => undefined,
    writeSheetDraft: () => {},
  };

  beforeEach(() => {
    fns.createCategoryInline.mockClear();
    fns.createCategoryInline.mockImplementation(async () => NEW_CAT as Category | null);
    fns.chooseCategory.mockClear();
  });

  // Restore any per-test console.error spy even if a test fails mid-body (targets console.error
  // only, so jest.setup's console.warn silence stays intact).
  afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

  // [A-createfile] The inline create throws on the first press. The button (gated by PickerSheet's
  // `submitting` → QuickCreateCategory `busy`) must re-enable so a retry creates + files.
  it('re-enables Create & file so a retry runs after createCategoryInline throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fns.createCategoryInline.mockRejectedValueOnce(new Error('network blew up')); // 1st press throws
    await openPicker([COFFEE], fns);
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');

    await act(async () => { fireEvent.press(screen.getByText('Create & file')); }); // throws → guard logs, submitting reset
    await act(async () => { fireEvent.press(screen.getByText('Create & file')); }); // only fires if re-enabled

    // Called TWICE = `submitting` was reset (else `busy` keeps the button disabled and press #2 no-ops).
    expect(fns.createCategoryInline).toHaveBeenCalledTimes(2);
    // The retry succeeded → the transaction is filed into the freshly-created category.
    await waitFor(() => expect(fns.chooseCategory).toHaveBeenCalledWith('gym'));
    expect(errorSpy).toHaveBeenCalled(); // the guard logged the escaped throw (WHIT-249 contract)
  });
});

// ===== WHIT-670 QA (folded from whit670PickerConfirmQa): the confirm pop-up resolves the charge
// from the real caches. =====
describe('confirm pop-up', () => {
  const cat = (id: string, name: string, parent: string | null = null) =>
    ({ id, name, icon: 'tag', bucket: 'Lifestyle', parent });
  const fns = { applyCategory: jest.fn(), setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {} };

  // [A10] (P1)
  it('[A10] confirm resolves a charge only in the recent list and files it', async () => {
    server.seed('/categories', [cat('food', 'Food'), cat('dining', 'Dining', 'food')]);
    server.seed('/transactions', [TX]);
    await openOverlays({ sheet: { mode: 'confirm', txId: 't1', categoryId: 'dining' }, toast: null, ...fns } as unknown as AppContext, setMockState);

    expect(screen.getByText('File as Dining')).toBeTruthy();
    fireEvent.press(screen.getByText('Just this one'));
    expect(fns.applyCategory).toHaveBeenCalledWith('one');
  });
});
