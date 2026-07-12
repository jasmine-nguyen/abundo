// WHIT-273: the categorise picker groups sub-categories under their parent — indented, with a
// per-parent chevron that folds/unfolds its subs. These drive the real Overlays host and lock:
// grouped render (expanded by default), selecting a parent AND a child, fold/unfold hiding the
// right rows, the fold tap NOT firing a select (separate targets), deep nesting, and orphans.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext, Category } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const cat = (id: string, name: string, parent: string | null = null): Category =>
  ({ id, name, icon: 'tag', color: '#e8a87c', bucket: 'Lifestyle', recent: 0, parent });

const fns = { chooseCategory: jest.fn(), setSheet: jest.fn(), dismissNotif: jest.fn() };

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

// Food [Dining, Groceries] + a top-level Transport. Siblings/roots supplied out of A–Z order.
const FAMILY = [cat('groceries', 'Groceries', 'food'), cat('transport', 'Transport'), cat('food', 'Food'), cat('dining', 'Dining', 'food')];

beforeEach(() => { fns.chooseCategory.mockClear(); });

describe('picker category tree', () => {
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
