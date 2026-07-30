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

  // WHIT-376: a source clawed back this cycle (negative net) renders as a signed "−$150" reversal
  // in the neutral mid tone (NOT a green credit, NOT bright), still tappable — and the rows sum to
  // the headline (2000 − 150 = 1850) so NO adjustment plug appears. Fail-on-revert: drop the
  // `isReversed` case and "−$150" becomes "$150" and the C.textMid colour assertion throws.
  const REVERSAL_CATS = [
    cat({ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#2ac3de' }),
    cat({ id: 'bonus', name: 'Bonus', bucket: 'Income', icon: 'cash', color: '#9ece6a' }),
  ];
  it('renders a net-reversed source as a signed, neutral, still-tappable row (no plug when it reconciles)', () => {
    mockData = screenData({
      earned: 1850,
      incomeSources: [
        { id: 'salary', posted: 2000, pending: 0, amount: 2000 },
        { id: 'bonus', posted: -150, pending: 0, amount: -150 },
      ],
      category: lookup(REVERSAL_CATS),
    });
    render(<Breakdown />);

    expect(screen.getByText('$1,850')).toBeTruthy();       // headline unchanged (true net)
    expect(screen.getByText('-$150')).toBeTruthy();         // signed reversal, not "$150"
    expect(colorOf('-$150')).toBe(C.textMid);               // neutral tone
    expect(colorOf('-$150')).not.toBe(C.good);              // not a green credit
    expect(colorOf('-$150')).not.toBe(C.textBright);        // not a positive row
    fireEvent.press(screen.getByText('Bonus'));             // still a real, tappable source
    expect(mockPush).toHaveBeenCalledWith('/category/bonus?cycle=0');
    expect(screen.queryByText('Pending/refund adjustment')).toBeNull(); // rows already sum -> no plug
  });

  // WHIT-376: the sign-split case (settled bucket negative, pending positive) leaves the sources
  // summing BELOW the headline; one muted, non-tappable "adjustment" plug closes the gap so the
  // visible rows sum to the unchanged headline. Fail-on-revert: remove the plug and the rows sum
  // to $200 under a $300 headline.
  it('appends one muted, non-tappable adjustment plug so the rows sum to the headline', () => {
    mockData = screenData({
      earned: 300,
      // salary settled −100, pending +300 -> amount 200; headline clamps settled to 0 -> 300.
      incomeSources: [{ id: 'salary', posted: -100, pending: 300, amount: 200 }],
      category: lookup(REVERSAL_CATS),
    });
    render(<Breakdown />);

    expect(screen.getByText('$300')).toBeTruthy();          // headline
    expect(screen.getByText('1 income source')).toBeTruthy(); // the plug is NOT counted
    const plug = screen.getByText('Pending/refund adjustment');
    expect(colorOf('$100')).toBe(C.textDim);                // plug amount, dimmed (residual 300-200)
    fireEvent.press(plug);
    expect(mockPush).not.toHaveBeenCalled();                // display-only, not tappable
  });

  it('adds no adjustment plug on clean data (sources already sum to the headline)', () => {
    // The default fixture (earned 5000, sources 4200 + 800) already reconciles.
    render(<Breakdown />);
    expect(screen.queryByText('Pending/refund adjustment')).toBeNull();
  });
});

