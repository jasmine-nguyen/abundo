// WHIT-366 — the shared "drill into Earned / Spent" screen (app/breakdown.tsx). Opened from the
// Insights Earned-vs-Spent card: Earned lists income sources, Spent lists spending groups. Both
// render one row per thing inside the number; a leaf drills into transactions (/category/[id]),
// a spend group drills one level deeper (this screen again, with `parent`). The query composite
// (../queries) is mocked; ../context stays REAL so the production categoryBreakdown builds the
// spend rows (its math is covered by the logic tests). expo-router is mocked and CAPTURES pushes.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { cat, spend, withRollup } from './factory';
import { C } from '../theme';
import type { Category } from '../context';

const colorOf = (text: string): string => StyleSheet.flatten(screen.getByText(text).props.style).color;

let mockData: ReturnType<typeof screenData>;
let mockParams: { kind?: string; cycle?: string; parent?: string };
let mockCapturedCycle: number | undefined;
const mockPush = jest.fn();

jest.mock('../queries', () => ({
  useInsightsScreenData: (cycle: number) => { mockCapturedCycle = cycle; return mockData; },
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Breakdown from '../../app/breakdown';

// A category() lookup over a fixture list — what the real screen joins each id against.
function lookup(cats: Category[]) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  return (id: string) => byId.get(id);
}

function screenData(over: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...over };
}
function base() {
  return {
    earned: 0,
    incomeSources: [] as { id: string; posted: number; pending: number; amount: number }[],
    breakdown: {} as Record<string, unknown>,
    category: (_id: string) => undefined as Category | undefined,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    refetchStale: jest.fn(),
    categoriesError: false,
  };
}

const INCOME_CATS = [
  cat({ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#2ac3de' }),
  cat({ id: 'side', name: 'Side hustle', bucket: 'Income', icon: 'cash', color: '#9ece6a' }),
];

beforeEach(() => {
  mockData = screenData();
  mockParams = { kind: 'earned', cycle: '0' };
  mockCapturedCycle = undefined;
  mockPush.mockReset();
});

describe('Breakdown — Earned', () => {
  beforeEach(() => {
    mockData = screenData({
      earned: 5000,
      incomeSources: [
        { id: 'salary', posted: 4000, pending: 200, amount: 4200 },
        { id: 'side', posted: 800, pending: 0, amount: 800 },
      ],
      category: lookup(INCOME_CATS),
    });
    mockParams = { kind: 'earned', cycle: '0' };
  });

  it('lists each income source with its amount, the Earned headline and a source count', () => {
    render(<Breakdown />);
    expect(screen.getByText('Earned this cycle')).toBeTruthy();
    expect(screen.getByText('$5,000')).toBeTruthy();          // the __earned__ headline
    expect(screen.getByText('2 income sources')).toBeTruthy();
    expect(screen.getByText('Salary')).toBeTruthy();
    expect(screen.getByText('$4,200')).toBeTruthy();
    expect(screen.getByText('Side hustle')).toBeTruthy();
    expect(screen.getByText('$800')).toBeTruthy();
  });

  it('taps a source into its transactions for the drilled cycle', () => {
    render(<Breakdown />);
    fireEvent.press(screen.getByText('Salary'));
    expect(mockPush).toHaveBeenCalledWith('/category/salary?cycle=0');
  });

  it('falls back to "Income" when the taxonomy has not caught up with a source id', () => {
    mockData = screenData({
      earned: 900,
      incomeSources: [{ id: 'mystery', posted: 900, pending: 0, amount: 900 }],
      category: lookup([]), // no categories loaded yet
    });
    render(<Breakdown />);
    // "Income" shows twice — the header title and the fallback row name for the unknown id.
    expect(screen.getAllByText('Income').length).toBe(2);
    // $900 shows as both the Earned headline and the single source's amount.
    expect(screen.getAllByText('$900').length).toBe(2);
  });

  it('shows the empty state when there is no income this cycle', () => {
    mockData = screenData({ earned: 0, incomeSources: [], category: lookup(INCOME_CATS) });
    render(<Breakdown />);
    expect(screen.getByText('No income recorded for this cycle.')).toBeTruthy();
    expect(screen.queryByTestId('breakdown-total')).toBeNull();
  });

  it('clamps an out-of-range ?cycle before both the fetch and the drill link', () => {
    mockParams = { kind: 'earned', cycle: '2' };
    render(<Breakdown />);
    expect(mockCapturedCycle).toBe(1);
    fireEvent.press(screen.getByText('Salary'));
    expect(mockPush).toHaveBeenCalledWith('/category/salary?cycle=1');
  });
});

describe('Breakdown — Spent', () => {
  // food (group: a direct-spend parent) + its coffee sub; groceries as a standalone top-level leaf.
  const SPEND_CATS = [
    cat({ id: 'food', name: 'Food', bucket: 'Living', parent: null }),
    cat({ id: 'coffee', name: 'Coffee', bucket: 'Living', parent: 'food' }),
    cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: null }),
  ];
  const BREAKDOWN = withRollup(
    {
      food: spend({ posted: 30, pending: 0 }),      // direct-in-parent → a "Directly in Food" leaf
      coffee: spend({ posted: 20, pending: 0 }),
      groceries: spend({ posted: 15, pending: 0 }),
    },
    { nodes: { food: { posted: 50, pending: 0 } } },
  );

  beforeEach(() => {
    mockData = screenData({ breakdown: BREAKDOWN as Record<string, unknown>, category: lookup(SPEND_CATS) });
  });

  it('lists top-level spending groups + leaves with the Spent headline', () => {
    mockParams = { kind: 'spent', cycle: '0' };
    render(<Breakdown />);
    expect(screen.getByText('Spent this cycle')).toBeTruthy();
    expect(screen.getByText('Food')).toBeTruthy();       // the group (has a sub)
    expect(screen.getByText('$50')).toBeTruthy();         // its netted subtree total
    expect(screen.getByText('Groceries')).toBeTruthy();  // a standalone leaf
    expect(screen.getByText('$15')).toBeTruthy();
    // A sub-category is NOT shown at the top level (it lives one level down).
    expect(screen.queryByText('Coffee')).toBeNull();
  });

  it('drills a group one level deeper (same screen, parent set) rather than into transactions', () => {
    mockParams = { kind: 'spent', cycle: '0' };
    render(<Breakdown />);
    fireEvent.press(screen.getByText('Food'));
    expect(mockPush).toHaveBeenCalledWith('/breakdown?kind=spent&cycle=0&parent=food');
  });

  it('drills a top-level leaf straight into its transactions', () => {
    mockParams = { kind: 'spent', cycle: '0' };
    render(<Breakdown />);
    fireEvent.press(screen.getByText('Groceries'));
    expect(mockPush).toHaveBeenCalledWith('/category/groceries?cycle=0');
  });

  it('at a group level shows its sub-categories, each drilling into transactions', () => {
    mockParams = { kind: 'spent', cycle: '0', parent: 'food' };
    render(<Breakdown />);
    expect(screen.getByText('Food')).toBeTruthy();  // header = the group name
    expect(screen.getByText('Coffee')).toBeTruthy(); // the sub is now shown
    fireEvent.press(screen.getByText('Coffee'));
    expect(mockPush).toHaveBeenCalledWith('/category/coffee?cycle=0');
  });

  // The synthetic "Other" plug (a remainder that reconciles a parent's rows to its node) is a
  // display-only line, not a real category: it must be muted (dimmed name) and NOT tappable, and
  // must NOT be counted in the "N categories" line. car(node 100) = petrol(100) + tolls refund(-30)
  // needs a +30 plug. Fail-on-revert: without the muted colour / count filter these assertions fail.
  it('renders the "Other" remainder plug muted, not tappable, and excluded from the category count', () => {
    const remainderCats = [
      cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
      cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
      cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'car' }),
    ];
    mockData = screenData({
      breakdown: withRollup(
        { petrol: spend({ posted: 100, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }) },
        { nodes: { car: { posted: 100, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
      ) as Record<string, unknown>,
      category: lookup(remainderCats),
    });
    mockParams = { kind: 'spent', cycle: '0', parent: 'car' };
    render(<Breakdown />);

    // Real categories = Petrol + the Tolls refund line (a real member); the plug is NOT counted.
    expect(screen.getByText('2 categories')).toBeTruthy();
    const plug = screen.getByText('Pending/refund adjustment');
    expect(colorOf('Pending/refund adjustment')).toBe(C.textDim); // dimmed, not the bright category ink
    fireEvent.press(plug);
    expect(mockPush).not.toHaveBeenCalled(); // display-only — nothing to drill into
  });
});

describe('Breakdown — loading & error', () => {
  it('shows a spinner while loading with nothing cached', () => {
    mockData = screenData({ isLoading: true, incomeSources: [] });
    mockParams = { kind: 'earned', cycle: '0' };
    render(<Breakdown />);
    expect(screen.getByTestId('breakdown-loading')).toBeTruthy();
  });

  it('shows the error + retry when the read failed with nothing cached', () => {
    const refetch = jest.fn();
    mockData = screenData({ isError: true, incomeSources: [], refetch });
    mockParams = { kind: 'earned', cycle: '0' };
    render(<Breakdown />);
    expect(screen.getByTestId('breakdown-error')).toBeTruthy();
    fireEvent.press(screen.getByTestId('breakdown-retry'));
    expect(refetch).toHaveBeenCalled();
  });
});
