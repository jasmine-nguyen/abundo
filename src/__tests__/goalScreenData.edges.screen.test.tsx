// WHIT-197 GAPS (composite) — the branches the happy-path suite (goalScreenData.screen)
// doesn't lock: (1) a null balance on a LATER refetch KEEPS the loaded balance
// (keep-last-good via the structuralSharing guard on useHomeLoanQuery — WHIT-204, restoring
// the old store's behaviour) — but a later real balance replaces it, and a genuine $0 is never
// held; (2) a loan-facts read failure is aggregate-error-but-not-a-balance-error and the facts
// fall back to EMPTY_LOAN_FACTS; (3) refetchStale refires stale reads once. Real ../api over the
// fake server, ../auth mocked; real
// QueryClientProvider drives the hook.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth } from './support/authMock';

import { useGoalScreenData } from '../queries';
import { EMPTY_LOAN_FACTS } from '../model';

const server = installFakeServer();

const HOME_LOAN = { balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' };
const NULL_HOME_LOAN = { balance: null, as_of: null, currency: null };
const REPAYMENT = { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 };
const REPAYMENT_2 = { amount: 1600, date: '2026-08-01', principal: 1300, interest: 300 };
const REPAYMENT_3 = { amount: 1700, date: '2026-09-01', principal: 1350, interest: 350 };
const HOME_LOAN_2 = { balance: 480000, as_of: '2026-08-01T00:00:00.000Z', currency: 'AUD' };
const ZERO_HOME_LOAN = { balance: 0, as_of: '2026-09-01T00:00:00.000Z', currency: 'AUD' }; // loan paid off
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

beforeEach(() => {
  resetAuth();
  server.seed('/homeloan', HOME_LOAN);
  server.seed('/repayment', REPAYMENT);
  server.seed('/loanfacts', READY_FACTS);
  server.seed('/milestones', []); // WHIT-367 (folded): default to the empty plan
});

it('a null balance on a LATER refetch KEEPS the loaded balance (keep-last-good, WHIT-204)', async () => {
  // First read: a real balance. Second read (a focus/Retry refetch): the server's null
  // sentinel (poller row absent). The keepLastGoodBalance structuralSharing guard on
  // useHomeLoanQuery keeps the previous non-null value, so the Goal/milestone hero stays on
  // the last balance instead of dropping to "—"/"Fetching…" (restores the old store's
  // context.tsx:547 behaviour). Since the value no longer changes, sequence on the second
  // fetch's call count (not a value transition), THEN assert the balance held.
  server.once('GET', '/homeloan', { body: HOME_LOAN });
  server.seed('/homeloan', NULL_HOME_LOAN);
  // Sequence on the REPAYMENT read, which DOES change on the refetch: once its new value lands
  // we know the whole second round (including the home-loan null) has been applied + rendered,
  // so the balance assertion can't pass by racing a pre-refetch read. (Waiting only on the
  // homeLoan fetch COUNT would let the assertion fire before the null result was written.)
  server.once('GET', '/repayment', { body: REPAYMENT });
  server.seed('/repayment', REPAYMENT_2);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.repayment.amount).toBe(1600)); // 2nd round applied (incl. the null balance)

  expect(result.current.homeLoan.balance).toBe(596642.43); // last-good survives the null
  expect(result.current.homeLoan.asOf).toBe('2026-07-04T00:24:37.614Z'); // and its timestamp
  expect(result.current.homeLoanError).toBe(false); // a null response is a SUCCESS, not an error
});

it('a held null is later OVERWRITTEN by a real balance — keep-last-good does NOT stick', async () => {
  // Round 1: real 596k. Round 2 (refetch): null → held at 596k. Round 3 (refetch): a NEW real
  // 480k → must take effect. Sequence each round on the REPAYMENT read (which changes every
  // round) so the balance assertion fires only after that round's home-loan result is applied.
  server.once('GET', '/homeloan', { body: HOME_LOAN });
  server.once('GET', '/homeloan', { body: NULL_HOME_LOAN });
  server.seed('/homeloan', HOME_LOAN_2);
  server.once('GET', '/repayment', { body: REPAYMENT });
  server.once('GET', '/repayment', { body: REPAYMENT_2 });
  server.seed('/repayment', REPAYMENT_3);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));

  // Round 2: the null — held.
  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.repayment.amount).toBe(1600));
  expect(result.current.homeLoan.balance).toBe(596642.43); // last-good survives the null

  // Round 3: the new real balance — must replace the held value (not stuck).
  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.repayment.amount).toBe(1700));
  expect(result.current.homeLoan.balance).toBe(480000);                    // updated
  expect(result.current.homeLoan.asOf).toBe('2026-08-01T00:00:00.000Z');   // and its timestamp
  expect(result.current.homeLoanError).toBe(false);
});

it('a genuine $0 balance (loan paid off) is NOT held — the guard keys on == null, not falsiness', async () => {
  server.once('GET', '/homeloan', { body: HOME_LOAN });
  server.seed('/homeloan', ZERO_HOME_LOAN);
  server.once('GET', '/repayment', { body: REPAYMENT });
  server.seed('/repayment', REPAYMENT_2);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.repayment.amount).toBe(1600)); // 2nd round applied
  expect(result.current.homeLoan.balance).toBe(0);                         // 0 flows through — NOT held at 596k
  expect(result.current.homeLoan.asOf).toBe('2026-09-01T00:00:00.000Z');
  expect(result.current.homeLoanError).toBe(false);
});

it('a loan-facts read failure is an aggregate error but NOT a balance error, and facts fall back to empty', async () => {
  server.fail('/loanfacts', 500);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.homeLoanError).toBe(false);            // the balance read is fine
  expect(result.current.homeLoan.balance).toBe(596642.43);
  expect(result.current.loanFacts).toEqual(EMPTY_LOAN_FACTS);  // ?? EMPTY_LOAN_FACTS fallback
});

it('refetchStale refetches all three reads exactly once when they are stale', async () => {
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient({ staleTime: 0 })) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(server.sent('GET', '/homeloan')).toHaveLength(1));

  await act(async () => { result.current.refetchStale(); });
  // staleTime 0 → immediately stale → each refires once (and only once).
  await waitFor(() => expect(server.sent('GET', '/homeloan')).toHaveLength(2));
  expect(server.sent('GET', '/repayment')).toHaveLength(2);
  expect(server.sent('GET', '/loanfacts')).toHaveLength(2);
});

// ===== WHIT-367 GAPS (folded from goalScreenDataMilestones.gaps) — the milestones query is
// SECONDARY: deliberately kept OUT of useGoalScreenData's combined isLoading/isError (queries.ts)
// so a milestones read hiccup degrades to the built-in default plan instead of blanking/erroring the
// balance hero: a REJECT leaves isError/isLoading untouched, milestones → [].
describe('goalScreenData — milestones secondary query (WHIT-367)', () => {
  it('a milestones read FAILURE does not flip isError/isLoading and falls back to []', async () => {
    server.fail('/milestones', 500);
    const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });

    // The three primary reads all succeed; the milestones failure must NOT surface in the aggregate.
    await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
    await waitFor(() => expect(server.sent('GET', '/milestones')).toHaveLength(1));
    expect(result.current.isError).toBe(false);          // milestones is OUT of the combine
    expect(result.current.isLoading).toBe(false);
    expect(result.current.homeLoanError).toBe(false);
    expect(result.current.milestones).toEqual([]);       // degrades to the empty (→ default plan) list
  });
});
