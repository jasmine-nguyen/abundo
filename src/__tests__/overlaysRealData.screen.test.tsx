// WHIT-459 real-data overlay fold — every <Overlays/> screen test that mounts the REAL
// <AppProvider> (requests go to the fake server) lives here, one child describe per concern. Folded in (scenarios preserved 1:1, 32 its):
//   - WHIT-268  anon hard-clear + locked hide/keep    (was overlaysAuthClear)
//   - WHIT-268  gaps: refresh/epoch/loading/reconcile (was overlaysAuthClearGaps)
//   - WHIT-277  pop-up sheet drafts survive a lock     (was overlaysSheetDraft)
//   - WHIT-277  gaps: draft halves / key isolation     (was overlaysSheetDraftGaps)
//   - WHIT-283  picker inline-create draft survives    (was overlaysPickerCreateDraft)
//   - WHIT-283  gap: restored form RE-SELECTS          (was overlaysPickerCreateDraftRender)
//   - WHIT-437  categorise sheet quick-create reason   (was categorizeSheetCreateReason)
//
// Only ../auth is mocked (a live login store the tests drive). The screen data is the real query
// code (src/queries.ts) over the fake server: each describe seeds what its pop-ups read and draws
// <Overlays/> under the app's query provider (support/renderWithQueries). Each describe keeps its own
// consts / helpers / Probe / renderOverlays / beforeEach block-scoped; only the ../auth mock, the fake
// server and the auth store are module-level (jest.mock can't be per-describe).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, renderHook, act, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { formatDayMonthYear, toISODate } from '../dateutil';
import { BUCKET_COLOR } from '../categoryColors';
import { C } from '../theme';
import { styleOf } from './support/layout';

// Live auth store (support/authMock). A test drives login status via setAuthStatus (broadcasts),
// setAuthStatus(getAuthStatus()) (re-notify, no change) or setAuthStatusQuietly (no broadcast).
jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { getAuthStatus, setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

import { AppProvider, useAppContext } from '../context';
import { Overlays } from '../components/Overlays';
import { queryClient } from '../queryClient';
import { useCategories, useGoalsQuery, useIsAuthed, useRulesScreenData, useTransactionResolver } from '../queries';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES, SUBSCRIPTIONS } from './support/categories';
import { useTestQueryClient, WithQueries, renderWithQueries } from './support/renderWithQueries';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();
useTestQueryClient();

afterEach(() => { jest.useRealTimers(); });

const T1 = [{ transaction_id: 't1', amount: -12, description: 'CAFE', merchant_name: 'Cafe' }];
// The picker resolves a tapped charge from the feed and the recent list; seed both.
function seedTransactions(transactions: unknown[]) {
  server.seed('/transactions', transactions);
  server.seed('/transactions/feed', { transactions, nextCursor: null });
}

// Stands in for the tab screens under the overlay layer: in the app they have already loaded what
// a pop-up reads by the time one opens, so the tests' synchronous checks after setSheet hold.
function ScreensUnderneath() {
  useCategories();
  useRulesScreenData();
  useGoalsQuery(useIsAuthed());
  useTransactionResolver();
  return null;
}

