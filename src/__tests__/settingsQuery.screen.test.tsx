// WHIT-459 settings server-rows fold — every Settings screen test that runs the REAL query layer
// (real <QueryClientProvider> + real useSettingsScreenData/useRulesScreenData/usePayCycle, with
// real ../api over the fake server; ../auth + ../context + expo-router hand-mocked) lives here, one
// child describe per source.
// Folded in (scenarios preserved 1:1, 23 its):
//   - WHIT-191a  server rows on the real query layer      (was settingsQuery — the survivor)
//   - WHIT-191a  gaps: hard-fail / cache-first / focus     (was settingsQueryGaps)
//   - WHIT-198   gaps: loan-only / ordering / fan-out      (was settingsSetupErrorGaps)
//
// The three sources diverged in all their mock factories; unified here to supersets that hoist once:
//   ../auth      — the LIVE store (settingsQuery's), driven by setAuthStatus, plus a shared mockSignOut so
//                  the WHIT-198 log-out-mid-outage test can assert; the two static-'authed' sources
//                  never flip, and each describe's beforeEach re-seeds 'authed' so the shared mutable
//                  store can't leak a status across describes.
//   fake server  — each describe seeds /categories, /loanfacts and /rules to its own fixtures;
//                  /paycycle answers the server default (14 days).
//   ../context   — one stub; the screen reads only setSheet off context (rules AND cycleName
//                  are read from the query hooks, so both stubbed fields are vestigial).
//   expo-router  — the shared fake; routerSpies.replace + mockSignOut so the WHIT-198 log-out-mid-outage test can assert.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { Text } from 'react-native';
import { render, screen, renderHook, act, waitFor, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct } from './support/renderWithQueries';

// Live miniature auth store (superset — only settingsQuery flips it; the gaps describes stay 'authed').
const mockSignOut = jest.fn();
jest.mock('../auth', () => ({
  ...require('./support/authMock').authMockModule(),
  getCurrentUser: () => null,
  signOut: () => mockSignOut(),
}));
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

// Real selectors (loanFactsReady) + composite deps; stub only the store-backed client-state rows.
// `rules` and `cycleName` here are vestigial — the screen reads them from the query hooks, not context.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ rules: [{ id: 'r1' }], cycleName: () => 'Fortnightly', setSheet: jest.fn() }),
  };
});

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

beforeEach(() => resetRouter());

import Settings from '../../app/settings';
import { useSettingsScreenData } from '../queries';

const server = installFakeServer();
const CATEGORIES = '/categories';
const LOAN_FACTS = '/loanfacts';
const RULES = '/rules';
const categoryReads = () => server.sent('GET', CATEGORIES).length;
const loanReads = () => server.sent('GET', LOAN_FACTS).length;

