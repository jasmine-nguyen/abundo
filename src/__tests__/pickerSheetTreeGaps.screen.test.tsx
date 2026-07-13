// WHIT-273 GAPS — adversarial coverage the implementer's pickerSheetTree suite misses.
// It locks fold/unfold + selection but never checks the three things a human eyes on this
// feature: (1) child rows are actually INDENTED with a coloured left border at depth>0 while
// roots are not — [A-IND]; (2) collapse is PER-PARENT — folding one family must not fold a
// sibling family — [A-PER]; (3) the chevron's accessibilityState.expanded flips on fold — [A-A11Y].
// Harness mirrors pickerSheetParentPick/ pickerSheetTree: real Overlays host, mocked useAppContext
// + mocked query layer from a store-shaped fixture.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { AppContext, Category } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const cat = (id: string, name: string, parent: string | null = null, color = '#e8a87c'): Category =>
  ({ id, name, icon: 'tag', color, bucket: 'Lifestyle', recent: 0, parent });

const fns = { chooseCategory: jest.fn(), setSheet: jest.fn(), dismissNotif: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {} };

function pickerState(categories: Category[]): AppContext {
  return {
    sheet: { mode: 'picker', txId: 't1' },
    toast: null,
    notif: null,
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
