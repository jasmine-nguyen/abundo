// WHIT-121 (expansion) — GAP tests the implementer's suite misses:
//   1. a11y on BOTH new mortgage-screen error affordances (#4): accessibilityRole/Label/testID on
//      the two Retry buttons + accessibilityLiveRegion on the two error copies. Nothing
//      else asserts these props, so a revert that drops them is currently invisible.
// The old #2 precedence test (facts UNSET beat a balance error) was reversed by WHIT-819:
// errors now come first, locked in whit819LoanFactsLoading.screen.test.tsx.
// WHIT-685: drawn over the fake server; a failed read is a 500 from it, so the real screen data
// code decides the error flags.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({})));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

// #4 — the hero balance-error Retry must be a labelled button and its copy a live region.
// Asserting the actual props (not just presence) fails-on-revert if the a11y attributes
// are stripped. facts SET + a failed balance read so we land on the error hero.
it('WHIT-121 #4: the hero balance-error Retry + copy carry the a11y props', async () => {
  seedGoal(server);
  server.fail('/homeloan', 500);
  await renderWithQueries(<Mortgage />);

  const retry = screen.getByTestId('hero-balance-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your balance');

  expect(screen.getByText("Couldn't load your balance.").props.accessibilityLiveRegion).toBe('polite');
});

// #4 — same for the repayment card's error affordance. A failed repayment read so we land
// on the repayment error branch (not the real card, not the empty state).
it('WHIT-121 #4: the repayment-error Retry + copy carry the a11y props', async () => {
  seedGoal(server);
  server.fail('/repayment', 500);
  await renderWithQueries(<Mortgage />);

  const retry = screen.getByTestId('repayment-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your last repayment');

  expect(screen.getByText("Couldn't load your last repayment.").props.accessibilityLiveRegion).toBe('polite');
});
