// WHIT-233 — the Goals hub's composite (useGoalsScreenData) on the REAL query layer: not
// fetched before login, fires on the auth flip, and — the crux — isLoading/isError come ONLY
// from the two PRIMARY reads (goals + pay cycle). Account balances and the mortgage summary
// are SECONDARY: a hiccup there degrades one card (balanceFor → null, mortgageError), never
// blanks the hub. Retry fires EVERY read. Real ../api over the fake server, ../auth mocked;
// real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

import { useGoalsScreenData, homeLoanKey } from '../queries';

const server = installFakeServer();

const GOALS = [
  { id: 'g1', name: 'Emergency fund', icon: 'umbrella', direction: 'grow', target_amount: 10000, target_date: '2026-12-01', account_id: 'up-spending' },
];
const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const BALANCES = [
  { account_id: 'up-spending', amount: 4200.5, available_balance: null, currency: 'AUD', as_of: '2026-07-10T00:00:00Z', account_type: null },
  { account_id: 'up-homeloan', amount: -596642.43, available_balance: null, currency: 'AUD', as_of: '2026-07-10T00:00:00Z', account_type: null },
];
const HOME_LOAN = { balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' };
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

beforeEach(() => {
  resetAuth();
  server.seed('/goals', GOALS);
  server.seed('/paycycle', PAY_CYCLE);
  server.seed('/accounts/balances', BALANCES);
  server.seed('/homeloan', HOME_LOAN);
  server.seed('/loanfacts', READY_FACTS);
});

it('assembles goals, pay cycle, the mortgage summary, and a per-account balance lookup', async () => {
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.goals).toEqual(GOALS);
  expect(result.current.payCycle).toEqual(PAY_CYCLE);
  expect(result.current.loanFacts).toEqual(READY_FACTS);
  expect(result.current.homeLoan).toEqual({ balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' });
  expect(result.current.isError).toBe(false);
  expect(result.current.mortgageError).toBe(false);
});

it('balanceFor returns the live SIGNED amount by account id, null for unknown/unset', async () => {
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.goals).toEqual(GOALS));

  expect(result.current.balanceFor('up-spending')).toBe(4200.5);
  expect(result.current.balanceFor('up-homeloan')).toBe(-596642.43); // sign preserved (a loan is negative)
  expect(result.current.balanceFor('not-linked')).toBeNull();        // account not in the payload
  expect(result.current.balanceFor(null)).toBeNull();                // a manual goal (no account_id)
  expect(result.current.balanceFor(undefined)).toBeNull();
});

it('does not fetch before login, then fires every read on the auth flip', async () => {
  setAuthStatusQuietly('anon');
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  expect(server.sent('GET', '/goals')).toHaveLength(0);
  expect(server.sent('GET', '/paycycle')).toHaveLength(0);
  expect(server.sent('GET', '/accounts/balances')).toHaveLength(0);

  await act(async () => { setAuthStatus('authed'); });
  await waitFor(() => expect(result.current.goals).toEqual(GOALS));
  expect(server.sent('GET', '/goals')).toHaveLength(1);
  expect(server.sent('GET', '/accounts/balances')).toHaveLength(1);
});

it('SECONDARY balances failure does NOT set isError — a synced card just loses its balance', async () => {
  server.fail('/accounts/balances', 500);
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.goals).toEqual(GOALS));

  expect(result.current.isError).toBe(false);              // the hub still renders
  expect(result.current.balanceFor('up-spending')).toBeNull(); // just no live balance to show
});

it('SECONDARY mortgage failure sets mortgageError only — never the aggregate isError', async () => {
  server.fail('/homeloan', 503);
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.mortgageError).toBe(true));

  expect(result.current.isError).toBe(false);   // the mortgage card shows its own retry, hub is fine
  expect(result.current.goals).toEqual(GOALS);
});

it('SECONDARY milestones (WHIT-747): a slow read never holds up the hub, and they arrive once loaded', async () => {
  const MILESTONES = [{ id: 'm1', label: 'First', targetBalance: 600000, targetDate: '2027-01-01' }];
  server.seed('/milestones', MILESTONES);
  const held = server.hold('/milestones');
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.goals).toEqual(GOALS));

  expect(result.current.isLoading).toBe(false);
  expect(result.current.goalsLoaded).toBe(true);
  expect(result.current.milestonesLoaded).toBe(false);
  expect(result.current.milestones).toEqual([]);

  await act(async () => { held.release(); });
  await waitFor(() => expect(result.current.milestonesLoaded).toBe(true));
  expect(result.current.milestones).toEqual(MILESTONES);
});

it('SECONDARY milestones failure does NOT set isError, and still counts as loaded (an empty plan)', async () => {
  server.fail('/milestones', 500);
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.milestonesLoaded).toBe(true));

  expect(result.current.isError).toBe(false);
  expect(result.current.milestones).toEqual([]);
});

it('a PRIMARY goals first-load failure sets isError (nothing to show)', async () => {
  server.fail('/goals', 500);
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
});