// ===== WHIT-268 — overlays render OUTSIDE the auth gate (app/_layout.tsx), so the gate's
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
describe('WHIT-268 — overlays live outside the auth gate', () => {

  beforeEach(() => {
    resetAuth();
    queryClient.clear();
  });

  // --- sign-out hard-clears the overlay + AI state ---------------------------------

  it('flipping to anon clears sheet, toast and the AI insights state (fail-on-revert for the anon subscription)', async () => {
    server.seed('/insights/ai', { summary: 'old account insights' });
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => {
      result.current.setSheet({ mode: 'paycycle' } as never);
      result.current.showToast('Transaction filed: $123.45');
      await result.current.generateAiInsights(null);
    });
    expect(result.current.sheet).not.toBeNull();
    expect(result.current.toast).toBe('Transaction filed: $123.45');
    expect(result.current.aiInsights).not.toBeNull();

    act(() => setAuthStatus('anon'));

    expect(result.current.sheet).toBeNull();
    expect(result.current.toast).toBeNull();
    expect(result.current.aiInsights).toBeNull();
    expect(result.current.aiInsightsError).toBe(false);
  });

  it('an AI generate that settles AFTER sign-out cannot re-seat the old account data, even if a new session is live (session-epoch guard)', async () => {
    const held = server.hold('/insights/ai');
    server.seed('/insights/ai', { summary: 'old account insights' });
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.generateAiInsights(null);
    });
    await waitFor(() => expect(server.sent('POST', '/insights/ai')).toHaveLength(1));
    act(() => setAuthStatus('anon')); // the session dies while the request is in flight
    act(() => setAuthStatus('authed')); // …and a NEW session signs in before it settles
    await act(async () => {
      held.release();
      await pending;
    });

    // A plain status==='authed' check would WRONGLY accept this (status is authed again);
    // the epoch bumped on the anon flip, so the stale result is dropped.
    expect(result.current.aiInsights).toBeNull();
    expect(result.current.aiInsightsError).toBe(false);
  });

  it('a stale generate settling after re-sign-in does NOT clear the NEW session spinner (epoch-guarded finally)', async () => {
    // The hold is keyed by path, so each request must reach the server before the next hold is set.
    const heldA = server.hold('/insights/ai');
    server.once('POST', '/insights/ai', { body: { summary: 'stale A' } });
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pendingA!: Promise<void>;
    act(() => { pendingA = result.current.generateAiInsights(null); }); // A in flight (epoch 0)
    await waitFor(() => expect(server.sent('POST', '/insights/ai')).toHaveLength(1));
    act(() => setAuthStatus('anon'));   // sign out → epoch bumps, loading reset
    act(() => setAuthStatus('authed')); // a NEW session signs in
    const heldB = server.hold('/insights/ai');
    act(() => { void result.current.generateAiInsights(null); }); // B in flight → loading true
    await waitFor(() => expect(server.sent('POST', '/insights/ai')).toHaveLength(2));
    expect(result.current.aiInsightsLoading).toBe(true);

    await act(async () => {
      heldA.release();
      await pendingA;
    });

    // A's finally must not touch B's spinner — B is still generating.
    expect(result.current.aiInsightsLoading).toBe(true);
    await act(async () => { heldB.release(); });
  });

  it('an AI generate that settles during a Face ID LOCK (same session) is KEPT, not dropped', async () => {
    const held = server.hold('/insights/ai');
    server.seed('/insights/ai', { summary: 'my insights' });
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.generateAiInsights(null);
    });
    await waitFor(() => expect(server.sent('POST', '/insights/ai')).toHaveLength(1));
    act(() => setAuthStatus('locked')); // backgrounded → Face ID seal, SAME session
    await act(async () => {
      held.release();
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
      <WithQueries>
        <AppProvider>
          <Probe grab={(c) => { ctx = c; }} />
          <Overlays />
        </AppProvider>
      </WithQueries>,
    );

    act(() => ctx.showToast('Balance: $9,999'));
    expect(screen.getByText('Balance: $9,999')).toBeTruthy();

    act(() => setAuthStatus('locked')); // Face ID resume seal
    // Hidden from the tree — nothing money-related can sit over the lock screen…
    expect(screen.queryByText('Balance: $9,999')).toBeNull();
    // …but the context-held toast value is NOT cleared on a lock (only on 'anon'), so it
    // reappears on unlock. (A sheet's LOCAL form state is a different matter — unmounting
    // loses it; preserving that across a lock is WHIT-266, not this card.)
    expect(ctx.toast).toBe('Balance: $9,999');

    act(() => setAuthStatus('authed'));
    expect(screen.getByText('Balance: $9,999')).toBeTruthy(); // reappears intact
  });

  it('anon unmounts the overlay layer AND the state is gone (both halves compose)', () => {
    let ctx!: ReturnType<typeof useAppContext>;
    render(
      <WithQueries>
        <AppProvider>
          <Probe grab={(c) => { ctx = c; }} />
          <Overlays />
        </AppProvider>
      </WithQueries>,
    );

    act(() => ctx.showToast('Balance: $9,999'));
    act(() => setAuthStatus('anon'));

    expect(screen.queryByText('Balance: $9,999')).toBeNull(); // hidden by the gate
    expect(ctx.toast).toBeNull(); // and hard-cleared by the anon subscription
  });
});

