// WHIT-685 slice 1 — acceptance: the shared Goals test kit fills the fake server from the app-shaped
// values the old makeGoalData fakes used, and the real mortgage screen reads them through the real
// screen data code.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { seedGoal } from './support/goalsScreen';
import { SAVED_MILESTONES } from './support/milestonePlan';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').emptyContextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

function MortgageScreen() {
  const Mortgage = require('../../app/mortgage').default;
  return <Mortgage />;
}

describe('the mortgage screen drawn over the fake server with the shared Goals kit', () => {
  it('shows the seeded balance owing and the saved sprint plan through the real screen data code', async () => {
    seedGoal(server, {
      loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null, payoffGoalDate: null },
      homeLoan: { balance: 250000, asOf: '2026-07-04T00:24:37.614Z' },
      milestones: SAVED_MILESTONES,
    });

    await renderWithQueries(<MortgageScreen />);

    expect(await screen.findByText('$250,000')).toBeTruthy();
    expect(screen.getByText('1 of 3 sprints reached')).toBeTruthy();
    expect(screen.getByText('Next: under $200,000')).toBeTruthy();
    expect(server.sent('GET', '/homeloan')).toHaveLength(1);
    expect(server.sent('GET', '/milestones')).toHaveLength(1);
  });
});
