// WHIT-268 — overlays render OUTSIDE the auth gate (app/_layout.tsx), so the gate's
// privacy cover can never hide them: a toast/sheet showing amounts could outlive a
// sign-out over the login screen, or sit above the Face ID lock screen. Two behaviours
// pin the fix:
//  - sign-out (status 'anon') HARD-CLEARS all overlay state + the server-derived AI
//    insights (AppProvider's anon subscription), including async writers that settle
//    AFTER the flip (a late resolve must not re-seat the old account's data);
//  - any not-authed status (e.g. 'locked') merely HIDES the overlay layer (Overlays
//    render gate) so a half-typed sheet form survives a Face ID resume.
// The auth store is mocked LIVE (mutable status + real listener set, the
// authGateTransitions pattern) so status flips re-render exactly as production does.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, renderHook, act, screen } from '@testing-library/react-native';

// Live miniature auth store; the jest.mock factories close over the mock-prefixed vars.
let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => {
  mockStatus = s;
  mockListeners.forEach((l) => l());
};
const mockSubscribe = (l: () => void) => {
  mockListeners.add(l);
  return () => mockListeners.delete(l);
};

jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (l: () => void) => mockSubscribe(l),
}));

jest.mock('../api');
// Overlays' inner sheets call real query hooks; re-route them via the shared support
// mocks, but keep useIsAuthed LIVE off the auth store above (the fixture pins it true,
// which would defeat the render gate this suite exists to test).
jest.mock('../queries', () => ({
  ...require('./support/screenQueryMocks').queryMocksFromState(() => ({})),
  useIsAuthed: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSubscribe, () => mockStatus === 'authed');
  },
}));

import { AppProvider, useAppContext } from '../context';
import { Overlays } from '../components/Overlays';
import { queryClient } from '../queryClient';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
  jest.useRealTimers();
});

// --- sign-out hard-clears the overlay + AI state ---------------------------------

it('flipping to anon clears sheet, toast, notif and the AI insights state (fail-on-revert for the anon subscription)', async () => {
  mockApi.generateAiInsights.mockResolvedValue({ summary: 'old account insights' } as never);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => {
    result.current.setSheet({ mode: 'paycycle' } as never);
    result.current.showToast('Transaction filed: $123.45');
    await result.current.generateAiInsights(null);
  });
  expect(result.current.sheet).not.toBeNull();
  expect(result.current.toast).toBe('Transaction filed: $123.45');
  expect(result.current.aiInsights).not.toBeNull();

  act(() => mockSetStatus('anon'));

  expect(result.current.sheet).toBeNull();
  expect(result.current.toast).toBeNull();
  expect(result.current.notif).toBeNull();
  expect(result.current.aiInsights).toBeNull();
  expect(result.current.aiInsightsError).toBe(false);
});

it('an AI generate that settles AFTER sign-out cannot re-seat the old account data, even if a new session is live (session-epoch guard)', async () => {
  let resolveGenerate!: (v: api.AiInsights) => void;
  mockApi.generateAiInsights.mockImplementation(() => new Promise<api.AiInsights>((res) => { resolveGenerate = res; }));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  let pending!: Promise<void>;
  act(() => {
    pending = result.current.generateAiInsights(null);
  });
  act(() => mockSetStatus('anon')); // the session dies while the request is in flight
  act(() => mockSetStatus('authed')); // …and a NEW session signs in before it settles
  await act(async () => {
    resolveGenerate({ summary: 'old account insights' } as unknown as api.AiInsights);
    await pending;
  });

  // A plain status==='authed' check would WRONGLY accept this (status is authed again);
  // the epoch bumped on the anon flip, so the stale result is dropped.
  expect(result.current.aiInsights).toBeNull();
  expect(result.current.aiInsightsError).toBe(false);
});

it('a stale generate settling after re-sign-in does NOT clear the NEW session spinner (epoch-guarded finally)', async () => {
  let resolveA!: (v: api.AiInsights) => void;
  mockApi.generateAiInsights
    .mockImplementationOnce(() => new Promise<api.AiInsights>((res) => { resolveA = res; }))
    .mockImplementationOnce(() => new Promise<api.AiInsights>(() => {})); // B stays in flight
  const { result } = renderHook(() => useAppContext(), { wrapper });

  let pendingA!: Promise<void>;
  act(() => { pendingA = result.current.generateAiInsights(null); }); // A in flight (epoch 0)
  act(() => mockSetStatus('anon'));   // sign out → epoch bumps, loading reset
  act(() => mockSetStatus('authed')); // a NEW session signs in
  act(() => { void result.current.generateAiInsights(null); }); // B in flight → loading true
  expect(result.current.aiInsightsLoading).toBe(true);

  await act(async () => {
    resolveA({ summary: 'stale A' } as unknown as api.AiInsights);
    await pendingA;
  });

  // A's finally must not touch B's spinner — B is still generating.
  expect(result.current.aiInsightsLoading).toBe(true);
});

it('an AI generate that settles during a Face ID LOCK (same session) is KEPT, not dropped', async () => {
  let resolveGenerate!: (v: api.AiInsights) => void;
  mockApi.generateAiInsights.mockImplementation(() => new Promise<api.AiInsights>((res) => { resolveGenerate = res; }));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  let pending!: Promise<void>;
  act(() => {
    pending = result.current.generateAiInsights(null);
  });
  act(() => mockSetStatus('locked')); // backgrounded → Face ID seal, SAME session
  await act(async () => {
    resolveGenerate({ summary: 'my insights' } as unknown as api.AiInsights);
    await pending;
  });

  // Epoch unchanged (lock is not sign-out), so the paid result the user is waiting for
  // survives the lock and is there after unlock. A status!=='authed' guard would lose it.
  expect(result.current.aiInsights).toEqual({ summary: 'my insights' });
});

// --- the render gate hides (does NOT clear) while locked --------------------------

function Probe({ grab }: { grab: (ctx: ReturnType<typeof useAppContext>) => void }) {
  grab(useAppContext());
  return <Text testID="probe">probe</Text>;
}

it('locked hides the overlay layer but keeps its state: the toast disappears and REAPPEARS on unlock (fail-on-revert for the gate)', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  render(
    <AppProvider>
      <Probe grab={(c) => { ctx = c; }} />
      <Overlays />
    </AppProvider>,
  );

  act(() => ctx.showToast('Balance: $9,999'));
  expect(screen.getByText('Balance: $9,999')).toBeTruthy();

  act(() => mockSetStatus('locked')); // Face ID resume seal
  // Hidden from the tree — nothing money-related can sit over the lock screen…
  expect(screen.queryByText('Balance: $9,999')).toBeNull();
  // …but the context-held toast value is NOT cleared on a lock (only on 'anon'), so it
  // reappears on unlock. (A sheet's LOCAL form state is a different matter — unmounting
  // loses it; preserving that across a lock is WHIT-266, not this card.)
  expect(ctx.toast).toBe('Balance: $9,999');

  act(() => mockSetStatus('authed'));
  expect(screen.getByText('Balance: $9,999')).toBeTruthy(); // reappears intact
});

it('anon unmounts the overlay layer AND the state is gone (both halves compose)', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  render(
    <AppProvider>
      <Probe grab={(c) => { ctx = c; }} />
      <Overlays />
    </AppProvider>,
  );

  act(() => ctx.showToast('Balance: $9,999'));
  act(() => mockSetStatus('anon'));

  expect(screen.queryByText('Balance: $9,999')).toBeNull(); // hidden by the gate
  expect(ctx.toast).toBeNull(); // and hard-cleared by the anon subscription
});