// ===== WHIT-268 (QA gaps) — adversarial complements to the WHIT-268 suite above.
// That suite locks the anon hard-clear (sheet/toast/AI), the late-settling generate,
// the toast-timer cancel, and the locked hide/reappear. This one covers what it left:
//  [A7]  refreshAiInsights (the FREE cache read, fired on every Insights focus) settling
//        after sign-out is dropped, even when a NEW session is already live (the epoch
//        semantic) — only the paid generate was covered;
//  [A8]  the real invalidated-biometrics sequence locked → anon clears the kept state,
//        and a duplicate anon broadcast is harmless (safe to run twice);
//  [A9]  cold-start 'loading' hides the overlay layer (nothing can float before the
//        first auth resolve) without clearing its state;
//  [A10] an async rule save settling after sign-out does NOT re-seed the cleared
//        ['rules'] query cache (patchRules' undefined-guard is the fail-on-revert seam).
describe('WHIT-268 gaps — refresh/epoch/loading/reconcile', () => {

  function Probe({ grab }: { grab: (ctx: ReturnType<typeof useAppContext>) => void }) {
    grab(useAppContext());
    return <Text testID="probe">probe</Text>;
  }

  beforeEach(() => {
    resetAuth();
    queryClient.clear();
  });

  // WHIT-268 — [A7] the FREE insights cache read (fired on every Insights tab focus)
  // settling after sign-out must be dropped, exactly like the paid generate.
  it('a refreshAiInsights that settles AFTER sign-out cannot re-seat the old account insights', async () => {
    // Phase 1 (control): while authed, a refresh genuinely seats data — so the null
    // assertion below can't pass vacuously.
    server.once('GET', '/insights/ai', { body: { summary: 'live session' } });
    const { result } = renderHook(() => useAppContext(), { wrapper });
    await act(async () => { await result.current.refreshAiInsights(); });
    expect(result.current.aiInsights).not.toBeNull();

    // Phase 2: a refresh in flight when the session ends.
    const held = server.hold('/insights/ai');
    server.seed('/insights/ai', { summary: 'old account insights' });
    let pending!: Promise<void>;
    act(() => { pending = result.current.refreshAiInsights(); });
    await waitFor(() => expect(server.sent('GET', '/insights/ai')).toHaveLength(2));
    act(() => setAuthStatus('anon')); // sign-out mid-flight (anon subscription clears state)
    act(() => setAuthStatus('authed')); // …and a NEW session signs in before it settles
    await act(async () => {
      held.release();
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

    act(() => setAuthStatus('locked')); // Face ID resume seal — state must SURVIVE
    expect(result.current.toast).toBe('Balance: $9,999');
    expect(result.current.sheet).not.toBeNull();

    act(() => setAuthStatus('anon')); // unlock() found the key invalidated → clearSession
    expect(result.current.toast).toBeNull();
    expect(result.current.sheet).toBeNull();

    act(() => setAuthStatus(getAuthStatus())); // a second broadcast while already anon
    expect(result.current.toast).toBeNull(); // still clear, nothing thrown
    expect(result.current.sheet).toBeNull();
  });

  // WHIT-268 — [A9] cold start: while status is 'loading' (before the first auth resolve)
  // the overlay layer is hidden — but NOT cleared (loading is not a sign-out).
  it("during the cold-start 'loading' status the overlay layer is hidden, and its state survives to authed", () => {
    setAuthStatusQuietly('loading');
    let ctx!: ReturnType<typeof useAppContext>;
    render(
      <WithQueries>
        <AppProvider>
          <Probe grab={(c) => { ctx = c; }} />
          <Overlays />
        </AppProvider>
      </WithQueries>,
    );

    act(() => ctx.showToast('Balance: $1,234'));
    expect(screen.queryByText('Balance: $1,234')).toBeNull(); // hidden pre-auth
    expect(ctx.toast).toBe('Balance: $1,234'); // not cleared — loading isn't anon

    act(() => setAuthStatus('authed'));
    expect(screen.getByText('Balance: $1,234')).toBeTruthy(); // renders once authed
  });

  // WHIT-268 — [A10] an async writer settling after sign-out must not re-seed the cleared
  // query cache: the rule create's reconcile (patchRules) no-ops on an empty cache.
  it("a rule save that settles AFTER sign-out does not re-seed the cleared ['rules'] cache", async () => {
    queryClient.setQueryData(['rules'], []); // a warm rules cache, as if the screen was open
    const held = server.hold('/rules');
    server.once('POST', '/rules', { body: { id: 'srv-1', value: 'NETFLIX', categoryId: 'c1', field: 'description', operator: 'contains' } });
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.saveManualRule('NETFLIX', 'c1'); });
    // The optimistic write landed while authed (that part is fine and invisible post-clear).
    expect(queryClient.getQueryData(['rules'])).toHaveLength(1);
    await waitFor(() => expect(server.sent('POST', '/rules')).toHaveLength(1));

    // Sign-out, in production order: clearSession() clears the cache BEFORE broadcasting anon.
    act(() => { queryClient.clear(); setAuthStatus('anon'); });
    await act(async () => {
      held.release();
      await pending;
    });

    // The reconcile must NOT have re-created the ['rules'] entry in the wiped cache —
    // a seeded entry would be served (fresh for 45s) to the NEXT session.
    expect(queryClient.getQueryData(['rules'])).toBeUndefined();
  });
});

