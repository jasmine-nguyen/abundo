// WHIT-197 — the Goal tab + milestone screen's server reads (live balance + last
// repayment + loan facts) on the REAL query layer: not fetched before login, fires on
// the auth flip, self-heals a transient 5xx, treats a null balance as success (not an
// error), and keeps the home-loan error home-loan-SPECIFIC (a repayment failure is not
// a balance error). Real ../api over the fake server, ../auth mocked; real
// QueryClientProvider drives the hook.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

import { useGoalScreenData } from '../queries';

const server = installFakeServer();

const HOME_LOAN = { balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' };
const REPAYMENT = { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 };
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

beforeEach(() => {
  resetAuth();
  server.seed('/homeloan', HOME_LOAN);
  server.seed('/repayment', REPAYMENT);
  server.seed('/loanfacts', READY_FACTS);
});

it('assembles the balance (as_of→asOf), repayment, and loan facts from the three reads', async () => {
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.homeLoan).toEqual({ balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' });
  expect(result.current.repayment).toEqual(REPAYMENT);
  expect(result.current.loanFacts).toEqual(READY_FACTS);
  expect(result.current.isError).toBe(false);
  expect(result.current.homeLoanError).toBe(false);
  expect(result.current.repaymentError).toBe(false);
});

it('does not fetch before login, then fires on the auth flip to authed', async () => {
  setAuthStatusQuietly('anon');
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  expect(server.sent('GET', '/homeloan')).toHaveLength(0);
  expect(server.sent('GET', '/repayment')).toHaveLength(0);
  expect(server.sent('GET', '/loanfacts')).toHaveLength(0);

  await act(async () => { setAuthStatus('authed'); });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
  expect(server.sent('GET', '/homeloan')).toHaveLength(1);
});

it('treats a null balance as a normal success — not an error', async () => {
  server.seed('/homeloan', { balance: null, as_of: null, currency: null });
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.homeLoan).toEqual({ balance: null, asOf: null });
  expect(result.current.homeLoanError).toBe(false);
  expect(result.current.isError).toBe(false);
});

it('keeps homeLoanError home-loan-specific: a repayment failure is not a balance error', async () => {
  server.fail('/repayment', 500);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.isError).toBe(true)); // aggregate reflects the repayment failure
  expect(result.current.homeLoanError).toBe(false); // ...but the balance read is fine
  expect(result.current.homeLoan.balance).toBe(596642.43);
  // WHIT-121: a FIRST-LOAD repayment failure (nothing cached) sets the read's OWN error —
  // this drives the Goal card's error+Retry instead of the "No repayment" empty state.
  expect(result.current.repaymentError).toBe(true);
});

it('WHIT-121: a cached EMPTY repayment survives a failed refetch — no false error (firstLoadError)', async () => {
  // repaymentError is firstLoadError, NOT bare .isError: a repayment that once loaded EMPTY
  // (a user who genuinely has none), then hit a failed background refetch, keeps its cached
  // empty value → the honest render is the empty state, not "couldn't load". Only a
  // never-loaded read (nothing cached) flags an error.
  const EMPTY = { amount: null, date: null, principal: null, interest: null };
  const HOME_LOAN_2 = { balance: 480000, as_of: '2026-08-01T00:00:00.000Z', currency: 'AUD' };
  server.once('GET', '/homeloan', { body: HOME_LOAN });
  server.seed('/homeloan', HOME_LOAN_2);
  server.once('GET', '/repayment', { body: EMPTY });
  server.fail('/repayment', 500);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(596642.43));
  expect(result.current.repaymentError).toBe(false); // first load: an empty SUCCESS, not an error

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.homeLoan.balance).toBe(480000)); // round 2 applied
  // The repayment refetch FAILED, but its cached empty value is retained → firstLoadError
  // stays false, so the card renders the honest empty state rather than a false error.
  expect(result.current.repaymentError).toBe(false);
  expect(result.current.repayment).toEqual(EMPTY);
});

it('WHIT-121: a first-load balance failure flags homeLoanError (nothing cached)', async () => {
  // The other half of firstLoadError for the balance: a never-loaded balance read that fails
  // DOES surface an error (the Goal + milestone heroes show "Couldn't load your balance.").
  server.fail('/homeloan', 503);
  const { result } = renderHook(() => useGoalScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.homeLoanError).toBe(true));
});
