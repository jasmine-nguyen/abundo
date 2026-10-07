// WHIT-378 — adversarial GAP coverage for the equity card across BOTH screens.
// Implementer's milestone.screen.test.tsx locks the exact-50% mortgage case + the
// "no target" degrade. These add:
//   [A8] mortgage chip ROUNDS a non-round pct (49.6% -> "50%") — proves Math.round in
//        app/mortgage.tsx:234 (implementer only ever used an exact 50%).
//   [A9] the MILESTONE screen IGNORES depositTarget entirely: with a target set it shows
//        the plain equity figure and NONE of the mortgage card's target chrome
//        (regression guard for the scope boundary — milestone.tsx must never wire it in).
// WHIT-685: drawn over the fake server, so the real screen data code runs.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { LOAN_FACTS } from './factory';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { seedGoal } from './support/goalsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({})));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';
import Milestone from '../../app/milestone';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => { resetAuth(); resetRouter(); });

it('[A8] mortgage equity chip ROUNDS the pct: equity 49,600 / target 100,000 -> "50%"', async () => {
  // 49600/100000 = 49.6% -> Math.round -> 50. balance 566400 -> equity 49600.
  seedGoal(server, { loanFacts: { ...LOAN_FACTS, depositTarget: 100000 }, homeLoan: { balance: 566400, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('$49,600 unlocked')).toBeTruthy();
  expect(screen.getByText('of $100,000 needed')).toBeTruthy();
  expect(screen.getByText('50%')).toBeTruthy();      // rounded up from 49.6
  expect(screen.queryByText('49.6%')).toBeNull();    // fail-on-revert: dropping Math.round -> "49.6%"
});

it('[A9] the MILESTONE equity card ignores a set depositTarget — no chip, no "needed", no bar', async () => {
  // Same fixture that drives the mortgage card into its target-set state; the milestone
  // screen reads a different selector (usableEquityLabel) and must stay target-agnostic.
  seedGoal(server, { loanFacts: { ...LOAN_FACTS, depositTarget: 100000 }, homeLoan: { balance: 566000, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Milestone />);
  // The plain equity figure still shows (equity 50000)...
  expect(screen.getByText('$50,000')).toBeTruthy();
  expect(screen.getByText('Equity for your next place')).toBeTruthy();
  expect(screen.getByText(/your LVR × your home's value/)).toBeTruthy();  // milestone's own body
  // ...but NONE of the mortgage card's deposit-target chrome leaks in.
  expect(screen.queryByText(/of .* needed/)).toBeNull();
  expect(screen.queryByText('Set deposit target →')).toBeNull();
  expect(screen.queryByText('50%')).toBeNull();   // no target-derived percentage
  expect(screen.queryByText('$100,000')).toBeNull();  // the target denominator never appears
});