// ===== WHIT-277 — a half-typed pop-up sheet must survive a Face ID lock. The sheet UNMOUNTS while
// locked (Overlays' WHIT-268 privacy shield returns null), so its local useState is destroyed;
// the draft is stashed in the always-mounted AppProvider and restored on the unlock remount.
// These pin: draft survives authed→locked→authed; nothing sheet-related renders while locked
// (WHIT-268 intact); draft cleared on sign-out AND on close (no stale restore / cross-user leak).
describe('WHIT-277 — pop-up sheet drafts survive a Face ID lock', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
  function renderOverlays() {
    return renderWithQueries(
      <AppProvider>
        <ScreensUnderneath />
        <Probe />
        <Overlays />
      </AppProvider>,
    );
  }

  const RULE_INPUT = 'e.g. NETFLIX';

  beforeEach(() => {
    resetAuth();
    server.seed('/goals', [{ id: 'g1', name: 'Emergency fund', icon: 'star', direction: 'save', target_amount: 1000, target_date: null, baseline: null, manual_balance: null }]);
    queryClient.clear();
  });

  it('restores a half-typed AddRule draft across authed→locked→authed', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');

    // Lock: the whole overlay layer unmounts (WHIT-268 privacy shield) — the input is gone.
    act(() => setAuthStatus('locked'));
    expect(screen.queryByPlaceholderText(RULE_INPUT)).toBeNull();
    expect(screen.queryByText('New rule')).toBeNull();

    // Unlock: the sheet remounts and restores the stashed text.
    act(() => setAuthStatus('authed'));
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');
  });

  it('restores a half-typed GoalBalance draft across authed→locked→authed', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'goalbalance', goalId: 'g1' }));
    fireEvent.changeText(screen.getByTestId('goal-balance-input'), '2500');
    expect(screen.getByTestId('goal-balance-input').props.value).toBe('2500');

    act(() => setAuthStatus('locked'));
    expect(screen.queryByTestId('goal-balance-input')).toBeNull();

    act(() => setAuthStatus('authed'));
    expect(screen.getByTestId('goal-balance-input').props.value).toBe('2500');
  });

  it('clears the draft on sign-out — the next session opens the sheet empty (no cross-user leak)', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');

    act(() => setAuthStatus('anon')); // sign-out: hard-clears drafts + the sheet descriptor
    act(() => setAuthStatus('authed'));
    act(() => ctx.setSheet({ mode: 'addrule' }));
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('');
  });

  it('clears the draft on close — reopening the same sheet starts empty (no stale restore)', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');

    act(() => ctx.setSheet(null)); // cancel/submit both route through null → clear-on-close
    act(() => ctx.setSheet({ mode: 'addrule' }));
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('');
  });
});

