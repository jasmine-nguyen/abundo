// WHIT-488 — the Goals-hub PLAIN mortgage card is now a PURE copy of the /mortgage hero tile:
// an "YOUR HOME LOAN · BALANCE OWING" eyebrow + a big 48px balance (or a fallback line), with the
// old header row (building chip + "The mortgage" title + chevron) and the "owing" suffix DROPPED.
// These are the adversarial GAPS the goalsHub / goalsHubOwing / Overpaid / Edges suites leave open:
//  [H1] the eyebrow renders in the NO-balance plain state (not just the balance state);
//  [H2] the eyebrow renders in the ERROR plain state;
//  [H3] the plain card no longer renders the "The mortgage" header text (regression: a revert leaves it);
//  [H4] the RICH card STILL renders "The mortgage" AND does NOT show the eyebrow (blob/eyebrow must not leak into rich);
//  [H6] case-sensitivity contract: the uppercase eyebrow "…OWING" must NOT satisfy a lowercase /owing/
//       absent-assertion (what Edges [A25] + goalsHub rich rely on), and vice-versa.
// Same independent harness as the sibling goalsHub suites (passthrough header, injected
// useGoalsScreenData, stubbed writer, stable router.push), REAL goalView so the branch gate is genuine.
// WHIT-685: the hub's data comes from the fake server through the real screen data code
// (useGoalsScreenData), so a broken conversion of the server's reply reddens these too.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoalsHub, type GoalsHubSeed } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import type { LoanFacts } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: () => {}, useIsFocused: () => true }));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const EYEBROW = 'YOUR HOME LOAN · BALANCE OWING';
// Fully-populated LoanFacts → loanFactsReady true; original 800k well above the 596,642 balance →
// a genuine paydown → the RICH branch.
const READY_FACTS: LoanFacts = { original: 800000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

const server = installFakeServer();
useTestQueryClient();

// `balances` is account id → live balance (the old balanceFor lookup); an account left out is unpolled.
const HUB: GoalsHubSeed = { payCycle: PAY_CYCLE, balances: {}, loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' } };
const seedHub = (over: GoalsHubSeed = {}) => seedGoalsHub(server, { ...HUB, ...over });

beforeEach(() => {
  resetAuth();
  pinToday(new Date(2026, 6, 11));
  seedHub();
});
afterEach(() => { jest.useRealTimers(); });

describe('WHIT-488 pure-hero plain mortgage card — eyebrow in every plain state', () => {
  // [H1] the eyebrow sits ABOVE the balance conditional, so it must show even when there's no
  // balance and the fallback line renders. goalsHubOwing [O2] locks the fallback style + absent
  // testID but NOT the eyebrow's presence — moving the eyebrow inside `balance != null` would slip
  // through there. Here a no-balance card that lost its eyebrow reddens.
  it('[H1] no-balance fallback still renders the eyebrow above the fallback line', async () => {
    seedHub({ homeLoan: { balance: null, asOf: null } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText(EYEBROW)).toBeTruthy();
    expect(card.getByText('Tap to see your payoff plan')).toBeTruthy();
    expect(card.queryByTestId('mortgage-owing')).toBeNull();
  });

  // [H2] same eyebrow guard for the error path.
  it('[H2] error fallback still renders the eyebrow above the error line', async () => {
    server.fail('/homeloan', 500);
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText(EYEBROW)).toBeTruthy();
    expect(card.getByText('Tap to open your payoff plan')).toBeTruthy();
  });
});

describe('WHIT-488 pure-hero plain mortgage card — old header dropped', () => {
  // [H3] the pure-hero decision drops the chip/title/chevron header. The strongest machine-visible
  // signal is the "The mortgage" TITLE text: the plain card must NOT render it (the rich card owns
  // that title). No sibling suite asserts its ABSENCE in the plain state — reverting to the WHIT-487
  // header row (which re-adds "The mortgage" to the plain card) reddens this.
  it('[H3] the plain balance card does NOT render the "The mortgage" title', async () => {
    await renderWithQueries(<Goals />); // default = plain, balance present
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByTestId('mortgage-owing')).toBeTruthy(); // confirm we're on the plain branch
    expect(card.queryByText('The mortgage')).toBeNull();
  });

  it('[H3b] the plain NO-balance card also does NOT render the "The mortgage" title', async () => {
    seedHub({ homeLoan: { balance: null, asOf: null } });
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).queryByText('The mortgage')).toBeNull();
  });
});

describe('WHIT-488 rich card untouched — keeps its header, no eyebrow leak', () => {
  // [H4] the RICH branch is meant to be untouched: it KEEPS the "The mortgage" header title, and the
  // plain-card eyebrow/blob must NOT leak into it. No existing rich test asserts either the header's
  // presence or the eyebrow's absence — a refactor that dropped the rich header, or that hoisted the
  // eyebrow above the branch (so it shows on BOTH), would pass every current test but reddens here.
  it('[H4] the rich card keeps "The mortgage" and shows neither the eyebrow nor the plain testID', async () => {
    seedHub({ loanFacts: READY_FACTS });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('PAID DOWN SO FAR')).toBeTruthy(); // on the rich branch
    expect(card.getByText('The mortgage')).toBeTruthy();      // rich header retained
    expect(card.queryByText(EYEBROW)).toBeNull();             // plain eyebrow must not leak
    expect(card.queryByTestId('mortgage-owing')).toBeNull();  // plain headline must not leak
  });
});

describe('WHIT-488 eyebrow case-sensitivity contract', () => {
  // [H6] Edges [A25] and the goalsHub rich test both assert `queryByText(/owing/)` is null to prove
  // the plain "owing" suffix is gone. That only holds because the new eyebrow is UPPERCASE "OWING"
  // and the regex has no i-flag. Lock the coupling both ways so a future lower-casing of the eyebrow
  // (which would silently make [A25] start matching the eyebrow and flip its meaning) is caught here.
  it('[H6] the uppercase eyebrow is present but a lowercase /owing/ does NOT match it', async () => {
    seedHub({ homeLoan: { balance: null, asOf: null } }); // no big number, only the eyebrow text
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText(EYEBROW)).toBeTruthy();      // the eyebrow IS on screen
    expect(card.queryByText(/owing/)).toBeNull();       // lowercase, case-sensitive → must NOT match "OWING"
    expect(card.queryByText(/OWING/)).toBeTruthy();     // uppercase DOES match — proves the null above is about case
  });
});
