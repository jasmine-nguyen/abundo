// WHIT-273: the categorise picker groups sub-categories under their parent — indented, with a
// per-parent chevron that folds/unfolds its subs. These drive the real Overlays host and lock:
// grouped render (expanded by default), selecting a parent AND a child, fold/unfold hiding the
// right rows, the fold tap NOT firing a select (separate targets), deep nesting, and orphans.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { StyleSheet, ScrollView } from 'react-native';
import type { AppContext, Category } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

describe('picker category tree', () => {
  const cat = (id: string, name: string, parent: string | null = null): Category =>
    ({ id, name, icon: 'tag', color: '#e8a87c', bucket: 'Lifestyle', recent: 0, parent });

  const fns = { chooseCategory: jest.fn(), setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {} };

  function pickerState(categories: Category[]): AppContext {
    return {
      sheet: { mode: 'picker', txId: 't1' },
      toast: null,
      transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' }],
      categories,
      ...fns,
    } as unknown as AppContext;
  }

  // Food [Dining, Groceries] + a top-level Transport. Siblings/roots supplied out of A–Z order.
  const FAMILY = [cat('groceries', 'Groceries', 'food'), cat('transport', 'Transport'), cat('food', 'Food'), cat('dining', 'Dining', 'food')];

  beforeEach(() => { fns.chooseCategory.mockClear(); });
  it('renders parents with their subs nested and everything expanded by default', () => {
    mockState = pickerState(FAMILY);
    render(<Overlays />);
    // All four visible on open — parent, both subs, and the unrelated top-level.
    expect(screen.getByText('Food')).toBeTruthy();
    expect(screen.getByText('Dining')).toBeTruthy();
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.getByText('Transport')).toBeTruthy();
    // The parent (has subs) gets a fold chevron; a leaf does not.
    expect(screen.getByTestId('pickerCatToggle-food')).toBeTruthy();
    expect(screen.queryByTestId('pickerCatToggle-transport')).toBeNull();
  });

  it('tapping a parent name selects that parent', () => {
    mockState = pickerState(FAMILY);
    render(<Overlays />);
    fireEvent.press(screen.getByText('Food'));
    expect(fns.chooseCategory).toHaveBeenCalledWith('food');
  });

  it('tapping a child name selects that child', () => {
    mockState = pickerState(FAMILY);
    render(<Overlays />);
    fireEvent.press(screen.getByText('Groceries'));
    expect(fns.chooseCategory).toHaveBeenCalledWith('groceries');
  });

  it('tapping a parent chevron folds its subs away without selecting anything', () => {
    mockState = pickerState(FAMILY);
    render(<Overlays />);
    fireEvent.press(screen.getByTestId('pickerCatToggle-food'));
    // Subs gone; parent and the unrelated top-level stay.
    expect(screen.queryByText('Dining')).toBeNull();
    expect(screen.queryByText('Groceries')).toBeNull();
    expect(screen.getByText('Food')).toBeTruthy();
    expect(screen.getByText('Transport')).toBeTruthy();
    // The chevron is a separate target — folding must never file the transaction.
    expect(fns.chooseCategory).not.toHaveBeenCalled();
  });

  it('unfolding a parent brings its subs back', () => {
    mockState = pickerState(FAMILY);
    render(<Overlays />);
    fireEvent.press(screen.getByTestId('pickerCatToggle-food'));
    expect(screen.queryByText('Dining')).toBeNull();
    fireEvent.press(screen.getByTestId('pickerCatToggle-food'));
    expect(screen.getByText('Dining')).toBeTruthy();
    expect(screen.getByText('Groceries')).toBeTruthy();
  });

  it('folding a top parent hides grandchildren too (deep nest)', () => {
    // Food > Restaurants > Fast food.
    const deep = [cat('food', 'Food'), cat('restaurants', 'Restaurants', 'food'), cat('fastfood', 'Fast food', 'restaurants')];
    mockState = pickerState(deep);
    render(<Overlays />);
    expect(screen.getByText('Fast food')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pickerCatToggle-food'));
    expect(screen.queryByText('Restaurants')).toBeNull();
    expect(screen.queryByText('Fast food')).toBeNull();
  });

  it('shows an orphan (parent id missing) at the top level rather than hiding it', () => {
    mockState = pickerState([cat('a', 'Apple'), cat('orphan', 'Orphan', 'ghost')]);
    render(<Overlays />);
    expect(screen.getByText('Apple')).toBeTruthy();
    expect(screen.getByText('Orphan')).toBeTruthy();
    fireEvent.press(screen.getByText('Orphan'));
    expect(fns.chooseCategory).toHaveBeenCalledWith('orphan');
  });
});