// ===== WHIT-277 — adversarial GAPS for pop-up sheet drafts surviving a Face ID lock.
// The implementer (WHIT-277 describe above) pins the `pattern` half of AddRule and the
// `balance` half of GoalBalance across a lock, plus clear-on-close / clear-on-sign-out. This block
// adds the halves + key-isolation + WHIT-268 guards it did NOT cover:
//   [A5] the categoryId (pill selection) half of an AddRule draft survives a lock (they assert pattern only)
//   [A6] the asOf date half of a GoalBalance draft survives a lock (they assert balance only)
//   [A7] EDITING an existing rule (ruleId set): the typed change survives a lock AND still differs
//        from the original prefill (draft, not the prefill fallback, wins on remount)
//   [A8] distinct draft keys — a NEW-rule draft does not leak into an EDIT sheet, and vice-versa
//   [A9] WHIT-268 fail-on-revert for the GOAL sheet: while status==='locked', the typed money figure
//        is not readable by ANY query even though a draft is stashed
describe('WHIT-277 gaps — draft halves, key isolation, and the WHIT-268 lock guard', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
  function renderOverlays() {
    return renderWithQueries(
      <AppProvider>
        <ScreensUnderneath />
        <Probe />
        <Overlays />
      </AppProvider>,
    );
  }

  const RULE_INPUT = 'e.g. NETFLIX';
  const CATS = [
    { ...GROCERIES },
    { ...SUBSCRIPTIONS },
  ];

  // A category pill's label goes white (#fff) when selected, C.textMid otherwise
  // (Overlays.tsx ruleCatText style). Flatten the style array and read the effective color.
  function pillColor(name: string): string | undefined {
    return styleOf(screen.getByText(name)).color as string | undefined;
  }

  beforeEach(() => {
    resetAuth();
    server.seed('/categories', CATS);
    server.seed('/rules', [{ id: 'e1', value: 'NETFLIX', categoryId: 'subs' }]);
    server.seed('/goals', [{ id: 'g1', name: 'Emergency fund', icon: 'star', direction: 'save', target_amount: 1000, target_date: null, baseline: null, manual_balance: null }]);
    queryClient.clear();
  });

  it('[A5] restores the categoryId (pill) half of an AddRule draft across a lock, not just the pattern', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
    fireEvent.press(screen.getByText('Groceries')); // select the pill
    expect(pillColor('Groceries')).toBe('#fff');
    expect(pillColor('Subscriptions')).not.toBe('#fff');

    act(() => setAuthStatus('locked'));
    expect(screen.queryByText('Groceries')).toBeNull(); // whole sheet unmounted

    act(() => setAuthStatus('authed'));
    // Both halves come back: the typed pattern AND the chosen category pill.
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');
    expect(pillColor('Groceries')).toBe('#fff');
    expect(pillColor('Subscriptions')).not.toBe('#fff');
  });

  it('[A6] restores the asOf DATE half of a GoalBalance draft across a lock, not just the balance', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'goalbalance', goalId: 'g1' }));
    // Move the as-of off today via the (globally-mocked) date picker → fixed 20 Jun 2026.
    const androidOpen = screen.queryByTestId('goal-asof-open');
    if (androidOpen) fireEvent.press(androidOpen);
    fireEvent.press(screen.getByTestId('mock-datepicker'));
    const pickedLabel = formatDayMonthYear('2026-06-20');
    const todayLabel = formatDayMonthYear(toISODate(new Date()));
    expect(pickedLabel).not.toBe(todayLabel); // guard: the test only means something if they differ
    expect(screen.getByText(pickedLabel)).toBeTruthy();

    act(() => setAuthStatus('locked'));
    expect(screen.queryByText(pickedLabel)).toBeNull();

    act(() => setAuthStatus('authed'));
    // The picked date survives — it did NOT snap back to today's default.
    expect(screen.getByText(pickedLabel)).toBeTruthy();
    expect(screen.queryByText(todayLabel)).toBeNull();
  });

  it('[A7] an EDIT-rule draft survives a lock AND still differs from the original prefill', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule', ruleId: 'e1' }));
    expect(screen.getByDisplayValue('NETFLIX')).toBeTruthy(); // prefilled from the rule
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'NETFLIXX');

    act(() => setAuthStatus('locked'));
    act(() => setAuthStatus('authed'));

    // The EDITED text is restored — not the original 'NETFLIX' prefill fallback.
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('NETFLIXX');
    expect(screen.queryByDisplayValue('NETFLIX')).toBeNull();
  });

  it('[A8] a NEW-rule draft does not leak into an EDIT sheet (distinct draft keys, no null between)', async () => {
    await renderOverlays();
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

  it('[A9] WHIT-268: while locked WITH a draft stashed, the typed money figure is not readable by any query', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'goalbalance', goalId: 'g1' }));
    fireEvent.changeText(screen.getByTestId('goal-balance-input'), '9999');
    expect(screen.getByDisplayValue('9999')).toBeTruthy();

    act(() => setAuthStatus('locked'));
    // The privacy shield must hide the whole sheet even though the draft (9999) is stashed in the
    // provider — nothing money-related may sit over the Face ID lock.
    expect(screen.queryByTestId('goal-balance-input')).toBeNull();
    expect(screen.queryByDisplayValue('9999')).toBeNull();
    expect(screen.queryByText('Emergency fund — set the current balance and the date it was true.')).toBeNull();

    // …and it all comes back intact on unlock (proves it was HIDDEN, not cleared).
    act(() => setAuthStatus('authed'));
    expect(screen.getByDisplayValue('9999')).toBeTruthy();
  });
});

