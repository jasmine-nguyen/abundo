// WHIT-199 GAP — Budgets' loading/error states now render as CENTERED children inside the shared
// wrapper's ScrollView, via `contentContainerStyle={(showSpinner||showError) ? styles.fill : undefined}`
// (styles.fill = {flexGrow:1}). budgetsQuery locks that the spinner/error *render*; this locks the
// NEW centering wiring the migration added — and that the loaded path does NOT force flexGrow.
// Fail-on-revert: drop the styles.fill branch → flexGrow is undefined in loading/error and these flip.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

let mockBudgets: Record<string, unknown>;
jest.mock('../queries', () => ({ useBudgetsScreenData: () => mockBudgets }));
jest.mock('expo-router', () => {
  const React2 = require('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (cb: () => void) => React2.useEffect(() => cb(), [cb]),
  };
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