// ===== WHIT-273 adversarial gaps (folded from pickerSheetTreeGaps): indentation, per-parent
// collapse, chevron a11y. Own block-scoped cat (with colour) + rowStyle helper. =====
describe('picker tree — gaps (WHIT-273)', () => {
  const cat = (id: string, name: string, parent: string | null = null, color = '#e8a87c'): Category =>
    ({ id, name, icon: 'tag', color, bucket: 'Lifestyle', recent: 0, parent });

  const fns = { chooseCategory: jest.fn(), setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {} };

  function pickerState(categories: Category[]): AppContext {
    return {
      sheet: { mode: 'picker', txId: 't1' },
      toast: null,
      transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' }],
      categories,
      ...fns,
    } as unknown as AppContext;
  }

  // Walk up from a category's label to the row <View> (the only ancestor carrying pickRow's
  // paddingVertical:11) and return its FLATTENED style, resolving the [pickRow, indent?] array.
  function rowStyle(name: string): Record<string, any> {
    let node: any = screen.getByText(name);
    while (node) {
      const flat = StyleSheet.flatten(node.props?.style) as any;
      if (flat && flat.paddingVertical === 11) return flat;
      node = node.parent;
    }
    throw new Error(`row not found for "${name}"`);
  }

  beforeEach(() => { fns.chooseCategory.mockClear(); });

  describe('picker tree — indentation (depth-aware left inset + border)', () => {
    it('[A-IND] a root row has no left inset; a child is indented one step with its own colour border', () => {
      mockState = pickerState([cat('food', 'Food'), cat('dining', 'Dining', 'food', '#12ab34')]);
      render(<Overlays />);
      // Root: no indentation applied.
      const root = rowStyle('Food');
      expect(root.marginLeft).toBeUndefined();
      expect(root.borderLeftWidth).toBeUndefined();
      // Child (depth 1): inset 18, a 2px border tinted the CHILD's colour, and the extra padding.
      const child = rowStyle('Dining');
      expect(child.marginLeft).toBe(18);
      expect(child.borderLeftWidth).toBe(2);
      expect(child.borderLeftColor).toBe('#12ab34');
      expect(child.paddingLeft).toBe(11);
    });

    it('[A-IND2] a grandchild is indented two steps (depth scales the inset)', () => {
      const deep = [cat('food', 'Food'), cat('rest', 'Restaurants', 'food'), cat('fast', 'Fast food', 'rest')];
      mockState = pickerState(deep);
      render(<Overlays />);
      expect(rowStyle('Restaurants').marginLeft).toBe(18); // depth 1
      expect(rowStyle('Fast food').marginLeft).toBe(36);   // depth 2
    });
  });

  describe('picker tree — collapse is per-parent', () => {
    // Two sibling families, each with its own subs. Folding one must not touch the other.
    const TWO_FAMILIES = [
      cat('food', 'Food'), cat('dining', 'Dining', 'food'), cat('groceries', 'Groceries', 'food'),
      cat('shopping', 'Shopping'), cat('clothes', 'Clothes', 'shopping'), cat('tech', 'Tech', 'shopping'),
    ];

    it('[A-PER] folding Food hides only Food\'s subs — Shopping\'s subs stay visible', () => {
      mockState = pickerState(TWO_FAMILIES);
      render(<Overlays />);
      // Both families have their own chevron.
      expect(screen.getByTestId('pickerCatToggle-food')).toBeTruthy();
      expect(screen.getByTestId('pickerCatToggle-shopping')).toBeTruthy();

      fireEvent.press(screen.getByTestId('pickerCatToggle-food'));

      // Food's subs gone.
      expect(screen.queryByText('Dining')).toBeNull();
      expect(screen.queryByText('Groceries')).toBeNull();
      // Shopping and its subs untouched.
      expect(screen.getByText('Shopping')).toBeTruthy();
      expect(screen.getByText('Clothes')).toBeTruthy();
      expect(screen.getByText('Tech')).toBeTruthy();
      // Both parents still visible (folding a parent never hides the parent itself).
      expect(screen.getByText('Food')).toBeTruthy();
    });

    it('[A-PER2] a collapsed parent keeps its OWN chevron so it can be reopened', () => {
      mockState = pickerState(TWO_FAMILIES);
      render(<Overlays />);
      fireEvent.press(screen.getByTestId('pickerCatToggle-food'));
      // Chevron survives the fold (implementer proves unfold works; this pins the target's presence).
      expect(screen.getByTestId('pickerCatToggle-food')).toBeTruthy();
    });
  });

  describe('picker tree — chevron accessibility state', () => {
    it('[A-A11Y] the parent chevron reports expanded=true, then expanded=false after folding', () => {
      mockState = pickerState([cat('food', 'Food'), cat('dining', 'Dining', 'food')]);
      render(<Overlays />);
      const toggle = () => screen.getByTestId('pickerCatToggle-food');
      expect((toggle().props as any).accessibilityState.expanded).toBe(true);
      fireEvent.press(toggle());
      expect((toggle().props as any).accessibilityState.expanded).toBe(false);
      // And the fold reports through a11y without ever firing a select.
      expect(fns.chooseCategory).not.toHaveBeenCalled();
    });
  });
});

