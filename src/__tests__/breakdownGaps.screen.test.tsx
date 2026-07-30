// WHIT-366 (QA gaps) — app/breakdown.tsx adversarial cases the implementer's breakdown.screen
// test does NOT cover: MULTI-LEVEL spend drill (a sub-level row that is itself a group), cycle
// propagation into the deep pushes at cycle=1, the refund-credit line branch, and a bad `parent`
// param (non-existent id / an Income id passed with kind=spent) staying an honest empty state
// rather than leaking the whole-cycle rows. ../context stays REAL so production categoryBreakdown
// builds the rows; ../queries is mocked; expo-router CAPTURES pushes. Mirrors breakdown.screen.test.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { cat, spend, withRollup } from './factory';
import { C } from '../theme';
import type { Category } from '../context';

let mockData: ReturnType<typeof screenData>;
let mockParams: { kind?: string; cycle?: string; parent?: string };
const mockPush = jest.fn();

jest.mock('../queries', () => ({
  useInsightsScreenData: () => mockData,
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Breakdown from '../../app/breakdown';

function lookup(cats: Category[]) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  return (id: string) => byId.get(id);
}
function screenData(over: Partial<ReturnType<typeof base>> = {}) { return { ...base(), ...over }; }
function base() {
  return {
    earned: 0,
    incomeSources: [] as { id: string; posted: number; pending: number; amount: number }[],
    breakdown: {} as Record<string, unknown>,
    category: (_id: string) => undefined as Category | undefined,
    isLoading: false, isError: false,
    refetch: jest.fn(), refetchStale: jest.fn(), categoriesError: false,
  };
}

const colorOf = (node: ReturnType<typeof screen.getByText>): string =>
  StyleSheet.flatten(node.props.style).color;

beforeEach(() => { mockPush.mockReset(); });

// --- [G-A] MULTI-LEVEL spend drill + cycle=1 propagation ---------------------
// Tree: car (top) > travel (mid, itself a group) > tolls (grandchild); petrol a leaf under car.
// At the car sub-level, `travel` must drill ONE MORE level deeper (this screen again, parent=travel),
// NOT into transactions — the multi-level-correctness case. And the selected cycle (1) must ride
// every deep push. Fail-on-revert: hardcode the push cycle to 0, or route a group to /category/,
// and these break.
describe('Breakdown — Spent, multi-level drill', () => {
  const MULTI_CATS = [
    cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
    cat({ id: 'travel', name: 'Travel', bucket: 'Living', parent: 'car' }),
    cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'travel' }),
    cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
  ];
  const MULTI_BREAKDOWN = withRollup(
    { petrol: spend({ posted: 60, pending: 0 }), tolls: spend({ posted: 20, pending: 0 }) },
    { nodes: { car: { posted: 80, pending: 0 }, travel: { posted: 20, pending: 0 } } },
  );

  beforeEach(() => {
    mockData = screenData({ breakdown: MULTI_BREAKDOWN as Record<string, unknown>, category: lookup(MULTI_CATS) });
  });

  it('a sub-level row that is ITSELF a group drills one more level deeper (parent + cycle=1 propagate)', () => {
    mockParams = { kind: 'spent', cycle: '1', parent: 'car' };
    render(<Breakdown />);
    // At the Car level we see its direct children: Travel (a group) and Petrol (a leaf).
    expect(screen.getByText('Travel')).toBeTruthy();
    expect(screen.getByText('Petrol')).toBeTruthy();
    expect(screen.queryByText('Tolls')).toBeNull(); // the grandchild lives one level further down

    fireEvent.press(screen.getByText('Travel'));
    expect(mockPush).toHaveBeenCalledWith('/breakdown?kind=spent&cycle=1&parent=travel'); // deeper, cycle rides
    fireEvent.press(screen.getByText('Petrol'));
    expect(mockPush).toHaveBeenCalledWith('/category/petrol?cycle=1');                     // leaf → txns, cycle rides
  });

  it('the deepest level (parent=travel) lists the grandchild, drilling into its transactions at the drilled cycle', () => {
    mockParams = { kind: 'spent', cycle: '1', parent: 'travel' };
    render(<Breakdown />);
    expect(screen.getByText('Travel')).toBeTruthy();  // header = the group name
    fireEvent.press(screen.getByText('Tolls'));
    expect(mockPush).toHaveBeenCalledWith('/category/tolls?cycle=1');
  });
});

