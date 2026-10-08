// WHIT-819 — loan facts that haven't loaded (or failed to load) must never look like
// "not set up": the Loan form must not open blank over saved facts, and the Home loan
// top card must not offer "Set up loan details →" before the facts arrive. Errors come
// before the not-set-up prompt. Drawn over the fake server so the real query code runs.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, act, waitFor, fireEvent } from '@testing-library/react-native';
import type { AppContext, LoanFacts } from '../context';
import { EMPTY_LOAN_FACTS } from './factory';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, renderLoaded, refreshInAct, settle, useTestQueryClient, drawHeld, releaseAndSettle } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { loanFactsKey } from '../queries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';
import { LOAN_FORM_PLACEHOLDERS } from './support/loanForm';

let mockState: Partial<AppContext>;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Loan from '../../app/loan';
import Mortgage from '../../app/mortgage';
import Milestone from '../../app/milestone';

const server = installFakeServer();
const EQUITY_TEASER = 'Your usable equity will show here once your loan details are set up.';
useTestQueryClient();

const SAVED: LoanFacts = {
  original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200,
};

beforeEach(() => {
  resetAuth();
  resetRouter();
  mockState = { saveLoanFacts: jest.fn() as AppContext['saveLoanFacts'], showToast: jest.fn() as AppContext['showToast'] };
});

it('Loan form: does not open blank while saved facts are still loading', async () => {
  server.seed('/loanfacts', SAVED);
  const held = server.hold('/loanfacts');
  drawHeld(<Loan />);
  await refreshInAct(() => undefined);
  expect(screen.queryByText('Save loan details')).toBeNull();
  expect(screen.queryByPlaceholderText(LOAN_FORM_PLACEHOLDERS.orig)).toBeNull();
  expect(screen.getByTestId('loan-facts-loading')).toBeTruthy();
  await releaseAndSettle(held);
  expect(screen.getByDisplayValue('600000')).toBeTruthy();
});

it('Loan form: a failed facts read shows Retry, not an empty form', async () => {
  server.fail('/loanfacts', 500);
  await renderWithQueries(<Loan />);
  expect(screen.getByTestId('loan-facts-retry')).toBeTruthy();
  expect(screen.queryByText('Save loan details')).toBeNull();
});

it('Home loan: no "set up" copy while saved facts are still loading', async () => {
  seedGoal(server);
  const held = server.hold('/loanfacts');
  drawHeld(<Mortgage />);
  await refreshInAct(() => undefined);
  expect(screen.queryByText('Set up loan details →')).toBeNull();
  expect(screen.queryByText(EQUITY_TEASER)).toBeNull();
  expect(screen.getByTestId('hero-facts-loading')).toBeTruthy();
  await releaseAndSettle(held);
});

it('Home loan: a failed facts read shows an error + Retry, not the set-up prompt', async () => {
  seedGoal(server);
  server.fail('/loanfacts', 500);
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText("Couldn't load your loan details.")).toBeTruthy();
  expect(screen.getByTestId('hero-facts-retry')).toBeTruthy();
  expect(screen.queryByText('Set up loan details →')).toBeNull();
});

it('Home loan: facts unset + failed balance shows the balance Retry, not a bare "—"', async () => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS });
  server.fail('/homeloan', 500);
  await renderWithQueries(<Mortgage />);
  expect(screen.getByTestId('hero-balance-retry')).toBeTruthy();
  expect(screen.queryByText('Set up loan details →')).toBeNull();
});

// --- QA: recovery, precedence and cache-first edges ---

// [A1] [A2] Retry after a failed first load brings back the real content on both screens.
it('Retry after a failed facts read brings back the real Home loan card and the filled Loan form', async () => {
  seedGoal(server, { loanFacts: SAVED });
  server.once('GET', '/loanfacts', { status: 500 });
  const mortgage = await renderWithQueries(<Mortgage />);
  await act(async () => { fireEvent.press(screen.getByTestId('hero-facts-retry')); });
  await settle();
  await refreshInAct(() => undefined);
  expect(screen.queryByTestId('hero-facts-retry')).toBeNull();
  expect(screen.getByText("We'll show your payoff progress once your balance loads.")).toBeTruthy();
  mortgage.unmount();

  queryClient.clear();
  server.once('GET', '/loanfacts', { status: 500 });
  await renderWithQueries(<Loan />);
  await act(async () => { fireEvent.press(screen.getByTestId('loan-facts-retry')); });
  await waitFor(() => expect(screen.getByDisplayValue('600000')).toBeTruthy());
  expect(screen.queryByTestId('loan-facts-error')).toBeNull();
});

// [A3] Both reads fail → the loan-details error wins (its Retry refetches both).
it('Home loan: when facts AND balance both fail, the loan-details error shows, not the balance one', async () => {
  seedGoal(server);
  server.fail('/loanfacts', 500);
  server.fail('/homeloan', 500);
  await renderWithQueries(<Mortgage />);
  expect(screen.getByTestId('hero-facts-retry')).toBeTruthy();
  expect(screen.queryByTestId('hero-balance-retry')).toBeNull();
});

// [A4] The loading placeholder still shows the balance we already know.
it('Home loan: the loading placeholder shows the known balance', async () => {
  seedGoal(server, { homeLoan: { balance: 250000, asOf: '2026-07-04T00:00:00Z' } });
  const held = server.hold('/loanfacts');
  drawHeld(<Mortgage />);
  await waitFor(() => expect(screen.getByTestId('hero-facts-loading').props.children).toMatch(/250/));
  await releaseAndSettle(held);
});

// [A5] A failed background refetch over cached facts keeps the real card (cache-first).
it('Home loan: a failed refetch over cached facts shows neither the facts error nor the set-up prompt', async () => {
  seedGoal(server);
  await renderWithQueries(<Mortgage />);
  server.fail('/loanfacts', 500);
  await refreshInAct(() => queryClient.refetchQueries({ queryKey: loanFactsKey }).catch(() => undefined));
  expect(queryClient.getQueryState(loanFactsKey)?.status).toBe('error');
  expect(screen.queryByTestId('hero-facts-retry')).toBeNull();
  expect(screen.queryByText('Set up loan details →')).toBeNull();
});

// [A6] Milestone equity card: no set-up teaser when the facts read failed.
it('Milestone: a failed facts read hides the equity set-up prompt', async () => {
  seedGoal(server);
  server.fail('/loanfacts', 500);
  await renderWithQueries(<Milestone />);
  expect(screen.queryByText(EQUITY_TEASER)).toBeNull();
});

// [A7] The form mounts once: a background refetch must not wipe what the user is typing.
it('Loan form: a background refetch keeps in-progress edits', async () => {
  server.seed('/loanfacts', SAVED);
  await renderLoaded(<Loan />);
  fireEvent.changeText(screen.getByDisplayValue('600000'), '612345');
  server.seed('/loanfacts', { ...SAVED, original: 500000 });
  await refreshInAct(() => queryClient.refetchQueries({ queryKey: loanFactsKey }));
  expect(queryClient.getQueryData<LoanFacts>(loanFactsKey)?.original).toBe(500000);
  expect(screen.getByDisplayValue('612345')).toBeTruthy();
});