// ===== WHIT-238 inline-create (folded from pickerSheetInlineCreate). Own fns with a tracked
// createCategoryInline + zero-arg pickerState. =====
describe('picker inline-create (WHIT-238)', () => {
  const NEW_CAT: Category = { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#fff', recent: 0, parent: null };
  const fns = {
    createCategoryInline: jest.fn(async (_form: unknown) => NEW_CAT as Category | null),
    chooseCategory: jest.fn(),
    setSheet: jest.fn(),
    readSheetDraft: () => undefined,
    writeSheetDraft: () => {},
  };

  function pickerState(): AppContext {
    return {
      sheet: { mode: 'picker', txId: 't1' },
      toast: null,
      transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' }],
      categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0 }],
      ...fns,
    } as unknown as AppContext;
  }

  beforeEach(() => { fns.createCategoryInline.mockClear(); fns.chooseCategory.mockClear(); });

  it('opens the inline create form from the picker', () => {
    mockState = pickerState();
    render(<Overlays />);
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    expect(screen.getByPlaceholderText('Category name')).toBeTruthy();
    expect(screen.getByText('Create & file')).toBeTruthy();
  });

  it('creating files the transaction into the new category', async () => {
    mockState = pickerState();
    render(<Overlays />);
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
    await act(async () => { fireEvent.press(screen.getByText('Create & file')); });

    expect(fns.createCategoryInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gym', bucket: 'Lifestyle', parent: null }));
    // ...then files THIS transaction into the just-created category (advances to confirm).
    await waitFor(() => expect(fns.chooseCategory).toHaveBeenCalledWith('gym'));
  });

  it('does not file when creation fails (chooseCategory not called)', async () => {
    fns.createCategoryInline.mockResolvedValueOnce(null);
    mockState = pickerState();
    render(<Overlays />);
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
    await act(async () => { fireEvent.press(screen.getByText('Create & file')); });

    expect(fns.createCategoryInline).toHaveBeenCalled();
    expect(fns.chooseCategory).not.toHaveBeenCalled();
  });
});

