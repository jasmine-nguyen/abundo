// WHIT-372 — the Goals-hub mortgage CARD when the balance is ABOVE the original (a redraw/refinance
// that grew the loan). goalsHubRichGaps covers == original [G2] and sub-dollar [G6]; this covers the
// strictly-above case. The card's gate moved from `Math.round(paidDown) > 0` to the shared
// `paidDownReady` — same predicate — so it must STILL fall to the plain "$X owing" line, never an
// incoherent "$1 / 0% gone" rich card. Mirrors goalsHubRichGaps' harness (REAL goalView runs).
// WHIT-685: the hub's data comes from the fake server through the real screen data code
// (useGoalsScreenData), so a broken conversion of the server's reply reddens these too.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { pinToday } from './support/clock';
import { seedGoalsHub, type GoalsHubSeed } from './support/goalsScreen';
import type { LoanFacts } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const READY_FACTS: LoanFacts = { original: 500000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

const server = installFakeServer();
useTestQueryClient();

// The home loan sits $1 ABOVE the original by default. `balances` is account id → live balance (the
// old balanceFor lookup); an account left out is unpolled.
const HUB: GoalsHubSeed = { payCycle: PAY_CYCLE, balances: {}, loanFacts: READY_FACTS, homeLoan: { balance: 500001, asOf: '2026-07-04T00:00:00Z' } };
const seedHub = (over: GoalsHubSeed = {}) => seedGoalsHub(server, { ...HUB, ...over });

beforeEach(() => {
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 11));
  seedHub();
});
afterEach(() => { jest.useRealTimers(); });

describe('WHIT-372 mortgage card — balance above the original', () => {
  it('balance above original → plain "$500,001 owing" line, never a rich "$1 / 0% gone" card', async () => {
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$500,001')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
    expect(card.queryByText('0% gone')).toBeNull();
    expect(card.queryByText('$1')).toBeNull(); // no fmt(-1) leaking as a paid figure
  });
});
