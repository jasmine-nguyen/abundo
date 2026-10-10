// WHIT-821 — Home loan screen set-up states, drawn over the fake server so the real screen
// data code runs: one set-up button (on the top card, at least 44pt tall, nothing on the
// equity card), and a calm "no home loan" explainer when the feed has no home loan.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { EMPTY_LOAN_FACTS, NO_REPAYMENT } from './factory';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, drawHeld, refreshInAct, releaseAndSettle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter, routerSpies } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

it('Home loan not set up: one set-up button on the top card that opens the loan form', async () => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' } });
  await renderWithQueries(<Mortgage />);

  expect(screen.getAllByText('Set up loan details →')).toHaveLength(1);
  expect(screen.queryByText('Add loan details →')).toBeNull();
  expect(screen.queryByTestId('hero-no-home-loan')).toBeNull();

  fireEvent.press(screen.getByRole('button', { name: 'Set up loan details →' }));
  expect(routerSpies.push).toHaveBeenCalledWith('/loan');
});

it.each([
  ['no balance, no repayment → calm "no home loan" explainer, no set-up, no secondary cards', NO_REPAYMENT, true],
  ['no balance but a repayment on record → the loan exists, so the set-up prompt shows', { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 }, false],
])('Home loan with facts unset: %s', async (_name, repayment, noHomeLoan) => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: null, asOf: '2026-07-04T00:00:00Z' }, repayment });
  await renderWithQueries(<Mortgage />);

  if (!noHomeLoan) {
    expect(screen.queryByTestId('hero-no-home-loan')).toBeNull();
    expect(screen.getByText('Set up loan details →')).toBeTruthy();
    return;
  }
  expect(screen.getByTestId('hero-no-home-loan')).toBeTruthy();
  expect(screen.queryByText('—')).toBeNull();
  expect(screen.queryByText('Set up loan details →')).toBeNull();
  expect(screen.queryByText('Add loan details →')).toBeNull();
  expect(screen.queryByTestId('milestone-link')).toBeNull();
  expect(screen.queryByText(/No repayment on record yet/)).toBeNull();
  expect(screen.queryByText('Equity for your next place')).toBeNull();
});

// [A3] A failed repayment read is a sign of a loan, so it keeps the set-up prompt; "no home loan"
// needs a read that worked and found nothing.
it('Home loan with facts unset + no balance: the repayment read fails → set-up prompt, not "no home loan"', async () => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: null, asOf: '2026-07-04T00:00:00Z' } });
  server.fail('/repayment', 500);
  await renderWithQueries(<Mortgage />);

  expect(screen.queryByTestId('hero-no-home-loan')).toBeNull();
  expect(screen.getByText('Set up loan details →')).toBeTruthy();
});

// [A2] Facts set but no balance yet is "waiting", never "no home loan"; the other cards stay.
it('Home loan with facts set + no balance → the waiting copy and the other cards, not "no home loan"', async () => {
  seedGoal(server, { homeLoan: { balance: null, asOf: null } });
  await renderWithQueries(<Mortgage />);

  expect(screen.getByText("We'll show your payoff progress once your balance loads.")).toBeTruthy();
  expect(screen.queryByTestId('hero-no-home-loan')).toBeNull();
  expect(screen.getByTestId('milestone-link')).toBeTruthy();
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
});

// [A1] Facts unset while the balance or repayment is still loading → the quiet placeholder only:
// neither the set-up prompt nor "no home loan" flashes before the reads land.
it.each(['/homeloan', '/repayment'])('Home loan with facts unset, %s still loading → no set-up or "no home loan" flash', async (path) => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS });
  const held = server.hold(path);
  drawHeld(<Mortgage />);
  await refreshInAct(() => undefined);

  expect(screen.getByTestId('hero-facts-loading')).toBeTruthy();
  expect(screen.queryByText('Set up loan details →')).toBeNull();
  expect(screen.queryByTestId('hero-no-home-loan')).toBeNull();

  await releaseAndSettle(held);
  expect(screen.getByTestId('hero-no-home-loan')).toBeTruthy();
});