// ===== WHIT-191a — the Settings server-backed rows (categories count + loan-facts status)
// on the real query layer: not fetched before login, fires on auth flip, self-heals a
// transient 5xx, and shows "…" (never a misleading "0") while first-loading.
describe('WHIT-191a — Settings server rows on the real query layer', () => {
  const CATS = [
    { id: 'a', name: 'A', bucket: 'Living', icon: 'cart', color: '#7FD49B' },
    { id: 'b', name: 'B', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C' },
    { id: 'c', name: 'C', bucket: 'Living', icon: 'home', color: '#8AB4F8' },
  ];
  const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };
  const EMPTY_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

  function renderSettings(client = makeClient()) {
    return render(React.createElement(QueryClientProvider, { client }, React.createElement(Settings)));
  }

  beforeEach(() => {
    resetAuth();
    server.seed(CATEGORIES, CATS);
    server.seed(LOAN_FACTS, READY_FACTS);
    server.seed(RULES, []); // rules read — kept deterministic for the "…" count
  });

  it('shows the category count and "Edit" loan status from the query', async () => {
    renderSettings();
    expect(await screen.findByText('3')).toBeTruthy(); // 3 categories
    expect(screen.getByText('Edit')).toBeTruthy(); // ready loan facts
  });

  it('shows "Set up" when loan facts are not filled in', async () => {
    server.seed(LOAN_FACTS, EMPTY_FACTS);
    renderSettings();
    await screen.findByText('3');
    expect(screen.getByText('Set up')).toBeTruthy();
  });

  it('shows "…" (not "0") while first-loading, then the real count', async () => {
    const heldCats = server.hold(CATEGORIES);
    renderSettings();
    // All three query-backed rows — categories count, loan status, AND the Automation-rules
    // count (WHIT-198) — show "…" while first-loading; none flashes a misleading "0".
    expect(screen.getAllByText('…').length).toBe(3);
    expect(screen.queryByText('0')).toBeNull(); // fail-on-revert for the rules-row "0" flash
    await act(async () => { heldCats.release(); });
    expect(await screen.findByText('3')).toBeTruthy();
  });

  // WHIT-198 GAP (authored by qa) — the "…" gate must NOT swallow a LEGITIMATE empty state. The
  // flash guard above proves "0" is hidden WHILE loading; this proves that once the rules read has
  // SETTLED with genuinely zero rules, the row shows a real "0" (not a stuck "…"). listRules
  // resolves to [] here, so after load the Automation-rules row is the only "0" on screen.
  // Fail-on-revert: change settings.tsx to always-"…" or `rulesLoading || rules.length === 0 ? '…'`
  // (a wrong "fix" that also hides the real empty state) → "0" never appears → this fails.
  it('shows a genuine "0" once the rules read settles empty (the gate does not hide a real 0)', async () => {
    renderSettings();
    await screen.findByText('3'); // categories settled → load is past first paint
    expect(await screen.findByText('0')).toBeTruthy(); // Automation rules: real empty state, not a stuck "…"
  });

  it('does not fetch before login, then fires on auth flip to authed', async () => {
    setAuthStatusQuietly('anon');
    renderSettings();
    expect(categoryReads()).toBe(0);
    expect(loanReads()).toBe(0);

    await act(async () => { setAuthStatus('authed'); });
    expect(await screen.findByText('3')).toBeTruthy();
    expect(loanReads()).toBeGreaterThan(0);
  });

  it('a transient 5xx on the loan-facts read retries and self-heals', async () => {
    server.once('GET', LOAN_FACTS, { status: 503 });
    renderSettings(makeClient({ retry: 2 }));
    expect(await screen.findByText('Edit')).toBeTruthy();
    expect(loanReads()).toBe(2);
  });
});