// ===== WHIT-283 — the picker's inline new-category form must survive a Face ID lock, like WHIT-277 did
// for the add-rule / goal-balance sheets. The whole overlay layer unmounts while locked (Overlays'
// WHIT-268 shield), destroying PickerSheet's `creating` flag + QuickCreateCategory's fields; both
// are stashed in the WHIT-277 draft store and restored on unlock. These pin: the form reopens with
// its fields intact (not the category list); nothing renders while locked; cleared on close /
// sign-out / cancel.
describe('WHIT-283 — picker inline-create draft survives a Face ID lock', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
  function renderOverlays() {
    return renderWithQueries(<AppProvider><ScreensUnderneath /><Probe /><Overlays /></AppProvider>);
  }

  const NAME_INPUT = 'Category name';

  beforeEach(() => {
    resetAuth();
    seedTransactions(T1);
    queryClient.clear();
  });

  function openCreateForm() {
    act(() => ctx.openPicker('t1'));
    fireEvent.press(screen.getByTestId('pickerNewCategory')); // list → inline create form
  }

  it('restores the half-typed name and reopens INTO the create form (not the list) across a lock', async () => {
    await renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');

    // Lock: the whole overlay layer unmounts (WHIT-268 shield) — the form is gone.
    act(() => setAuthStatus('locked'));
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull();

    // Unlock: the picker reopens straight into the create form with the name restored.
    act(() => setAuthStatus('authed'));
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');
    expect(screen.getByText('New category')).toBeTruthy();       // the form title
    expect(screen.queryByTestId('pickerNewCategory')).toBeNull(); // NOT back on the list
  });

  it('persists all fields (name + bucket + icon) to the draft store', async () => {
    await renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    fireEvent.press(screen.getByText('Living'));    // pick a non-default bucket
    fireEvent.press(screen.getByTestId('icon-cart')); // pick a non-default icon

    // The persist effect writes the whole draft (raw name) under the txId-scoped key.
    expect(ctx.readSheetDraft('pickercat:t1')).toEqual({ name: 'Gym', bucket: 'Living', icon: 'cart', parent: null });
  });

  it('renders nothing category-related while locked, even with a draft stashed (WHIT-268 intact)', async () => {
    await renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'SecretCat');

    act(() => setAuthStatus('locked'));
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull();
    expect(screen.queryByDisplayValue('SecretCat')).toBeNull();
    expect(screen.queryByText('New category')).toBeNull();
  });

  it('clears the draft on sheet close — reopening the picker starts on the list with an empty form', async () => {
    await renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');

    act(() => ctx.setSheet(null));       // close the whole sheet (clears all drafts)
    act(() => ctx.openPicker('t1'));     // reopen
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull(); // back on the list, form not open
    expect(screen.getByTestId('pickerNewCategory')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe(''); // fresh empty form
  });

  it('clears the draft on sign-out (no cross-user leak)', async () => {
    await renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');

    act(() => setAuthStatus('anon'));  // sign-out hard-clears drafts + the sheet
    act(() => setAuthStatus('authed'));
    openCreateForm();
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('');
  });

  it('Cancel discards the draft — reopening the create form starts empty', async () => {
    await renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');

    fireEvent.press(screen.getByText('Cancel')); // back to the list, draft discarded
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('');
  });
});

