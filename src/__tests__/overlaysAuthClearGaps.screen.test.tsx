// WHIT-268 (QA gaps) — adversarial complements to overlaysAuthClear.screen.test.tsx.
// That suite locks the anon hard-clear (sheet/toast/AI), the late-settling generate,
// the toast-timer cancel, and the locked hide/reappear. This one covers what it left:
//  [A6]  the notification banner (fireRepayment's notif) is actually SHOWN then cleared
//        on anon — the sibling suite only asserts notif null without ever setting one;
//  [A7]  refreshAiInsights (the FREE cache read, fired on every Insights focus) settling
//        after sign-out is dropped, even when a NEW session is already live (the epoch
//        semantic) — only the paid generate was covered;
//  [A8]  the real invalidated-biometrics sequence locked → anon clears the kept state,
//        and a duplicate anon broadcast is harmless (safe to run twice);
//  [A9]  cold-start 'loading' hides the overlay layer (nothing can float before the
//        first auth resolve) without clearing its state;
//  [A10] an async rule save settling after sign-out does NOT re-seed the cleared
//        ['rules'] query cache (patchRules' undefined-guard is the fail-on-revert seam).
// Harness mirrors the sibling suite: live miniature auth store + screenQueryMocks.
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
// A raw re-broadcast WITHOUT a status change — the "duplicate anon" case in [A8].
const mockRebroadcast = () => mockListeners.forEach((l) => l());
const mockSubscribe = (l: () => void) => {
  mockListeners.add(l);
  return () => mockListeners.delete(l);
};

jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (l: () => void) => mockSubscribe(l),
}));

jest.mock('../api');
// Keep useIsAuthed LIVE off the auth store above (the fixture pins it true, which would
// defeat the render gate under test); everything else goes to the shared support mocks.
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

function Probe({ grab }: { grab: (ctx: ReturnType<typeof useAppContext>) => void }) {
  grab(useAppContext());
  return <Text testID="probe">probe</Text>;
}

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
  jest.useRealTimers();
});

// WHIT-268 — [A6] the notif banner is shown, then hard-cleared on sign-out.
it('a visible notification banner is cleared (state AND render) when status flips to anon', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  render(
    <AppProvider>
      <Probe grab={(c) => { ctx = c; }} />
      <Overlays />
    </AppProvider>,
  );

  act(() => ctx.fireRepayment()); // the only notif producer — seeds a real banner + 5.6s timer
  expect(ctx.notif).not.toBeNull();
  expect(screen.getByText('WHITTLE')).toBeTruthy(); // the banner is genuinely on screen

  act(() => mockSetStatus('anon'));

  expect(ctx.notif).toBeNull(); // hard-cleared by the anon subscription…
  expect(screen.queryByText('WHITTLE')).toBeNull(); // …and gone from the tree
});

// WHIT-268 — [A7] the FREE insights cache read (fired on every Insights tab focus)
// settling after sign-out must be dropped, exactly like the paid generate.
it('a refreshAiInsights that settles AFTER sign-out cannot re-seat the old account insights', async () => {
  // Phase 1 (control): while authed, a refresh genuinely seats data — so the null
  // assertion below can't pass vacuously.
  mockApi.fetchAiInsights.mockResolvedValueOnce({ summary: 'live session' } as never);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await act(async () => { await result.current.refreshAiInsights(); });
  expect(result.current.aiInsights).not.toBeNull();

  // Phase 2: a refresh in flight when the session ends.
  let resolveFetch!: (v: api.AiInsights) => void;
  mockApi.fetchAiInsights.mockImplementation(() => new Promise<api.AiInsights>((res) => { resolveFetch = res; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.refreshAiInsights(); });
  act(() => mockSetStatus('anon')); // sign-out mid-flight (anon subscription clears state)
  act(() => mockSetStatus('authed')); // …and a NEW session signs in before it settles
  await act(async () => {
    resolveFetch({ summary: 'old account insights' } as unknown as api.AiInsights);
    await pending;
  });

  // A status==='authed' check would wrongly accept this; the epoch bump must drop it.
  expect(result.current.aiInsights).toBeNull();
});

// WHIT-268 — [A8] the invalidated-biometrics path: locked (state kept) → anon (state
// cleared); a duplicate anon broadcast is safe to run twice.
it('locked keeps the state, the follow-on anon clears it, and a duplicate anon broadcast is harmless', () => {
  const { result } = renderHook(() => useAppContext(), { wrapper });

  act(() => result.current.showToast('Balance: $9,999'));
  act(() => result.current.setSheet({ mode: 'paycycle' } as never));

  act(() => mockSetStatus('locked')); // Face ID resume seal — state must SURVIVE
  expect(result.current.toast).toBe('Balance: $9,999');
  expect(result.current.sheet).not.toBeNull();

  act(() => mockSetStatus('anon')); // unlock() found the key invalidated → clearSession
  expect(result.current.toast).toBeNull();
  expect(result.current.sheet).toBeNull();

  act(() => mockRebroadcast()); // a second broadcast while already anon
  expect(result.current.toast).toBeNull(); // still clear, nothing thrown
  expect(result.current.sheet).toBeNull();
});

// WHIT-268 — [A9] cold start: while status is 'loading' (before the first auth resolve)
// the overlay layer is hidden — but NOT cleared (loading is not a sign-out).
it("during the cold-start 'loading' status the overlay layer is hidden, and its state survives to authed", () => {
  mockStatus = 'loading';
  let ctx!: ReturnType<typeof useAppContext>;
  render(
    <AppProvider>
      <Probe grab={(c) => { ctx = c; }} />
      <Overlays />
    </AppProvider>,
  );

  act(() => ctx.showToast('Balance: $1,234'));
  expect(screen.queryByText('Balance: $1,234')).toBeNull(); // hidden pre-auth
  expect(ctx.toast).toBe('Balance: $1,234'); // not cleared — loading isn't anon

  act(() => mockSetStatus('authed'));
  expect(screen.getByText('Balance: $1,234')).toBeTruthy(); // renders once authed
});

// WHIT-268 — [A10] an async writer settling after sign-out must not re-seed the cleared
// query cache: the rule create's reconcile (patchRules) no-ops on an empty cache.
it("a rule save that settles AFTER sign-out does not re-seed the cleared ['rules'] cache", async () => {
  queryClient.setQueryData(['rules'], []); // a warm rules cache, as if the screen was open
  let resolveCreate!: (v: api.EnrichmentRule) => void;
  mockApi.createEnrichment.mockImplementation(() => new Promise<api.EnrichmentRule>((res) => { resolveCreate = res; }));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  let pending!: Promise<void>;
  act(() => { pending = result.current.saveManualRule('NETFLIX', 'c1'); });
  // The optimistic write landed while authed (that part is fine and invisible post-clear).
  expect(queryClient.getQueryData(['rules'])).toHaveLength(1);

  // Sign-out, in production order: clearSession() clears the cache BEFORE broadcasting anon.
  act(() => { queryClient.clear(); mockSetStatus('anon'); });
  await act(async () => {
    resolveCreate({ id: 'srv-1', value: 'NETFLIX', categoryId: 'c1', field: 'description', operator: 'contains' } as api.EnrichmentRule);
    await pending;
  });

  // The reconcile must NOT have re-created the ['rules'] entry in the wiped cache —
  // a seeded entry would be served (fresh for 45s) to the NEXT session.
  expect(queryClient.getQueryData(['rules'])).toBeUndefined();
});

