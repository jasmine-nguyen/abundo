// WHIT-277 — a half-typed pop-up sheet must survive a Face ID lock. The sheet UNMOUNTS while
// locked (Overlays' WHIT-268 privacy shield returns null), so its local useState is destroyed;
// the draft is stashed in the always-mounted AppProvider and restored on the unlock remount.
// These pin: draft survives authed→locked→authed; nothing sheet-related renders while locked
// (WHIT-268 intact); draft cleared on sign-out AND on close (no stale restore / cross-user leak).
// Harness mirrors overlaysAuthClear.screen.test.tsx: live mini auth store, useIsAuthed LIVE.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, act, screen, fireEvent } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => { mockStatus = s; mockListeners.forEach((l) => l()); };
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({ getStatus: () => mockStatus, subscribe: (l: () => void) => mockSubscribe(l) }));
jest.mock('../api');

let mockState: { goals?: unknown[] } = {};
jest.mock('../queries', () => ({
  ...require('./support/screenQueryMocks').queryMocksFromState(() => mockState),
  useIsAuthed: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSubscribe, () => mockStatus === 'authed');
  },
  // GoalBalanceSheet reads the live goal via useGoalsQuery (not in the shared support mock).
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

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  mockState = { goals: [{ id: 'g1', name: 'Emergency fund', icon: 'star', direction: 'save', target_amount: 1000, target_date: null, baseline: null, manual_balance: null }] };
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); });

const RULE_INPUT = 'e.g. NETFLIX';

describe('WHIT-277 — pop-up sheet drafts survive a Face ID lock', () => {
  it('restores a half-typed AddRule draft across authed→locked→authed', () => {
    renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');

    // Lock: the whole overlay layer unmounts (WHIT-268 privacy shield) — the input is gone.
    act(() => mockSetStatus('locked'));
    expect(screen.queryByPlaceholderText(RULE_INPUT)).toBeNull();
    expect(screen.queryByText('New rule')).toBeNull();

    // Unlock: the sheet remounts and restores the stashed text.
    act(() => mockSetStatus('authed'));
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');
  });

  it('restores a half-typed GoalBalance draft across authed→locked→authed', () => {
    renderOverlays();
    act(() => ctx.setSheet({ mode: 'goalbalance', goalId: 'g1' }));
    fireEvent.changeText(screen.getByTestId('goal-balance-input'), '2500');
    expect(screen.getByTestId('goal-balance-input').props.value).toBe('2500');

    act(() => mockSetStatus('locked'));
    expect(screen.queryByTestId('goal-balance-input')).toBeNull();

    act(() => mockSetStatus('authed'));
    expect(screen.getByTestId('goal-balance-input').props.value).toBe('2500');
  });

  it('clears the draft on sign-out — the next session opens the sheet empty (no cross-user leak)', () => {
    renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');

    act(() => mockSetStatus('anon')); // sign-out: hard-clears drafts + the sheet descriptor
    act(() => mockSetStatus('authed'));
    act(() => ctx.setSheet({ mode: 'addrule' }));
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('');
  });

  it('clears the draft on close — reopening the same sheet starts empty (no stale restore)', () => {
    renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');

    act(() => ctx.setSheet(null)); // cancel/submit both route through null → clear-on-close
    act(() => ctx.setSheet({ mode: 'addrule' }));
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('');
  });
});
