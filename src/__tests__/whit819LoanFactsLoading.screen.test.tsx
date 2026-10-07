// WHIT-819 — loan facts that haven't loaded (or failed to load) must never look like
// "not set up": the Loan form must not open blank over saved facts, and the Home loan
// top card must not offer "Set up loan details →" before the facts arrive. Errors come
// before the not-set-up prompt. Drawn over the fake server so the real query code runs.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import type { AppContext, LoanFacts } from '../context';
import { EMPTY_LOAN_FACTS } from './factory';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, WithQueries } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';

let mockState: Partial<AppContext>;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Loan from '../../app/loan';
import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

const SAVED: LoanFacts = {
  original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200,
};

beforeEach(() => {
  resetAuth();
  resetRouter();
  mockState = { saveLoanFacts: jest.fn() as AppContext['saveLoanFacts'], showToast: jest.fn() as AppContext['showToast'] };
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it('Loan form: does not open blank while saved facts are still loading', async () => {
  server.seed('/loanfacts', SAVED);
  const held = server.hold('/loanfacts');
  try {
    render(<WithQueries><Loan /></WithQueries>);
    await flush();
    expect(screen.queryByText('Save loan details')).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. 600000')).toBeNull();
    expect(screen.getByTestId('loan-facts-loading')).toBeTruthy();
  } finally {
    await act(async () => { held.release(); });
  }
  await waitFor(() => expect(screen.getByDisplayValue('600000')).toBeTruthy());
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
  try {
    render(<WithQueries><Mortgage /></WithQueries>);
    await flush();
    expect(screen.queryByText('Set up loan details →')).toBeNull();
    expect(screen.queryByText('Add loan details →')).toBeNull();
    expect(screen.getByTestId('hero-facts-loading')).toBeTruthy();
  } finally {
    await act(async () => { held.release(); });
  }
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