// ===== WHIT-239 inline-create parent nesting (folded from pickerSheetParentPick). NEW_CAT nests
// under 'coffee'. =====
describe('picker inline-create parent nesting (WHIT-239)', () => {
  const NEW_CAT: Category = { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'coffee', color: '#fff', recent: 0, parent: 'coffee' };
  const fns = {
    createCategoryInline: jest.fn(async (_form: unknown) => NEW_CAT as Category | null),
    chooseCategory: jest.fn(),
    setSheet: jest.fn(),
    readSheetDraft: () => undefined,
    writeSheetDraft: () => {},
  };

  function pickerState(): AppContext {
    return {
      sheet: { mode: 'picker', txId: 't1' },
      toast: null,
      transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' }],
      // One same-bucket (Lifestyle) category, so it is offered as an eligible parent in the picker.
      categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0, parent: null }],
      ...fns,
    } as unknown as AppContext;
  }

  beforeEach(() => { fns.createCategoryInline.mockClear(); fns.chooseCategory.mockClear(); });

  it('nesting the new category under a picked parent carries that parent into createCategoryInline', async () => {
    mockState = pickerState();
    render(<Overlays />);
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    fireEvent.changeText(screen.getByPlaceholderText('Category name'), 'Gym');
    // The inline form's parent picker (initialBucket Lifestyle) offers the same-bucket 'Coffee'. Pick it.
    fireEvent.press(screen.getByText('Coffee'));
    await act(async () => { fireEvent.press(screen.getByText('Create & file')); });

    expect(fns.createCategoryInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gym', bucket: 'Lifestyle', parent: 'coffee' }));
  });
});

// ===== Create-form scroller (folded from pickerSheetCreateScroll). The name field must live in a
// tap-persisting ScrollView. =====
describe('picker create-form scroller', () => {
  const fns = {
    createCategoryInline: jest.fn(async (_form: unknown) => null as Category | null),
    chooseCategory: jest.fn(),
    setSheet: jest.fn(),
    readSheetDraft: () => undefined,
    writeSheetDraft: () => {},
  };

  function pickerState(): AppContext {
    return {
      sheet: { mode: 'picker', txId: 't1' },
      toast: null,
      transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' }],
      categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0, parent: null }],
      ...fns,
    } as unknown as AppContext;
  }

  beforeEach(() => { Object.values(fns).forEach((f) => typeof f === 'function' && (f as jest.Mock).mockClear?.()); });

  // Fail-on-revert: drop the ScrollView wrapper (back to the plain <View>) and the name field is no
  // longer inside any vertical scroller with keyboardShouldPersistTaps — both assertions below fail.
  it('wraps the New-category form in a tap-persisting scroller so the name field stays reachable', () => {
    mockState = pickerState();
    const { UNSAFE_getAllByType } = render(<Overlays />);
    fireEvent.press(screen.getByTestId('pickerNewCategory'));

    // The scroller that owns the form: a ScrollView told to keep taps alive over the keyboard so a
    // chip/button lands on the first press (the horizontal icon strip does not set this).
    const formScroll = UNSAFE_getAllByType(ScrollView).find((sv) => sv.props.keyboardShouldPersistTaps === 'handled');
    expect(formScroll).toBeTruthy();

    // The Category name input must live INSIDE that scroller — that is what keeps it on-screen when the
    // keyboard lifts the sheet.
    const nameInput = screen.getByPlaceholderText('Category name');
    expect(formScroll!.findAll((n) => n === nameInput)).toHaveLength(1);
  });
});

// ===== WHIT-249 create&file re-enable after a throw (folded from pickerSheetCreateFileThrow). Its
// beforeEach installs a persistent createCategoryInline impl and its afterEach restores the
// console.error spy — both stay INSIDE this block. =====
describe('picker create&file throw re-enable (WHIT-249)', () => {
  const NEW_CAT: Category = { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#fff', recent: 0, parent: null };
  const fns = {
    createCategoryInline: jest.fn(async (_form: unknown) => NEW_CAT as Category | null),
    chooseCategory: jest.fn(),
    setSheet: jest.fn(),
    readSheetDraft: () => undefined,
    writeSheetDraft: () => {},
  };

  function pickerState(): AppContext {
    return {
      sheet: { mode: 'picker', txId: 't1' },
      toast: null,
      transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' }],
      categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0 }],
      ...fns,
    } as unknown as AppContext;
  }

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
    mockState = pickerState();
    render(<Overlays />);
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