// ===== WHIT-283 GAP — the bucket + icon + parent halves must RESTORE AND RENDER AS SELECTED after a
// Face ID lock, not merely be written to the draft store. The implementer's suite (WHIT-283 describe
// above) asserts the store CONTENTS (readSheetDraft) BEFORE the lock; it never proves the reopened form
// re-selects the chosen bucket/icon/parent, nor that the persist effect (which re-fires on the restored
// mount) doesn't clobber a good draft back to defaults via the lazy-init-before-effect ordering.
describe('WHIT-283 GAP — the restored form RE-SELECTS bucket / icon / parent after unlock', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
  function renderOverlays() {
    return renderWithQueries(<AppProvider><ScreensUnderneath /><Probe /><Overlays /></AppProvider>);
  }

  const NAME_INPUT = 'Category name';

  beforeEach(() => {
    resetAuth();
    seedTransactions(T1);
    // One same-bucket (Lifestyle == the form's initialBucket) category, so the inline form's parent
    // picker offers it — required for the parent round-trip.
    server.seed('/categories', [{ id: 'coffee', name: 'Coffee', icon: 'coffee', bucket: 'Lifestyle', parent: null }]);
    queryClient.clear();
  });

  function openCreateForm() {
    act(() => ctx.openPicker('t1'));
    fireEvent.press(screen.getByTestId('pickerNewCategory')); // list -> inline create form
  }

  // [G1] Round-trip RENDER of bucket + icon (the implementer only checks the store write pre-lock).
  it('[G1] bucket + icon selection survive the lock and RENDER as selected on unlock (not just the store)', async () => {
    await renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    fireEvent.press(screen.getByText('Living'));       // a non-default bucket (default is Lifestyle)
    fireEvent.press(screen.getByTestId('icon-cart'));  // a non-default icon (default is coffee)

    act(() => setAuthStatus('locked'));  // overlay layer unmounts (WHIT-268 shield)
    act(() => setAuthStatus('authed'));  // restored mount

    // The reopened form must SHOW the choices selected: the bucket label paints in its bucket colour
    // and the icon tile borders in the accent ONLY when selected.
    expect(styleOf(screen.getByText('Living')).color).toBe(BUCKET_COLOR.Living);
    expect(styleOf(screen.getByTestId('icon-cart')).borderColor).toBe(C.accent);
    // A sibling control must NOT read as selected — guards a "everything looks selected" false pass.
    expect(styleOf(screen.getByText('Income')).color).not.toBe(BUCKET_COLOR.Income);
    expect(styleOf(screen.getByTestId('icon-coffee')).borderColor).toBe('rgba(255,255,255,.07)');

    // Clobber guard: the persist effect re-fires on the restored mount. Because the field state
    // lazy-inits FROM the draft before that effect writes committed state, the stored draft must be
    // unchanged — not reset to the {bucket:'Lifestyle', icon:'coffee'} defaults.
    expect(ctx.readSheetDraft('pickercat:t1')).toEqual({ name: 'Gym', bucket: 'Living', icon: 'cart', parent: null });
  });

  // [G2] Round-trip RENDER of a picked parent (implementer only ever persists parent:null across a
  // lock; pickerSheetParentPick pick->submit never locks).
  it('[G2] a picked parent survives the lock and RENDERS as the selected parent on unlock', async () => {
    await renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Beans');
    fireEvent.press(screen.getByText('Coffee'));       // the same-bucket parent (initialBucket Lifestyle)
    expect(ctx.readSheetDraft('pickercat:t1')).toMatchObject({ parent: 'coffee' });

    act(() => setAuthStatus('locked'));
    act(() => setAuthStatus('authed'));

    // Reopened: the 'Coffee' parent chip reads selected (painted in the category's colour) and the
    // 'None' chip does not.
    expect(styleOf(screen.getByText('Coffee')).color).toBe('#ff9e64'); // the app's colour for id 'coffee'
    expect(styleOf(screen.getByText('None')).color).not.toBe(C.accentSofter);
    expect(ctx.readSheetDraft('pickercat:t1')).toMatchObject({ name: 'Beans', parent: 'coffee' });
  });
});

// ===== WHIT-437 — [A30]-[A34] the categorise sheet's quick-create, END TO END.
//
// This is the cheapest real proof in the card: src/components/Overlays.tsx `createAndFile`
// inherits the whole fix with ZERO code change of its own, because it calls
// createCategoryInline WITHOUT `{ silent: true }`. That means every assumption is untested by
// construction — nothing in Overlays.tsx would go red if the inheritance broke. The existing
// coverage stops at the provider (appProvider.screen.test.tsx), so nothing yet proves the
// reason travels api → context → the toast a user actually sees on this screen.
//
// Real components all the way down (real AppProvider, real Overlays, real
// QuickCreateCategory, real query hooks and request code on the fake server); only ../auth is
// mocked. The assertion is the rendered
// toast TEXT, not a spy.
describe('WHIT-437 — categorise sheet quick-create reason', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
  function renderOverlays() { return renderWithQueries(<AppProvider><ScreensUnderneath /><Probe /><Overlays /></AppProvider>); }

  const NAME_INPUT = 'Category name';
  const CAP = 'a category can have at most 50 sub-categories';

  beforeEach(() => {
    resetAuth();
    seedTransactions(T1);
    queryClient.clear();
  });

  /** Open the picker for t1, switch to the inline create form, and type a name. */
  async function fillCreateForm(name = 'Gym') {
    await renderOverlays();
    act(() => ctx.openPicker('t1'));
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), name);
  }
  const submit = async () => { await act(async () => { fireEvent.press(screen.getByText('Create & file')); }); };

  describe('the sheet shows the server reason instead of "Please try again"', () => {
    // [A30] the card's headline promise, on the path that got no code change.
    it('renders the refusal reason in the toast', async () => {
      server.once('POST', '/categories', { status: 400, reason: CAP });
      await fillCreateForm();
      await submit();

      expect(await screen.findByText('A category can have at most 50 sub-categories.')).toBeTruthy();
      expect(screen.queryByText('Could not save category. Please try again.')).toBeNull();
    });

    // [A31] the most reachable real refusal by hand — a name that already exists.
    it('renders a 409 duplicate refusal', async () => {
      server.once('POST', '/categories', { status: 409, reason: 'category already exists' });
      await fillCreateForm('Groceries');
      await submit();

      expect(await screen.findByText('Category already exists.')).toBeTruthy();
    });

    // [A32] a refusal must NOT file the transaction, and must leave the form usable for a retry —
    // createAndFile only calls setSubmitting(false) on the null branch, so a stuck busy flag here
    // would trap the user on a dead form with no error recovery.
    it('does not file the transaction and re-enables the form for a retry', async () => {
      server.once('POST', '/categories', { status: 400, reason: CAP });
      server.once('POST', '/categories', { status: 400, reason: CAP });
      await fillCreateForm();
      await submit();
      await screen.findByText('A category can have at most 50 sub-categories.');

      // Neither the single-charge nor the batch filing request was sent.
      expect(server.sentUnder('PATCH', '/transactions')).toEqual([]);
      expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');  // still on the form

      // The button works again: a second press reaches the API a second time.
      await submit();
      await waitFor(() => expect(server.sent('POST', '/categories')).toHaveLength(2));
    });
  });

  describe('the generic copy still covers what is not ours to quote', () => {
    // [A33] a 5xx is our fault; "try again" is honest there and must survive.
    it('renders the generic copy for a 500 that did explain itself', async () => {
      server.once('POST', '/categories', { status: 500, reason: 'DynamoDB ProvisionedThroughputExceeded' });
      await fillCreateForm();
      await submit();

      expect(await screen.findByText('Could not save category. Please try again.')).toBeTruthy();
      expect(screen.queryByText(/DynamoDB/)).toBeNull();
    });

    // [A34] offline: a lost connection carries nothing, so nothing may be invented.
    it('renders the generic copy for a network failure', async () => {
      server.once('POST', '/categories', 'dropped');
      await fillCreateForm();
      await submit();

      expect(await screen.findByText('Could not save category. Please try again.')).toBeTruthy();
    });
  });
});

