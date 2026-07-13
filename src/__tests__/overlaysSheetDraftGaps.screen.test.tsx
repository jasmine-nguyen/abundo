// WHIT-277 — adversarial GAPS for pop-up sheet drafts surviving a Face ID lock.
// The implementer (overlaysSheetDraft.screen.test.tsx) pins the `pattern` half of AddRule and the
// `balance` half of GoalBalance across a lock, plus clear-on-close / clear-on-sign-out. This file
// adds the halves + key-isolation + WHIT-268 guards they did NOT cover:
//   [A5] the categoryId (pill selection) half of an AddRule draft survives a lock (they assert pattern only)
//   [A6] the asOf date half of a GoalBalance draft survives a lock (they assert balance only)
//   [A7] EDITING an existing rule (ruleId set): the typed change survives a lock AND still differs
//        from the original prefill (draft, not the prefill fallback, wins on remount)
//   [A8] distinct draft keys — a NEW-rule draft does not leak into an EDIT sheet, and vice-versa
//   [A9] WHIT-268 fail-on-revert for the GOAL sheet: while status==='locked', the typed money figure
//        is not readable by ANY query even though a draft is stashed
// Harness mirrors overlaysSheetDraft.screen.test.tsx: live mini auth store, useIsAuthed LIVE,
// useGoalsQuery override, render <AppProvider><Probe/><Overlays/>.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, act, screen, fireEvent } from '@testing-library/react-native';
import { formatDayMonthYear, toISODate } from '../dateutil';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => { mockStatus = s; mockListeners.forEach((l) => l()); };
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({ getStatus: () => mockStatus, subscribe: (l: () => void) => mockSubscribe(l) }));
jest.mock('../api');

let mockState: { categories?: unknown[]; rules?: unknown[]; goals?: unknown[] } = {};
jest.mock('../queries', () => ({
  ...require('./support/screenQueryMocks').queryMocksFromState(() => mockState),
  useIsAuthed: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSubscribe, () => mockStatus === 'authed');
  },
  useGoalsQuery: () => ({ data: mockState.goals ?? [] }),
}));

import { AppProvider, useAppContext } from '../context';
import { Overlays } from '../components/Overlays';
import { queryClient } from '../queryClient';

let ctx!: ReturnType<typeof useAppContext>;
function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
function renderOverlays() {
  return render(
    <AppProvider>
      <Probe />
      <Overlays />
    </AppProvider>,
  );
}

const RULE_INPUT = 'e.g. NETFLIX';
const CATS = [
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
  { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
];

// A category pill's label goes white (#fff) when selected, C.textMid ('#9a9aa4') otherwise
// (Overlays.tsx ruleCatText style). Flatten the style array and read the effective color.
function pillColor(name: string): string | undefined {
  const el = screen.getByText(name);
  const style = Array.isArray(el.props.style) ? el.props.style : [el.props.style];
  return style.reduce((acc: Record<string, unknown>, s) => ({ ...acc, ...(s || {}) }), {}).color as string | undefined;
}

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  mockState = {
    categories: CATS,
    rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }],
    goals: [{ id: 'g1', name: 'Emergency fund', icon: 'star', direction: 'save', target_amount: 1000, target_date: null, baseline: null, manual_balance: null }],
  };
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); });

describe('WHIT-277 gaps — draft halves, key isolation, and the WHIT-268 lock guard', () => {
  it('[A5] restores the categoryId (pill) half of an AddRule draft across a lock, not just the pattern', () => {
    renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
    fireEvent.press(screen.getByText('Groceries')); // select the pill
    expect(pillColor('Groceries')).toBe('#fff');
    expect(pillColor('Subscriptions')).not.toBe('#fff');

    act(() => mockSetStatus('locked'));
    expect(screen.queryByText('Groceries')).toBeNull(); // whole sheet unmounted

    act(() => mockSetStatus('authed'));
    // Both halves come back: the typed pattern AND the chosen category pill.
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');
    expect(pillColor('Groceries')).toBe('#fff');
    expect(pillColor('Subscriptions')).not.toBe('#fff');
  });

  it('[A6] restores the asOf DATE half of a GoalBalance draft across a lock, not just the balance', () => {
    renderOverlays();
    act(() => ctx.setSheet({ mode: 'goalbalance', goalId: 'g1' }));
    // Move the as-of off today via the (globally-mocked) date picker → fixed 20 Jun 2026.
    const androidOpen = screen.queryByTestId('goal-asof-open');
    if (androidOpen) fireEvent.press(androidOpen);
    fireEvent.press(screen.getByTestId('mock-datepicker'));
    const pickedLabel = formatDayMonthYear('2026-06-20');
    const todayLabel = formatDayMonthYear(toISODate(new Date()));
    expect(pickedLabel).not.toBe(todayLabel); // guard: the test only means something if they differ
    expect(screen.getByText(pickedLabel)).toBeTruthy();

    act(() => mockSetStatus('locked'));
    expect(screen.queryByText(pickedLabel)).toBeNull();

    act(() => mockSetStatus('authed'));
    // The picked date survives — it did NOT snap back to today's default.
    expect(screen.getByText(pickedLabel)).toBeTruthy();
    expect(screen.queryByText(todayLabel)).toBeNull();
  });

  it('[A7] an EDIT-rule draft survives a lock AND still differs from the original prefill', () => {
    renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule', ruleId: 'e1' }));
    expect(screen.getByDisplayValue('NETFLIX')).toBeTruthy(); // prefilled from the rule
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'NETFLIXX');

    act(() => mockSetStatus('locked'));
    act(() => mockSetStatus('authed'));

    // The EDITED text is restored — not the original 'NETFLIX' prefill fallback.
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('NETFLIXX');
    expect(screen.queryByDisplayValue('NETFLIX')).toBeNull();
  });

  it('[A8] a NEW-rule draft does not leak into an EDIT sheet (distinct draft keys, no null between)', () => {
    renderOverlays();
    // New rule: type text under the `addrule:new` key.
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'AAA');

    // Switch straight to EDITING e1 WITHOUT closing (no setSheet(null)) — so nothing is cleared;
    // the sheet remounts under key `addrule:e1` and must read ITS key, not the new-rule draft.
    act(() => ctx.setSheet({ mode: 'addrule', ruleId: 'e1' }));
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('NETFLIX');
    expect(screen.queryByDisplayValue('AAA')).toBeNull();

    // And back to the new-rule sheet: its own draft is still intact (keys are independent).
    act(() => ctx.setSheet({ mode: 'addrule' }));
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('AAA');
  });

  it('[A9] WHIT-268: while locked WITH a draft stashed, the typed money figure is not readable by any query', () => {
    renderOverlays();
    act(() => ctx.setSheet({ mode: 'goalbalance', goalId: 'g1' }));
    fireEvent.changeText(screen.getByTestId('goal-balance-input'), '9999');
    expect(screen.getByDisplayValue('9999')).toBeTruthy();

    act(() => mockSetStatus('locked'));
    // The privacy shield must hide the whole sheet even though the draft (9999) is stashed in the
    // provider — nothing money-related may sit over the Face ID lock.
    expect(screen.queryByTestId('goal-balance-input')).toBeNull();
    expect(screen.queryByDisplayValue('9999')).toBeNull();
    expect(screen.queryByText('Emergency fund — set the current balance and the date it was true.')).toBeNull();

    // …and it all comes back intact on unlock (proves it was HIDDEN, not cleared).
    act(() => mockSetStatus('authed'));
    expect(screen.getByDisplayValue('9999')).toBeTruthy();
  });
});