it('a PRIMARY pay-cycle first-load failure sets isError (pace math has no cycle)', async () => {
  server.fail('/paycycle', 500);
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
});

it('refetch fires EVERY read — including the secondary balances + mortgage', async () => {
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.goals).toEqual(GOALS));
  const before = {
    goals: server.sent('GET', '/goals').length,
    balances: server.sent('GET', '/accounts/balances').length,
    homeLoan: server.sent('GET', '/homeloan').length,
  };

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(server.sent('GET', '/goals').length).toBeGreaterThan(before.goals));
  expect(server.sent('GET', '/accounts/balances').length).toBeGreaterThan(before.balances);
  expect(server.sent('GET', '/homeloan').length).toBeGreaterThan(before.homeLoan);
});

// ===== WHIT-233 (folded from goalsScreenDataEdges.screen.test.tsx) =====
// ADVERSARIAL edges for useGoalsScreenData the implementer's goalsScreenData suite leaves open: a
// SECONDARY loanFacts failure must NOT leak into the aggregate isError; a homeLoan that loaded then
// FAILED a background refetch must keep mortgageError FALSE (firstLoadError, not bare .isError — the
// last-good value stands); balanceFor keeps a STABLE identity across a redraw when balances are
// unchanged (the WHIT-244 [dep]-thrash trap) and changes when the data changes; and `goals` keeps a
// stable EMPTY_GOALS identity while cold. Real ../api over the fake server (same regime).
// Block-scoped BALANCES (single account) shadows the module-level one; a self-contained beforeEach
// re-seeds auth + every read for this describe.
describe('useGoalsScreenData — adversarial edges (WHIT-233)', () => {
  const BALANCES = [
    { account_id: 'up-spending', amount: 4200.5, available_balance: null, currency: 'AUD', as_of: '2026-07-10T00:00:00Z', account_type: null },
  ];

  beforeEach(() => {
    resetAuth();
    server.seed('/goals', GOALS);
    server.seed('/paycycle', PAY_CYCLE);
    server.seed('/accounts/balances', BALANCES);
    server.seed('/homeloan', HOME_LOAN);
    server.seed('/loanfacts', READY_FACTS);
  });

  // [S1] loanFacts is SECONDARY too — its failure must not blank the hub (guards against someone
  // adding loanFactsQuery to the primary isError). The implementer only tested homeLoan + balances.
  it('a SECONDARY loanFacts failure does NOT set isError and leaves mortgageError false', async () => {
    server.fail('/loanfacts', 500);
    const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.goals).toEqual(GOALS));

    expect(result.current.isError).toBe(false);       // hub still renders
    expect(result.current.mortgageError).toBe(false);  // only homeLoan drives the mortgage card error
  });

  // [S2] the firstLoadError crux: a homeLoan that loaded, then a background refetch FAILS — data is
  // still the last-good value, so mortgageError must stay FALSE. Bare `.isError` would flip it true.
  it('a cached homeLoan whose refetch later FAILS keeps mortgageError false (firstLoadError semantics)', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
    expect(result.current.mortgageError).toBe(false);

    // Now the mortgage read starts failing; a refetch fires it (and the others, which still succeed).
    server.fail('/homeloan', 503);
    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(server.sent('GET', '/homeloan')).toHaveLength(2));
    // The real request settles a few ticks later; wait until the failure has landed in the cache.
    await waitFor(() => expect(client.getQueryState(homeLoanKey)?.status).toBe('error'));

    expect(result.current.homeLoan.balance).toBe(596642.43); // last-good value preserved
    expect(result.current.mortgageError).toBe(false);        // NOT flagged — it loaded once
  });

  // [S3] balanceFor identity is stable across a redraw when balances are unchanged (so a
  // [balanceFor]-keyed effect won't thrash), and changes only when the balances data changes.
  it('balanceFor keeps a stable identity across a redraw, and changes when balances change', async () => {
    const { result, rerender } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.balanceFor('up-spending')).toBe(4200.5));

    const before = result.current.balanceFor;
    rerender({});
    expect(result.current.balanceFor).toBe(before); // same reference — no thrash

    // A genuine balances change must produce a NEW balanceFor (and the new value).
    server.seed('/accounts/balances', [
      { account_id: 'up-spending', amount: 9999, available_balance: null, currency: 'AUD', as_of: '2026-07-11T00:00:00Z', account_type: null },
    ]);
    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(result.current.balanceFor('up-spending')).toBe(9999));
    expect(result.current.balanceFor).not.toBe(before);
  });

  // [S4] while cold (not authed → no data), `goals` is the SAME frozen EMPTY_GOALS across redraws,
  // so a [goals]-keyed memo/effect doesn't re-fire every render (the documented WHIT-244 trap).
  it('goals keeps a stable empty-array identity while cold (EMPTY_GOALS)', async () => {
    setAuthStatusQuietly('anon');
    const { result, rerender } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
    const first = result.current.goals;
    expect(first).toEqual([]);
    rerender({});
    expect(result.current.goals).toBe(first); // same reference, not a fresh `?? []`
  });
});