// ===== WHIT-538 — the add-rule preview confirm step: "Back" must return to the form with the typed
// pattern + picked category STILL filled. The mocked-context screen tests ([A30]) prove "Back" calls
// setSheet({mode:'addrule'}); this proves the REAL round trip — real setSheet, real useSheetDraft,
// real clear-on-close (context.tsx: drafts clear ONLY when sheet===null). A regression that cleared
// the draft on any setSheet call would make "Back" silently drop the half-typed rule, and this reddens.
describe('WHIT-538 — Back from the add-rule preview restores the form draft', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
  function renderOverlays() {
    return renderWithQueries(
      <AppProvider>
        <ScreensUnderneath />
        <Probe />
        <Overlays />
      </AppProvider>,
    );
  }

  const RULE_INPUT = 'e.g. NETFLIX';
  const CATS = [
    { ...GROCERIES },
    { ...SUBSCRIPTIONS },
  ];
  const previewReport = {
    dryRun: true, rulesConsidered: 1, unfiled: 5, matched: 5, conflicted: 0, conflictedSamples: [],
    byCategory: { groceries: 5 },
    byRule: [{ ruleId: null, value: 'SPOTIFY', categoryId: 'groceries', count: 5, samples: ['SPOTIFY AB'] }],
    skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 5, createdRule: null,
  };

  beforeEach(() => {
    resetAuth();
    server.seed('/categories', CATS);
    server.seed('/rules', []);
    queryClient.clear();
    server.seed('/transactions/uncategorized/apply-rules', previewReport);
  });

  it('restores the typed pattern after transitioning to the confirm step and pressing Back', async () => {
    await renderOverlays();
    act(() => ctx.setSheet({ mode: 'addrule' }));
    fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
    fireEvent.press(screen.getByText('Subscriptions')); // pick a category so Add rule is enabled

    // Submit → the REAL write() transitions to the confirm step (not saveManualRule).
    await act(async () => { fireEvent.press(screen.getByText('Add rule')); });
    expect(ctx.sheet).toEqual({ mode: 'addRuleConfirm', pattern: 'SPOTIFY', categoryId: 'subs', budgetExcluded: false });
    // The preview resolved and the confirm card (with its Back button) is on screen.
    expect(screen.getByTestId('add-rule-confirm-back')).toBeTruthy();
    expect(screen.queryByPlaceholderText(RULE_INPUT)).toBeNull(); // form is gone, confirm is up

    // Back → the form remounts and the draft (never cleared, since the sheet never went null) restores.
    await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-back')); });
    expect(ctx.sheet).toEqual({ mode: 'addrule' });
    expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');
  });
});
