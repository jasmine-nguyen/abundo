// WHIT-391 GAPS (Goals-hub card, rendered) — the reconcile at the CARD, not just the hero. The diffed
// tests cover the selector + the /mortgage hero, but nothing re-renders the Goals-hub card at a sub-0.5%
// paydown, and the card renders the SAME PayoffSummary via mortgage.paidPctLabel/paidPct. Mirrors
// goalsHubRichGaps.screen's harness exactly (REAL goalView; only useGoalsScreenData + useAppContext
// writer + expo-router mocked), so a floor revert reddens here too.
// WHIT-685: the hub's data comes from the fake server through the real screen data code
// (useGoalsScreenData), so a broken conversion of the server's reply reddens these too.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith, type GoalsHubSeed } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';
import type { LoanFacts } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule(() => mockOpenGoalBalance));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';

const READY_FACTS: LoanFacts = { original: 800000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

const server = installFakeServer();
useTestQueryClient();

// `balances` is account id → live balance (the old balanceFor lookup); an account left out is unpolled.
const seedHub = (over: GoalsHubSeed = {}) => seedHubWith(server, over);

beforeEach(() => {
  resetRouter();
  mockOpenGoalBalance.mockClear();
  resetAuth();
  pinToday(new Date(2026, 6, 11));
  seedHub();
});
afterEach(() => { jest.useRealTimers(); });

describe('WHIT-391 — Goals-hub card at a sub-0.5% paydown', () => {
  // [F9] $1,200 paid of an $800k loan = 0.15% → raw round 0. The card's rich block (testID mortgage-link)
  // must headline "1% gone" next to the "$1,200" figure, never "0% gone". Proves the card floors, not just
  // the hero. Reverting the WHIT-391 floor → "0% gone" and reddens.
  it('[F9] $1,200 paid on $800k → the card reads "$1,200" next to "1% gone", never "0% gone"', async () => {
    seedHub({ loanFacts: READY_FACTS, homeLoan: { balance: 798800, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$1,200')).toBeTruthy();
    expect(card.getByText('1% gone')).toBeTruthy();
    expect(card.queryByText('0% gone')).toBeNull();
    expect(card.getByText('$798,800 to go')).toBeTruthy();
  });

  // [F10] The bar on the card fills to the TRUE 0.15%, not the floored 1% — same honest divergence as the
  // hero. Asserts the serialized card tree carries a "0.15%" width while the words read "1% gone".
  it('[F10] the card bar fills to the true 0.15%, not the floored 1%', async () => {
    seedHub({ loanFacts: READY_FACTS, homeLoan: { balance: 798800, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('1% gone')).toBeTruthy();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('0.15%');
    expect(tree).not.toContain('width":"1%');
  });
});