// WHIT-376 (QA gaps) — the reconciliation invariant the implementer's tests don't stress: MORE
// THAN ONE reversal, a reversed row AND a plug at once (no double-count), a reversed source with a
// NEGATIVE pending, and the old-server path (earned but no per-source __income__).
describe('Breakdown — Earned (WHIT-376 QA gaps)', () => {
  const CATS = [
    cat({ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#2ac3de' }),
    cat({ id: 'bonus', name: 'Bonus', bucket: 'Income', icon: 'cash', color: '#9ece6a' }),
    cat({ id: 'gig', name: 'Gig', bucket: 'Income', icon: 'cash', color: '#e0af68' }),
  ];

  // [A-multi] TWO sources clawed back this cycle: BOTH render as signed neutral reversals, and the
  // rows still sum to the headline (2000 − 100 − 50 = 1850) so NO plug appears. Fail-on-revert:
  // drop the isReversed branch and "-$100"/"-$50" become "$100"/"$50" and the colour asserts throw.
  it('renders MULTIPLE reversed sources signed + neutral, rows still reconcile (no plug)', () => {
    mockData = screenData({
      earned: 1850,
      incomeSources: [
        { id: 'salary', posted: 2000, pending: 0, amount: 2000 },
        { id: 'bonus', posted: -100, pending: 0, amount: -100 },
        { id: 'gig', posted: -50, pending: 0, amount: -50 },
      ],
      category: lookup(CATS),
    });
    render(<Breakdown />);

    expect(screen.getByText('$1,850')).toBeTruthy();       // headline unchanged
    expect(screen.getByText('3 income sources')).toBeTruthy();
    expect(colorOf('-$100')).toBe(C.textMid);
    expect(colorOf('-$50')).toBe(C.textMid);
    expect(screen.queryByText('Pending/refund adjustment')).toBeNull(); // reconciles -> no plug
  });

  // [A-both] The hardest case: a reversed source AND a residual plug at ONCE. salary is sign-split
  // (settled −100, pending +300 → net +200); gig is a clawback (net −50). The server clamps the
  // negative settled bucket away, so headline = 300 while the visible source nets = 200 − 50 = 150.
  // ONE plug (+150) closes the gap. The invariant: reversed row + plug must sum to the headline
  // WITHOUT double-counting (200 − 50 + 150 = 300). Fail-on-revert: remove the plug → rows sum to
  // 150 under a $300 headline; or drop isReversed → the −$50 flips sign and the total is wrong.
  it('handles a reversed row AND a plug together — rows sum to the headline, no double-count', () => {
    mockData = screenData({
      earned: 300,
      incomeSources: [
        { id: 'salary', posted: -100, pending: 300, amount: 200 }, // sign-split, net +200 (positive row)
        { id: 'gig', posted: -50, pending: 0, amount: -50 },        // clawback, net −50 (reversed row)
      ],
      category: lookup(CATS),
    });
    render(<Breakdown />);

    expect(screen.getByText('$300')).toBeTruthy();          // headline unchanged
    expect(screen.getByText('2 income sources')).toBeTruthy(); // plug NOT counted; both sources are
    expect(screen.getByText('$200')).toBeTruthy();          // salary (positive net) — bright row
    expect(colorOf('$200')).toBe(C.textBright);
    expect(colorOf('-$50')).toBe(C.textMid);                // gig — reversed, neutral
    const plug = screen.getByText('Pending/refund adjustment');
    expect(colorOf('$150')).toBe(C.textDim);                // the plug amount (300 − 150), dimmed
    fireEvent.press(screen.getByText('Gig'));               // reversed source still navigates
    expect(mockPush).toHaveBeenCalledWith('/category/gig?cycle=0');
    fireEvent.press(plug);                                  // ...the plug never does
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  // [A-negpend] A reversed source with a NEGATIVE pending must never surface an unsigned "pending"
  // figure anywhere: the row hides its pending sub-label (guard is `pending > 0`, not `!== 0`) and
  // the headline shows no pending. Rows reconcile (2000 − 150 = 1850) so no plug. Fail-on-revert:
  // weaken the row guard to `!== 0` and a misleading "$150 pending" sub-label appears -> this fails.
  it('hides a reversed source’s negative pending — no unsigned "pending" figure surfaces', () => {
    mockData = screenData({
      earned: 1850,
      incomeSources: [
        { id: 'salary', posted: 2000, pending: 0, amount: 2000 },
        { id: 'bonus', posted: 0, pending: -150, amount: -150 }, // clawback sits in the pending bucket
      ],
      category: lookup(CATS),
    });
    render(<Breakdown />);

    expect(screen.getByText('-$150')).toBeTruthy();          // signed reversal row
    expect(screen.queryByText('$150 pending')).toBeNull();   // no unsigned pending sub-label
    expect(screen.queryByText('Pending/refund adjustment')).toBeNull(); // reconciles -> no plug
    // The headline pending line (styles.totalPending) must not render a bogus figure either.
    expect(screen.queryByText(/pending$/)).toBeNull();
  });

  // [A-oldserver] Old server: __earned__ present (earned > 0) but NO per-source __income__, so
  // incomeSources is empty. The screen must show the empty state and must NOT synthesise a lone
  // plug from the headline (the `items.length > 0` guard). Fail-on-revert: drop that guard and a
  // single "$5,000" plug row appears -> items.length becomes 1 -> the empty state disappears.
  it('old server (earned but no __income__): empty state, never a lone synthetic plug', () => {
    mockData = screenData({ earned: 5000, incomeSources: [], category: lookup(CATS) });
    render(<Breakdown />);

    expect(screen.getByText('No income recorded for this cycle.')).toBeTruthy();
    expect(screen.queryByText('Pending/refund adjustment')).toBeNull();
    expect(screen.queryByTestId('breakdown-total')).toBeNull(); // no headline card, no plug row
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

  // WHIT-375 — the refund line is the exact convention that once drifted (it showed "-$30").
  // Lock it on THIS screen: a refund renders as an UNSIGNED green credit, never a signed minus.
  // node 70 = petrol 100 + tolls refund(-30) exactly, so there is no "Other" plug — the "$30"
  // is unambiguously the refund line. Fail-on-revert: if breakdown stops using breakdownLineStyle
  // and re-signs the refund, "$30" disappears (becomes "-$30") and colorOf('$30') throws.
  it('renders a refund member as an unsigned green credit (no minus sign)', () => {
    const refundCats = [
      cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
      cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
      cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'car' }),
    ];
    mockData = screenData({
      breakdown: withRollup(
        { petrol: spend({ posted: 100, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }) },
        { nodes: { car: { posted: 70, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
      ) as Record<string, unknown>,
      category: lookup(refundCats),
    });
    mockParams = { kind: 'spent', cycle: '0', parent: 'car' };
    render(<Breakdown />);

    expect(screen.getByText('Tolls')).toBeTruthy();
    expect(colorOf('$30')).toBe(C.good);          // green credit
    expect(screen.queryByText('-$30')).toBeNull(); // never a signed minus (the historical drift)
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
