// WHIT-380 (QA gap) — the Earned "Pending/refund adjustment" plug's RECONCILE_EPSILON boundary
// in app/breakdown.tsx. The implementer's breakdown.screen.test.tsx pins the plug's LABEL/tone/
// not-tappable and its ABSENCE when sources sum EXACTLY to the headline (residual 0), plus its
// PRESENCE at large residuals (100 / 150). What no test pins is the TOLERANCE itself: a sub-half-
// cent residual (float dust) must be SUPPRESSED, and a residual just over the half-cent must still
// plug. This mirrors [G10]/[G11] which lock the SAME epsilon on the Spend remainder side — after
// WHIT-380 both read one shared RECONCILE_EPSILON, so the Earned plug needs its own boundary lock.
// Reachability note: the plug is built inline inside the Breakdown component (not an exported pure
// fn), so — like the implementer's tests — it is exercised through a render with useInsightsScreenData
// mocked. Fail-on-revert (proven): change `>= RECONCILE_EPSILON` to `> 0` (or drop the guard) and
// the sub-epsilon suppression case reddens; bump RECONCILE_EPSILON to 0.01 and the just-over case reddens.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { cat } from './factory';
import type { Category } from '../context';

let mockData: ReturnType<typeof base>;
let mockParams: { kind?: string; cycle?: string; parent?: string };

jest.mock('../queries', () => ({
  useInsightsScreenData: () => mockData,
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Breakdown from '../../app/breakdown';

function lookup(cats: Category[]) {
  const byId = new Map(cats.map((c) => [c.id, c]));
  return (id: string) => byId.get(id);
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

const CATS = [cat({ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#2ac3de' })];

beforeEach(() => {
  mockParams = { kind: 'earned', cycle: '0' };
});

describe('Breakdown — Earned plug RECONCILE_EPSILON boundary (WHIT-380)', () => {
  it('SUPPRESSES the plug when the residual is float dust below the half-cent tolerance', () => {
    // one source nets 9.996; earned = 10 ⇒ residual ≈ 0.004 (< 0.005). No phantom plug.
    mockData = { ...base(), earned: 10, incomeSources: [{ id: 'salary', posted: 9.996, pending: 0, amount: 9.996 }], category: lookup(CATS) };
    render(<Breakdown />);
    expect(screen.getByText('Salary')).toBeTruthy();                     // the real source still renders
    expect(screen.queryByText('Pending/refund adjustment')).toBeNull();  // dust residual → no plug
    expect(screen.getByText('1 income source')).toBeTruthy();
  });

  it('APPENDS the plug when the residual is just OVER the half-cent tolerance', () => {
    // source nets 9.994; earned = 10 ⇒ residual ≈ 0.006 (>= 0.005). One plug closes the gap.
    mockData = { ...base(), earned: 10, incomeSources: [{ id: 'salary', posted: 9.994, pending: 0, amount: 9.994 }], category: lookup(CATS) };
    render(<Breakdown />);
    expect(screen.getByText('Pending/refund adjustment')).toBeTruthy();  // just-over residual → plug
    expect(screen.getByText('1 income source')).toBeTruthy();            // plug is NOT counted as a source
  });
});
