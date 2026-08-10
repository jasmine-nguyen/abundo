// WHIT-459 real-data overlay fold — every <Overlays/> screen test that mounts the REAL
// <AppProvider> (the real-provider regime: only ../auth, ../api and ../queries are mocked) lives
// here, one child describe per concern. Folded in (scenarios preserved 1:1, 32 its):
//   - WHIT-268  anon hard-clear + locked hide/keep    (was overlaysAuthClear)
//   - WHIT-268  gaps: refresh/epoch/loading/reconcile (was overlaysAuthClearGaps)
//   - WHIT-277  pop-up sheet drafts survive a lock     (was overlaysSheetDraft)
//   - WHIT-277  gaps: draft halves / key isolation     (was overlaysSheetDraftGaps)
//   - WHIT-283  picker inline-create draft survives    (was overlaysPickerCreateDraft)
//   - WHIT-283  gap: restored form RE-SELECTS          (was overlaysPickerCreateDraftRender)
//   - WHIT-437  categorise sheet quick-create reason   (was categorizeSheetCreateReason)
//
// Six of the seven sources already shared this inline live-auth-store harness verbatim, so it hoists
// once at module scope; the seventh (WHIT-277 sheet-draft) used the shared support/authMock helper —
// converted here to the same inline store (setAuthStatus→mockSetStatus, resetAuth→inline reset), which
// is byte-equivalent (authMock.ts's setAuthStatus/resetAuth/useIsAuthedMock match the inline versions).
// Each describe keeps its own consts / helpers / Probe / renderOverlays / beforeEach block-scoped; only
// the mocked modules (../auth, ../api, ../queries), the shared `mockState`, and the auth store are
// module-level (jest.mock can't be per-describe). The two WHIT-268 describes hardcoded an empty query
// fixture; under the shared `mockState` their beforeEach now explicitly `mockState = {}` so a fixture
// from a sibling describe can't leak in (order-independence).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, renderHook, act, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { formatDayMonthYear, toISODate } from '../dateutil';
import { BUCKET_COLOR } from '../categoryColors';
import { C } from '../theme';

// Live miniature auth store; the jest.mock factories close over the mock-prefixed vars. A test drives
// login status via mockSetStatus (broadcasts on change) or mockRebroadcast (re-notify, no change).
let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => { mockStatus = s; mockListeners.forEach((l) => l()); };
const mockRebroadcast = () => mockListeners.forEach((l) => l());
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({ getStatus: () => mockStatus, subscribe: (l: () => void) => mockSubscribe(l) }));
// Auto-mocked. clearMocks (jest.config) clears call-counts each test but NOT implementations, so a
// mockRejectedValue/mockImplementation persists across describes in this single file. That is inert
// only because context.tsx's mount effects call NO api method — every generate/refresh/create/file is
// a user-triggered callback — so no describe inherits a live pending/rejecting impl at mount. Keep it
// that way: a new mount-time api call would need a reset here.
jest.mock('../api');

let mockState: { transactions?: unknown[]; categories?: unknown[]; rules?: unknown[]; goals?: unknown[] } = {};
jest.mock('../queries', () => ({
  ...require('./support/screenQueryMocks').queryMocksFromState(() => mockState),
  useIsAuthed: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSubscribe, () => mockStatus === 'authed');
  },
  // GoalBalanceSheet reads the live goal via useGoalsQuery (not in the shared support mock). Additive —
  // inert for the describes that never open a goalbalance sheet (mockState.goals is undefined → []).
  useGoalsQuery: () => ({ data: mockState.goals ?? [] }),
}));

import { AppProvider, useAppContext } from '../context';
import { Overlays } from '../components/Overlays';
import { queryClient } from '../queryClient';
import { ApiError } from '../apiError';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