// ===== WHIT-191a GAPS (authored by qa) — the adversarial half of useSettingsScreenData /
// Settings that the implementer's happy-path suite skips:
//   (1) sustained hard failure (WHIT-198): hook surfaces categoriesError and the screen
//       renders an honest "—" + inline Retry — NOT the misleading "0" it rendered before;
//   (2) partial-load flash: loan cached-ready but categories pending → isLoading true;
//   (3) read-your-write: a save's invalidate refetches the active Settings observer and
//       the loan row stays "Edit";
//   (4) focus refetchStale is stale-gated (no request storm) but does refetch when stale;
//   (5) refetch()/invalidate-scope at the read layer (categories NOT refetched).
describe('WHIT-191a gaps — hard-fail / cache-first / focus gate', () => {
  const ONE_RULE = [{ id: 'r1', field: 'description', operator: 'contains', value: 'X', categoryId: 'c' }];

  const CATS = [
    { id: 'a', name: 'A', bucket: 'Living', icon: 'cart', color: '#7FD49B' },
    { id: 'b', name: 'B', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C' },
  ];
  const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

  beforeEach(() => {
    resetAuth();
    server.seed(CATEGORIES, CATS);
    server.seed(LOAN_FACTS, READY_FACTS);
    server.seed(RULES, ONE_RULE);
  });

  describe('sustained hard failure (no self-heal)', () => {
    it('hook surfaces categoriesError (not a fake 0) and drops isLoading', async () => {
      server.fail(CATEGORIES, 500);
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(makeClient()) });

      await waitFor(() => expect(result.current.categoriesError).toBe(true));
      expect(result.current.isLoading).toBe(false); // errored query is not "loading" → no endless "…"
      expect(result.current.loanReadyError).toBe(false); // loan facts still resolved → that row is fine
    });

    // WHIT-198 fail-on-revert: before the fix the categories row collapsed to a misleading "0".
    // Reverting settings.tsx to `String(categoriesCount)` brings the "0" back and fails this.
    it('Settings renders "—" + a Retry (not the misleading "0") once the read has hard-failed', async () => {
      server.fail(CATEGORIES, 500);
      render(<QueryClientProvider client={makeClient()}><Settings /></QueryClientProvider>);

      // loan facts still resolve → "Edit" lets us wait past first paint deterministically.
      expect(await screen.findByText('Edit')).toBeTruthy();
      expect(screen.queryByText('…')).toBeNull(); // "…" cleared on error
      expect(screen.queryByText('0')).toBeNull(); // WHIT-198: no longer a misleading 0
      expect(screen.getByText('—')).toBeTruthy(); // honest "unknown" on the categories row
      expect(screen.getByTestId('settings-setup-error')).toBeTruthy();
      expect(screen.getByTestId('settings-setup-retry')).toBeTruthy(); // and a working retry affordance
    });
  });

  describe('the inline Retry re-reads both server rows (WHIT-198)', () => {
    it('press Retry → categories + loan facts refetch and the rows recover', async () => {
      server.fail(CATEGORIES, 500);
      server.fail(LOAN_FACTS, 500);
      render(<QueryClientProvider client={makeClient()}><Settings /></QueryClientProvider>);

      const retry = await screen.findByTestId('settings-setup-retry');
      await waitFor(() => expect(screen.getAllByText('—').length).toBe(2)); // both rows honestly unknown

      // re-arm both reads to succeed (a queued reply goes out ahead of the failure), then retry
      server.once('GET', CATEGORIES, { body: CATS });
      server.once('GET', LOAN_FACTS, { body: READY_FACTS });
      fireEvent.press(retry);

      await waitFor(() => expect(screen.queryByText('—')).toBeNull()); // rows recovered
      expect(screen.getByText('2')).toBeTruthy(); // real categories count
      expect(screen.getByText('Edit')).toBeTruthy(); // loan facts ready again
      expect(screen.queryByTestId('settings-setup-error')).toBeNull(); // retry affordance gone
    });
  });

  describe('cache-first: a background-refetch failure keeps the last-good value (WHIT-198)', () => {
    it('does NOT surface categoriesError once a real count has been cached', async () => {
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(makeClient({ staleTime: 0 })) });
      await waitFor(() => expect(result.current.categoriesCount).toBe(2)); // first load succeeded

      // the NEXT read fails — but we already hold a cached count
      const before = categoryReads();
      server.fail(CATEGORIES, 503);
      await act(async () => { result.current.refetchStale(); });
      await waitFor(() => expect(categoryReads()).toBe(before + 1)); // the refetch fired + failed

      // firstLoadError guard: data is retained on a background-refetch failure → no "—", real count stays
      expect(result.current.categoriesError).toBe(false);
      expect(result.current.categoriesCount).toBe(2);
    });
  });

  describe('partial-load flash', () => {
    it('reports isLoading true while categories are pending even though loan facts are cached-ready', async () => {
      const heldCats = server.hold(CATEGORIES); // not answered during the test
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(makeClient()) });

      await waitFor(() => expect(result.current.loanReady).toBe(true)); // loan settled first
      expect(result.current.isLoading).toBe(true); // ...but the whole screen (incl. loan row) still shows "…"
      await act(async () => { heldCats.release(); });
    });
  });

  describe('read-your-write with an active Settings observer', () => {
    it("invalidate after a save refetches the mounted observer and the loan row stays ready", async () => {
      const client = makeClient();
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(client) });
      await waitFor(() => expect(result.current.loanReady).toBe(true));

      const before = loanReads();
      const catBefore = categoryReads();

      // Mirror the production write: setQueryData(next) + invalidate ONLY loanFacts.
      await refreshInAct(async () => {
        client.setQueryData(['loanFacts'], READY_FACTS);
        await client.invalidateQueries({ queryKey: ['loanFacts'] });
      });

      await waitFor(() => expect(loanReads()).toBe(before + 1)); // active observer refetched
      expect(categoryReads()).toBe(catBefore); // invalidate was loanFacts-only
      expect(result.current.loanReady).toBe(true); // never flickers to "Set up" across the refetch
    });
  });

  describe('refetchStale focus gate', () => {
    it('does NOT refetch fresh (non-stale) queries — no request storm on focus', async () => {
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(makeClient()) });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const cats = categoryReads();
      const loan = loanReads();
      await act(async () => { result.current.refetchStale(); });

      expect(categoryReads()).toBe(cats); // still fresh → skipped
      expect(loanReads()).toBe(loan);
    });

    it('DOES refetch both when they have gone stale', async () => {
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(makeClient({ staleTime: 0 })) });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const cats = categoryReads();
      const loan = loanReads();
      await act(async () => { result.current.refetchStale(); });

      await waitFor(() => expect(categoryReads()).toBe(cats + 1));
      expect(loanReads()).toBe(loan + 1);
    });
  });

  // WHIT-198 follow-up — the Automation-rules row got the same honest-"—" + retry treatment as
  // categories/loan (previously it only got the loading gate, so a sustained rules failure still
  // showed a misleading "0").
  describe('rules-row hard failure', () => {
    it('rules read fails → Automation rules shows "—" + the setup retry, others keep their values', async () => {
      server.fail(RULES, 500);
      render(<QueryClientProvider client={makeClient()}><Settings /></QueryClientProvider>);

      expect(await screen.findByText('2')).toBeTruthy(); // categories loaded (2), unaffected
      expect(screen.getByText('Edit')).toBeTruthy(); // loan loaded, unaffected
      expect(screen.getByText('—')).toBeTruthy(); // rules row honestly unknown
      expect(screen.queryByText('0')).toBeNull(); // WHIT-198: not a misleading 0
      expect(screen.getByTestId('settings-setup-error')).toBeTruthy();
    });

    it('the setup Retry re-reads the failed rules query too (fan-out includes rules)', async () => {
      server.fail(RULES, 500);
      render(<QueryClientProvider client={makeClient()}><Settings /></QueryClientProvider>);

      const retry = await screen.findByTestId('settings-setup-retry');
      await screen.findByText('—'); // rules failed → "—"

      server.once('GET', RULES, { body: ONE_RULE }); // re-arm the rules read
      fireEvent.press(retry);

      expect(await screen.findByText('1')).toBeTruthy(); // rules recovered to its real count
      expect(screen.queryByText('—')).toBeNull();
      expect(screen.queryByTestId('settings-setup-error')).toBeNull();
    });
  });

  // WHIT-198 follow-up — investigation: does simply returning to the Settings tab re-arm a row that
  // hard-failed its first load, or is the Retry button the only path? Answer, locked here: a query
  // that errored with NOTHING cached is STALE, so the focus `refetchStale()` DOES retry it. (A
  // background-refetch failure over cached data is a different case — that keeps the cached value.)
  describe('focus refetch re-arms a first-load failure', () => {
    it('a first-load-failed categories read is stale, so refetchStale() on focus retries + recovers it', async () => {
      server.once('GET', CATEGORIES, { status: 500 });
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(makeClient()) });

      await waitFor(() => expect(result.current.categoriesError).toBe(true)); // first load failed, nothing cached
      const callsAfterFail = categoryReads();

      await act(async () => { result.current.refetchStale(); }); // returning to the tab

      await waitFor(() => expect(result.current.categoriesError).toBe(false)); // recovered without pressing Retry
      expect(result.current.categoriesCount).toBe(2);
      expect(categoryReads()).toBe(callsAfterFail + 1); // focus DID re-issue the failed read
    });
  });
});

