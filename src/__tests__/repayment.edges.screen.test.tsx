// WHIT-115 — adversarial GAP screen tests for the mortgage-screen last-repayment card.
// milestone.screen.test.tsx already locks the real card (amount+date+split, no
// "9:02am") and the empty-state copy. This file guards the structural change the
// implementer's tests don't touch: the card was un-gated from g.factsReady — with loan
// facts UNSET it must still render the real card when a repayment exists, i.e. it no
// longer disappears during the "set up your loan" hero state.
// WHIT-685: the loanFacts/homeLoan/repayment come from the fake server through the real
// screen data code.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { EMPTY_LOAN_FACTS, NO_REPAYMENT } from './factory';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

it('renders the last-repayment card even when loan facts are UNSET (un-gated from factsReady)', async () => {
  seedGoal(server, {
    loanFacts: EMPTY_LOAN_FACTS,
    repayment: { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 },
  });
  await renderWithQueries(<Mortgage />);
  // Hero is in its "set up your loan" state...
  expect(screen.getByText('Set up loan details →')).toBeTruthy();
  // ...and the real repayment card is STILL shown alongside it.
  expect(screen.getByText('$1,208 principal · $232 interest')).toBeTruthy();
  expect(screen.getByText('$1,440')).toBeTruthy();
});

// WHIT-121 — the failed-fetch error state. A repayment read that fails leaves repayment at
// NO_REPAYMENT; without the error branch the card would show "No repayment on record yet"
// and falsely tell a user with a repayment they have none. The error+Retry replaces it.
it('shows an error + Retry (not the empty state) when the repayment fetch failed', async () => {
  seedGoal(server, { repayment: NO_REPAYMENT });
  server.fail('/repayment', 500);
  await renderWithQueries(<Mortgage />);
  // The error copy shows; the "no repayment" empty copy must NOT (it would be a lie).
  expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();
  expect(screen.queryByText(/No repayment on record yet/)).toBeNull();
  // Retry asks the server again.
  expect(server.sent('GET', '/repayment')).toHaveLength(1);
  await refreshInAct(() => fireEvent.press(screen.getByText('Retry')));
  expect(server.sent('GET', '/repayment')).toHaveLength(2);
});

// Cache-first: a cached repayment must survive a background-refetch failure. A present
// repayment renders the REAL card (data-first precedence), never the error state — the
// honest thing is to show the last-good value.
it('keeps showing the real repayment card when a refetch fails over cached data', async () => {
  // EMPTY_LOAN_FACTS so the contribution card (which would also print "$1,440" for the
  // default facts) doesn't collide with the repayment amount assertion below.
  seedGoal(server, {
    loanFacts: EMPTY_LOAN_FACTS,
    repayment: { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 },
  });
  await renderWithQueries(<Mortgage />);
  server.fail('/repayment', 500);
  await refreshInAct(() => queryClient.refetchQueries());
  expect(server.sent('GET', '/repayment')).toHaveLength(2);
  expect(screen.getByText('$1,440')).toBeTruthy();
  expect(screen.getByText('$1,208 principal · $232 interest')).toBeTruthy();
  expect(screen.queryByText("Couldn't load your last repayment.")).toBeNull();
});

// WHIT-121 #3 — a SUCCESSFUL fetch that returns a partial payload (amount but null DATE) is
// malformed: the card must show the error branch — NOT the "No repayment" empty lie for data that
// actually exists, and NOT a half-rendered real card. EMPTY_LOAN_FACTS so the contribution card
// can't print "$1,440". Pins the `|| lr.malformed` render clause (fail-on-revert).
it('shows the error branch for a malformed amount-only payload even with NO error flag', async () => {
  seedGoal(server, {
    loanFacts: EMPTY_LOAN_FACTS,
    repayment: { amount: 1440, date: null, principal: null, interest: null },
  });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();
  expect(screen.queryByText(/No repayment on record yet/)).toBeNull();
  expect(screen.queryByText('$1,440')).toBeNull(); // the real card never half-rendered
  expect(screen.getByTestId('repayment-retry')).toBeTruthy();
});

// Simultaneous failures: the hero shows its OWN balance error (WHIT-121 #2) and the repayment card
// its OWN repayment error — two independent affordances, each keyed on its own flag. Guards a
// `repaymentError && !homeLoanError` regression.
it('shows the balance error and the repayment error independently when BOTH reads failed', async () => {
  seedGoal(server);
  server.fail('/homeloan', 500);
  server.fail('/repayment', 500);
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();
  expect(screen.queryByText(/No repayment on record yet/)).toBeNull();
  // The repayment card's OWN Retry (not the hero's) asks the server again.
  await refreshInAct(() => fireEvent.press(screen.getByTestId('repayment-retry')));
  expect(server.sent('GET', '/repayment')).toHaveLength(2);
});