afterEach(() => { queryClient.clear(); jest.useRealTimers(); });

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
  const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

  beforeEach(() => {
    mockStatus = 'authed';
    mockListeners.clear();
    mockState = {}; // this describe hardcoded an empty query fixture — pin it so a sibling can't leak in
    queryClient.clear();
  });

  // --- sign-out hard-clears the overlay + AI state ---------------------------------

  it('flipping to anon clears sheet, toast and the AI insights state (fail-on-revert for the anon subscription)', async () => {
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
  const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

  function Probe({ grab }: { grab: (ctx: ReturnType<typeof useAppContext>) => void }) {
    grab(useAppContext());
    return <Text testID="probe">probe</Text>;
  }

  beforeEach(() => {
    mockStatus = 'authed';
    mockListeners.clear();
    mockState = {}; // this describe hardcoded an empty query fixture — pin it so a sibling can't leak in
    queryClient.clear();
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
    return render(
      <AppProvider>
        <Probe />
        <Overlays />
      </AppProvider>,
    );
  }

  const RULE_INPUT = 'e.g. NETFLIX';

  beforeEach(() => {
    mockStatus = 'authed';
    mockListeners.clear();
    mockState = { goals: [{ id: 'g1', name: 'Emergency fund', icon: 'star', direction: 'save', target_amount: 1000, target_date: null, baseline: null, manual_balance: null }] };
    queryClient.clear();
  });

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

  // A category pill's label goes white (#fff) when selected, C.textMid otherwise
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
    return render(<AppProvider><Probe /><Overlays /></AppProvider>);
  }

  const NAME_INPUT = 'Category name';

  beforeEach(() => {
    mockStatus = 'authed';
    mockListeners.clear();
    mockState = { transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE', merchant_name: 'Cafe' }], categories: [] };
    queryClient.clear();
  });

  function openCreateForm() {
    act(() => ctx.openPicker('t1'));
    fireEvent.press(screen.getByTestId('pickerNewCategory')); // list → inline create form
  }

  it('restores the half-typed name and reopens INTO the create form (not the list) across a lock', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');

    // Lock: the whole overlay layer unmounts (WHIT-268 shield) — the form is gone.
    act(() => mockSetStatus('locked'));
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull();

    // Unlock: the picker reopens straight into the create form with the name restored.
    act(() => mockSetStatus('authed'));
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');
    expect(screen.getByText('New category')).toBeTruthy();       // the form title
    expect(screen.queryByTestId('pickerNewCategory')).toBeNull(); // NOT back on the list
  });

  it('persists all fields (name + bucket + icon) to the draft store', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    fireEvent.press(screen.getByText('Living'));    // pick a non-default bucket
    fireEvent.press(screen.getByTestId('icon-cart')); // pick a non-default icon

    // The persist effect writes the whole draft (raw name) under the txId-scoped key.
    expect(ctx.readSheetDraft('pickercat:t1')).toEqual({ name: 'Gym', bucket: 'Living', icon: 'cart', parent: null });
  });

  it('renders nothing category-related while locked, even with a draft stashed (WHIT-268 intact)', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'SecretCat');

    act(() => mockSetStatus('locked'));
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull();
    expect(screen.queryByDisplayValue('SecretCat')).toBeNull();
    expect(screen.queryByText('New category')).toBeNull();
  });

  it('clears the draft on sheet close — reopening the picker starts on the list with an empty form', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');

    act(() => ctx.setSheet(null));       // close the whole sheet (clears all drafts)
    act(() => ctx.openPicker('t1'));     // reopen
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull(); // back on the list, form not open
    expect(screen.getByTestId('pickerNewCategory')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe(''); // fresh empty form
  });

  it('clears the draft on sign-out (no cross-user leak)', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');

    act(() => mockSetStatus('anon'));  // sign-out hard-clears drafts + the sheet
    act(() => mockSetStatus('authed'));
    openCreateForm();
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('');
  });

  it('Cancel discards the draft — reopening the create form starts empty', () => {
    renderOverlays();
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
    return render(<AppProvider><Probe /><Overlays /></AppProvider>);
  }

  const NAME_INPUT = 'Category name';

  // Flatten an RN style prop (object | array | nested arrays) to one object, so a selected/unselected
  // colour can be read regardless of how the component composes its styles.
  function flat(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return style.reduce((acc: Record<string, unknown>, s) => Object.assign(acc, flat(s)), {});
    return (style ?? {}) as Record<string, unknown>;
  }

  beforeEach(() => {
    mockStatus = 'authed';
    mockListeners.clear();
    mockState = {
      transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE', merchant_name: 'Cafe' }],
      // One same-bucket (Lifestyle == the form's initialBucket) category, so the inline form's parent
      // picker offers it — required for the parent round-trip.
      categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0, parent: null }],
    };
    queryClient.clear();
  });

  function openCreateForm() {
    act(() => ctx.openPicker('t1'));
    fireEvent.press(screen.getByTestId('pickerNewCategory')); // list -> inline create form
  }

  // [G1] Round-trip RENDER of bucket + icon (the implementer only checks the store write pre-lock).
  it('[G1] bucket + icon selection survive the lock and RENDER as selected on unlock (not just the store)', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    fireEvent.press(screen.getByText('Living'));       // a non-default bucket (default is Lifestyle)
    fireEvent.press(screen.getByTestId('icon-cart'));  // a non-default icon (default is coffee)

    act(() => mockSetStatus('locked'));  // overlay layer unmounts (WHIT-268 shield)
    act(() => mockSetStatus('authed'));  // restored mount

    // The reopened form must SHOW the choices selected: the bucket label paints in its bucket colour
    // and the icon tile borders in the accent ONLY when selected.
    expect(flat(screen.getByText('Living').props.style).color).toBe(BUCKET_COLOR.Living);
    expect(flat(screen.getByTestId('icon-cart').props.style).borderColor).toBe(C.accent);
    // A sibling control must NOT read as selected — guards a "everything looks selected" false pass.
    expect(flat(screen.getByText('Income').props.style).color).not.toBe(BUCKET_COLOR.Income);
    expect(flat(screen.getByTestId('icon-coffee').props.style).borderColor).toBe('rgba(255,255,255,.07)');

    // Clobber guard: the persist effect re-fires on the restored mount. Because the field state
    // lazy-inits FROM the draft before that effect writes committed state, the stored draft must be
    // unchanged — not reset to the {bucket:'Lifestyle', icon:'coffee'} defaults.
    expect(ctx.readSheetDraft('pickercat:t1')).toEqual({ name: 'Gym', bucket: 'Living', icon: 'cart', parent: null });
  });

  // [G2] Round-trip RENDER of a picked parent (implementer only ever persists parent:null across a
  // lock; pickerSheetParentPick pick->submit never locks).
  it('[G2] a picked parent survives the lock and RENDERS as the selected parent on unlock', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Beans');
    fireEvent.press(screen.getByText('Coffee'));       // the same-bucket parent (initialBucket Lifestyle)
    expect(ctx.readSheetDraft('pickercat:t1')).toMatchObject({ parent: 'coffee' });

    act(() => mockSetStatus('locked'));
    act(() => mockSetStatus('authed'));

    // Reopened: the 'Coffee' parent chip reads selected (painted in the category's colour) and the
    // 'None' chip does not.
    expect(flat(screen.getByText('Coffee').props.style).color).toBe('#e8a87c');
    expect(flat(screen.getByText('None').props.style).color).not.toBe(C.accentSofter);
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
// QuickCreateCategory); only ../api and ../auth are mocked. The assertion is the rendered
// toast TEXT, not a spy.
describe('WHIT-437 — categorise sheet quick-create reason', () => {
  let ctx!: ReturnType<typeof useAppContext>;
  function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
  function renderOverlays() { return render(<AppProvider><Probe /><Overlays /></AppProvider>); }

  const NAME_INPUT = 'Category name';
  const CAP = 'a category can have at most 50 sub-categories';

  beforeEach(() => {
    mockStatus = 'authed';
    mockListeners.clear();
    mockState = {
      transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE', merchant_name: 'Cafe' }],
      categories: [],
    };
    queryClient.clear();
  });

  /** Open the picker for t1, switch to the inline create form, and type a name. */
  function fillCreateForm(name = 'Gym') {
    renderOverlays();
    act(() => ctx.openPicker('t1'));
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), name);
  }
  const submit = async () => { await act(async () => { fireEvent.press(screen.getByText('Create & file')); }); };

  describe('the sheet shows the server reason instead of "Please try again"', () => {
    // [A30] the card's headline promise, on the path that got no code change.
    it('renders the refusal reason in the toast', async () => {
      mockApi.createCategory.mockRejectedValue(new ApiError(400, CAP) as never);
      fillCreateForm();
      await submit();

      expect(await screen.findByText('A category can have at most 50 sub-categories.')).toBeTruthy();
      expect(screen.queryByText('Could not save category. Please try again.')).toBeNull();
    });

    // [A31] the most reachable real refusal by hand — a name that already exists.
    it('renders a 409 duplicate refusal', async () => {
      mockApi.createCategory.mockRejectedValue(new ApiError(409, 'category already exists') as never);
      fillCreateForm('Groceries');
      await submit();

      expect(await screen.findByText('Category already exists.')).toBeTruthy();
    });

    // [A32] a refusal must NOT file the transaction, and must leave the form usable for a retry —
    // createAndFile only calls setSubmitting(false) on the null branch, so a stuck busy flag here
    // would trap the user on a dead form with no error recovery.
    it('does not file the transaction and re-enables the form for a retry', async () => {
      mockApi.createCategory.mockRejectedValue(new ApiError(400, CAP) as never);
      fillCreateForm();
      await submit();
      await screen.findByText('A category can have at most 50 sub-categories.');

      expect(mockApi.setTransactionFields).not.toHaveBeenCalled();
      expect(mockApi.setTransactionCategories).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');  // still on the form

      // The button works again: a second press reaches the API a second time.
      await submit();
      await waitFor(() => expect(mockApi.createCategory).toHaveBeenCalledTimes(2));
    });
  });

  describe('the generic copy still covers what is not ours to quote', () => {
    // [A33] a 5xx is our fault; "try again" is honest there and must survive.
    it('renders the generic copy for a 500 that did explain itself', async () => {
      mockApi.createCategory.mockRejectedValue(new ApiError(500, 'DynamoDB ProvisionedThroughputExceeded') as never);
      fillCreateForm();
      await submit();

      expect(await screen.findByText('Could not save category. Please try again.')).toBeTruthy();
      expect(screen.queryByText(/DynamoDB/)).toBeNull();
    });

    // [A34] offline: a plain Error carries nothing, so nothing may be invented.
    it('renders the generic copy for a network failure', async () => {
      mockApi.createCategory.mockRejectedValue(new TypeError('Network request failed') as never);
      fillCreateForm();
      await submit();

      expect(await screen.findByText('Could not save category. Please try again.')).toBeTruthy();
    });
  });
});