// --- [G-B] a refund line at a sub-level: green credit + drills into the member's charges --------
// tolls net-refunds this cycle (floored out of the flat rows) → it surfaces under Car only as a
// refund line. It must read as a green credit and tap into tolls' own charges (drillId), not
// Car's. Fail-on-revert: drop the `credit` arm and the amount loses C.good.
describe('Breakdown — Spent, refund credit line', () => {
  const REFUND_CATS = [
    cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
    cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
    cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'car', color: '#ff0000' }),
  ];
  // petrol 70 + a tolls refund −30 nets to the car node 40 (no remainder plug); the amounts
  // (headline $40, petrol $70, refund $30) are all distinct so each row is uniquely queryable.
  const REFUND_BREAKDOWN = withRollup(
    { petrol: spend({ posted: 70, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }) }, // tolls floored to 0
    { nodes: { car: { posted: 40, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
  );

  it('shows the refunded member as a green credit and drills into that member’s transactions', () => {
    mockParams = { kind: 'spent', cycle: '0', parent: 'car' };
    mockData = screenData({ breakdown: REFUND_BREAKDOWN as Record<string, unknown>, category: lookup(REFUND_CATS) });
    render(<Breakdown />);

    expect(screen.getByText('Petrol')).toBeTruthy();      // the still-charged sibling
    expect(screen.getByText('Tolls')).toBeTruthy();       // the refund line, named for the member
    // A refund reads as an UNSIGNED green credit — matching the Insights refund style (a minus is
    // reserved for a negative remainder plug), never "−$30".
    const amount = screen.getByText('$30');
    expect(colorOf(amount)).toBe(C.good);
    expect(screen.queryByText('-$30')).toBeNull();

    fireEvent.press(screen.getByText('Tolls'));
    expect(mockPush).toHaveBeenCalledWith('/category/tolls?cycle=0'); // its OWN charges, not Car's
  });
});

// --- [G-D] a bad `parent` param stays an honest empty state (no whole-cycle leak) --------------
describe('Breakdown — Spent, bad parent param', () => {
  const CATS = [
    cat({ id: 'food', name: 'Food', bucket: 'Living', parent: null }),
    cat({ id: 'coffee', name: 'Coffee', bucket: 'Living', parent: 'food' }),
    cat({ id: 'salary', name: 'Salary', bucket: 'Income', parent: null }),
  ];
  const BREAKDOWN = withRollup(
    { coffee: spend({ posted: 20, pending: 0 }) },
    { nodes: { food: { posted: 20, pending: 0 } } },
  );

  beforeEach(() => {
    mockData = screenData({ breakdown: BREAKDOWN as Record<string, unknown>, category: lookup(CATS) });
  });

  it('a parent id that does not exist shows the empty state — it does NOT fall back to the top-level rows', () => {
    mockParams = { kind: 'spent', cycle: '0', parent: 'does-not-exist' };
    render(<Breakdown />);
    expect(screen.getByText('No spending in this cycle.')).toBeTruthy();
    expect(screen.queryByText('Food')).toBeNull();   // must not leak the whole-cycle groups
    expect(screen.queryByText('Coffee')).toBeNull();
    expect(screen.queryByTestId('breakdown-total')).toBeNull();
  });

  it('an Income id passed with kind=spent shows the empty state (income is never a spend row)', () => {
    mockParams = { kind: 'spent', cycle: '0', parent: 'salary' };
    render(<Breakdown />);
    expect(screen.getByText('No spending in this cycle.')).toBeTruthy();
    expect(screen.queryByText('Food')).toBeNull();
  });
});
