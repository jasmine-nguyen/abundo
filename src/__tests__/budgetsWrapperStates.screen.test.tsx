// WHIT-199 GAP — Budgets' loading/error states now render as CENTERED children inside the shared
// wrapper's ScrollView, via `contentContainerStyle={(showSpinner||showError) ? styles.fill : undefined}`
// (styles.fill = {flexGrow:1}). budgetsQuery locks that the spinner/error *render*; this locks the
// NEW centering wiring the migration added — and that the loaded path does NOT force flexGrow.
// Fail-on-revert: drop the styles.fill branch → flexGrow is undefined in loading/error and these flip.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { ScrollView, StyleSheet, Animated } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// Shared across both folds: the ../queries stub (single mockBudgets source) and expo-router mock
// (byte-identical in both originals, hoisted once). mockBudgets is typed `any` so both the
// wrapper-states shapes and the motion-scroll shape can be assigned to the one variable.
let mockBudgets: any;
jest.mock('../queries', () => ({ useBudgetsScreenData: () => mockBudgets }));
jest.mock('expo-router', () => {
  const React2 = require('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (cb: () => void) => React2.useEffect(() => cb(), [cb]),
  };
});

// Mocked-module UNION added for the folded WHIT-184/200 motion-scroll tests: the wrapper-states
// tests originally used the REAL ../motion/NavBarsContext (safe defaults) — this stub is inert for
// them (they never scroll, so setNavBars is never called and none of their assertions read it).
// mockSetNavBars/mockStateRef stay at module scope because the jest.mock factory closes over them.
let mockStateRef: { current: 'shown' | 'hidden' } = { current: 'shown' };
const mockSetNavBars = jest.fn((n: 'shown' | 'hidden') => { mockStateRef.current = n; });
jest.mock('../motion/NavBarsContext', () => {
  const { Animated: RNAnimated } = require('react-native');
  return { useNavBars: () => ({ visibility: new RNAnimated.Value(1), setNavBars: mockSetNavBars, stateRef: mockStateRef }) };
});

import Budgets from '../../app/(tabs)/budgets';

const base = {
  budgets: [], category: () => undefined, cycleLen: 14, daysLeft: 7,
  payCycleError: false, refetch: jest.fn(), refetchStale: jest.fn(),
};

function contentStyle() {
  const sv = screen.UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { contentContainerStyle: unknown } };
  return StyleSheet.flatten(sv.props.contentContainerStyle) as { flexGrow?: number; paddingBottom?: number };
}

beforeEach(() => { jest.clearAllMocks(); });

it('loading: spinner is centered (flexGrow) inside the wrapper, clearance still applied', () => {
  mockBudgets = { ...base, isLoading: true, isError: false };
  render(<Budgets />);
  expect(screen.getByTestId('budgets-loading')).toBeTruthy();
  const cc = contentStyle();
  expect(cc.flexGrow).toBe(1);        // centred fill
  expect(cc.paddingBottom).toBe(120); // shared TAB_BAR_CLEARANCE still merged in (real geometry)
});

it('error: retry state is centered (flexGrow) inside the wrapper', () => {
  mockBudgets = { ...base, isLoading: false, isError: true };
  render(<Budgets />);
  expect(screen.getByTestId('budgets-error')).toBeTruthy();
  expect(contentStyle().flexGrow).toBe(1);
});

it('loaded: content scrolls normally — no flexGrow forced on the list', () => {
  mockBudgets = { ...base, isLoading: false, isError: false };
  render(<Budgets />);
  expect(contentStyle().flexGrow).toBeUndefined();
});

// ===== WHIT-184/200 (folded from budgetsMotionScroll.screen.test.tsx) — the scroll-to-hide wiring.
// Same ../queries + expo-router regime; adds the ../motion/NavBarsContext stub (now at module scope).
// The motion-only fixture (loaded, no rows → ScrollView with a live onScroll) and helpers are
// block-scoped here; the module-scope mockSetNavBars/mockStateRef are reset in this block's beforeEach. =====
describe('WHIT-184/200 budgets scroll-to-hide (folded from budgetsMotionScroll)', () => {
  // Budgets is query-fed; return the minimal shape useBudgetsScreenData exposes with NO rows
  // so the screen skips the spinner/error and renders the ScrollView (rows empty → onScroll live).
  const category = (_id: string | null) => undefined;

  beforeEach(() => {
    mockSetNavBars.mockClear();
    mockStateRef = { current: 'shown' };
    mockBudgets = {
      budgets: [], category, cycleLen: 14, daysLeft: 7,
      isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(),
    };
  });

  function scrollTo(sv: { props: { onScroll: (e: unknown) => void } }, y: number) {
    sv.props.onScroll({ nativeEvent: { contentOffset: { y } } });
  }

  it('budgets: scrolling down hides the nav bars, scrolling back up shows it', () => {
    const { UNSAFE_getAllByType } = render(<Budgets />);
    const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void } };

    scrollTo(sv, 120); // down past threshold, out of the top zone
    expect(mockSetNavBars).toHaveBeenLastCalledWith('hidden');

    scrollTo(sv, 20); // back up
    expect(mockSetNavBars).toHaveBeenLastCalledWith('shown');
  });

  it('budgets: a tiny jitter scroll near the top does not toggle the nav bars', () => {
    const { UNSAFE_getAllByType } = render(<Budgets />);
    const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void } };
    scrollTo(sv, 3); // inside the top zone, already shown → no call
    expect(mockSetNavBars).not.toHaveBeenCalled();
  });

  it('budgets: exposes scrollEventThrottle=16 so onScroll fires while dragging', () => {
    const { UNSAFE_getAllByType } = render(<Budgets />);
    const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { scrollEventThrottle: number } };
    expect(sv.props.scrollEventThrottle).toBe(16);
  });

  it('budgets: renders the animated (Animated.View) header', () => {
    const { UNSAFE_getAllByType } = render(<Budgets />);
    expect(UNSAFE_getAllByType(Animated.View).length).toBeGreaterThan(0);
  });
});