// ===== WHIT-198 GAPS (authored by qa) — the adversarial half of the "honest — + Retry" work that
// the settingsQueryGaps suite does NOT already cover. That suite locks the CATEGORIES-only hard
// failure, the recover-via-Retry path and cache-first. This block adds the mirror + ordering +
// fan-out cases:
//   [A5] loan-row-ONLY failure → loan "—", categories keeps its real count, retry present;
//   [A6] a single-row failure's Retry still re-issues BOTH server reads (refetch fan-out);
//   [A7] one row errored while the OTHER is still loading → the isLoading gate wins, rows
//        show "…" (never a premature "—");
//   [A8] hook-level: BOTH per-row error flags true on a 500, then BOTH false after success;
//   [A9] the profile / Automation rules / Pay cycle / Log out rows stay rendered
//        + the Log out affordance stays usable DURING a categories outage (why there is no
//        full-screen error card).
describe('WHIT-198 gaps — loan-only / ordering / fan-out', () => {
  // A sibling observer sharing the same QueryClient as Settings — it renders a marker the instant
  // categoriesError flips true. That's the deterministic anchor for the "error landed WHILE still
  // loading" state, which the gated error card deliberately makes invisible on Settings itself.
  function ErrorProbe() {
    const { categoriesError } = useSettingsScreenData();
    return categoriesError ? <Text testID="probe-cats-errored">x</Text> : null;
  }

  const CATS = [
    { id: 'a', name: 'A', bucket: 'Living', icon: 'cart', color: '#7FD49B' },
    { id: 'b', name: 'B', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C' },
  ];
  const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

  beforeEach(() => {
    resetAuth();
    server.seed(CATEGORIES, CATS);
    server.seed(LOAN_FACTS, READY_FACTS);
    // rules length 1 so the Automation-rules row shows a stable "1" during an outage.
    server.seed(RULES, [{ id: 'r1', field: 'description', operator: 'contains', value: 'X', categoryId: 'c' }]);
  });

  // [A5] mirror of the implementer's categories-only case, for the LOAN row. Before the fix the
  // loan row collapsed to a misleading "Set up"; reverting settings.tsx' loan cell to
  // `loanReady ? 'Edit' : 'Set up'` brings "Set up" back and drops the "—", failing this.
  describe('loan-row-ONLY hard failure (categories fine)', () => {
    it('loan shows "—" + retry, categories keeps its real count (no fake "Set up")', async () => {
      server.fail(LOAN_FACTS, 500);
      render(<QueryClientProvider client={makeClient()}><Settings /></QueryClientProvider>);

      expect(await screen.findByText('2')).toBeTruthy();        // categories count intact
      expect(screen.getByText('—')).toBeTruthy();               // loan row honestly unknown
      expect(screen.queryByText('Set up')).toBeNull();          // WHIT-198: not the misleading "Set up"
      expect(screen.queryByText('Edit')).toBeNull();
      expect(screen.queryByText('…')).toBeNull();               // load settled → no endless "…"
      expect(screen.getByTestId('settings-setup-error')).toBeTruthy();
      expect(screen.getByTestId('settings-setup-retry')).toBeTruthy();
    });
  });

  // [A6] a SINGLE errored row must still refetch BOTH server reads on Retry (the composite
  // refetch fans out to every query). If refetch only re-fired the errored loan query, the
  // categories read would NOT be re-issued — this counts both mocks to prove the fan-out.
  describe('Retry after a single-row failure re-issues BOTH reads', () => {
    it('loan-only failure → Retry refetches categories AND loan facts', async () => {
      server.fail(LOAN_FACTS, 500);
      render(<QueryClientProvider client={makeClient()}><Settings /></QueryClientProvider>);

      const retry = await screen.findByTestId('settings-setup-retry');
      await screen.findByText('2');                             // categories loaded once
      const catsBefore = categoryReads(); // == 1
      const loanBefore = loanReads();     // == 1

      server.once('GET', LOAN_FACTS, { body: READY_FACTS }); // re-arm the loan read, ahead of the failure
      fireEvent.press(retry);

      await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy()); // loan recovered
      expect(categoryReads()).toBe(catsBefore + 1);  // the healthy row refetched too
      expect(loanReads()).toBe(loanBefore + 1);
      expect(screen.queryByTestId('settings-setup-error')).toBeNull();     // affordance gone
    });
  });

  // [A7] ordering / isLoading gate: categories errors FAST while loan facts are still pending. The
  // per-row error flag can be true WHILE the composite is still loading — and neither the row ("…"
  // wins over "—") nor the inline error card (gated on !isLoading) may surface the failure yet. We
  // assert this at the HOOK boundary (deterministic: we can wait for categoriesError to land), then
  // on the screen (both rows "…", no "—", no error card while loading). A screen-only "…" sample is
  // racy against the sibling Automation-rules row's cold-load "0", so the hook check is the anchor.
  describe('one row errored while the other is still loading', () => {
    it('hook: categoriesError flips true while isLoading stays true (loan still pending)', async () => {
      server.fail(CATEGORIES, 500);
      const heldLoan = server.hold(LOAN_FACTS); // not answered during the test
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(makeClient()) });

      await waitFor(() => expect(result.current.categoriesError).toBe(true)); // the error landed…
      expect(result.current.isLoading).toBe(true); // …but the screen is still loading (loan pending)
      expect(result.current.loanReadyError).toBe(false); // the pending read hasn't errored
      await act(async () => { heldLoan.release(); });
    });

    it('screen: withholds the error card while still loading, then surfaces it once loading ends', async () => {
      server.fail(CATEGORIES, 500);
      const heldLoan = server.hold(LOAN_FACTS); // held pending
      render(
        <QueryClientProvider client={makeClient()}>
          <ErrorProbe />
          <Settings />
        </QueryClientProvider>,
      );

      // Deterministic anchor: wait until categoriesError has ACTUALLY flipped true (loan still pending).
      await screen.findByTestId('probe-cats-errored');
      // ...yet the composite is still loading → the gate withholds the card. Without `!isLoading` the
      // card would already be co-rendering with the "…" rows here — this is the gate's fail-on-revert.
      expect(screen.queryByTestId('settings-setup-error')).toBeNull();
      expect(screen.queryByText('—')).toBeNull(); // rows still "…", no premature dash

      // let loan settle → isLoading false, categoriesError still true → the card + "—" now surface
      await act(async () => { heldLoan.release(); });
      expect(await screen.findByTestId('settings-setup-error')).toBeTruthy();
      expect(screen.getByText('—')).toBeTruthy();
    });
  });

  // [A8] hook-level enumeration of BOTH per-row flags: a 500 on both reads → both true; a
  // successful Retry → both false. Complements the screen tests at the data-source boundary.
  describe('hook surfaces both per-row error flags together', () => {
    it('both flags true on a dual 500, both false after a successful refetch', async () => {
      server.fail(CATEGORIES, 500);
      server.fail(LOAN_FACTS, 500);
      const { result } = renderHook(() => useSettingsScreenData(), { wrapper: wrapper(makeClient()) });

      await waitFor(() => expect(result.current.categoriesError).toBe(true));
      expect(result.current.loanReadyError).toBe(true);
      expect(result.current.isLoading).toBe(false); // both settled (errored) → not loading

      server.once('GET', CATEGORIES, { body: CATS });
      server.once('GET', LOAN_FACTS, { body: READY_FACTS });
      await act(async () => { result.current.refetch(); });

      await waitFor(() => expect(result.current.categoriesError).toBe(false));
      expect(result.current.loanReadyError).toBe(false);
      expect(result.current.categoriesCount).toBe(2);
      expect(result.current.loanReady).toBe(true);
    });
  });

  // [A9] the reason WHIT-198 uses an INLINE row-level "—"/retry and not a full-screen error
  // card: every non-server row must stay rendered + usable during a categories outage.
  describe('non-server rows stay usable during a categories outage', () => {
    it('profile, Automation rules, Pay cycle, Log out all render + Log out still fires', async () => {
      server.fail(CATEGORIES, 500);
      render(<QueryClientProvider client={makeClient()}><Settings /></QueryClientProvider>);

      await screen.findByTestId('settings-setup-error');    // outage is live
      expect(await screen.findByText('Edit')).toBeTruthy(); // the OTHER server row (loan) settled fine
      expect(await screen.findByText('1')).toBeTruthy();    // Automation rules count still renders
      expect(screen.getByText('Signed in')).toBeTruthy();   // profile still shows (getCurrentUser → null)
      expect(screen.getByText('Fortnightly')).toBeTruthy(); // Pay cycle name unaffected
      expect(screen.getByText('Log out')).toBeTruthy();

      fireEvent.press(screen.getByTestId('settings-logout')); // Log out still works mid-outage
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(routerSpies.replace).toHaveBeenCalledWith('/');
    });
  });
});
