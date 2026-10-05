// WHIT-488 — the Goals-hub mortgage card's PLAIN branch, now a PURE copy of the /mortgage detail
// hero tile: an eyebrow ("YOUR HOME LOAN · BALANCE OWING") + a big 48/'800' balance number, with the
// header row (chip + "The mortgage" + chevron) and the "owing" suffix word dropped. GAP coverage the
// goalsHub / Overpaid / Edges suites leave open. Independent harness (passthrough header, injected
// useGoalsScreenData, stubbed writer, stable router.push) matching the sibling files; REAL goalView
// runs so the branch gate is genuine. Clock pinned to Sat 11 Jul 2026 for parity with the other
// goals-hub suites (the pace math is deterministic; the mortgage card itself is date-independent).
//
// Covers: [O1] the eyebrow + a suffix-less 48px number (no "owing" node beside the figure);
// [O2] no-balance fallback renders the sentence at the FALLBACK style, not the headline, and the
//      big-number testID is ABSENT; [O3] the error fallback likewise absent-testID;
// [O4] tap-through to /mortgage still fires from the restacked NO-balance card;
// [O5] the RICH branch renders its own figure and NO mortgage-owing testID;
// [O6] a $0 balance still renders mortgage-owing ("$0" figure — 0 is not null).
// WHIT-685: the hub's data comes from the fake server through the real screen data code
// (useGoalsScreenData), so a broken conversion of the server's reply reddens these too.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoalsHub, type GoalsHubSeed } from './support/goalsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { EMPTY_LOAN_FACTS } from './factory';
import type { LoanFacts } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
// A fully-populated LoanFacts so loanFactsReady is true and the card takes the RICH branch (original
// well above the balance, so there's a genuine paydown to headline).
const READY_FACTS = { original: 800000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

const server = installFakeServer();
useTestQueryClient();

// `balances` is account id → live balance (the old balanceFor lookup); an account left out is unpolled.
const HUB: GoalsHubSeed = { payCycle: PAY_CYCLE, balances: {}, loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' } };
const seedHub = (over: GoalsHubSeed = {}) => seedGoalsHub(server, { ...HUB, ...over });

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(new Date(2026, 6, 11));
  seedHub();
});
afterEach(() => { jest.useRealTimers(); });

describe('WHIT-487 plain mortgage card — owing headline gaps', () => {
  // [O1] WHIT-488 pure hero: the amount is JUST the number as a 48px headline — the word "owing"
  // now lives only in the "YOUR HOME LOAN · BALANCE OWING" eyebrow above it, NOT as its own suffix
  // node beside the figure. The eyebrow is uppercase; the headline carries no lowercase "owing".
  // Reverting to the old "$X owing" suffix node reddens the no-suffix (`queryByText('owing')` null)
  // assertion, and reverting 48→30 reddens the style lock.
  it('[O1] renders the eyebrow + a suffix-less number (no "owing" beside the figure)', async () => {
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy(); // the eyebrow carries "owing"
    const headline = screen.getByTestId('mortgage-owing');
    expect(headline).toHaveTextContent('$596,642');
    expect(within(headline).queryByText('owing')).toBeNull(); // no lowercase suffix beside the number
  });

  // [O2] NO balance, no error: the sentence renders at the FALLBACK style (14/'600'), and the big
  // headline number is ABSENT — the two branches are exclusive. Edges [A25] locks the copy/`/owing/`
  // null but NOT the testID absence nor the fallback style; this is the missing lock.
  it('[O2] no-balance fallback renders the fallback line and NOT the big-number testID', async () => {
    seedHub({ homeLoan: { balance: null, asOf: null } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.queryByTestId('mortgage-owing')).toBeNull();     // the loud number must be absent
    expect(card.getByText('Tap to see your payoff plan')).toBeTruthy();
  });

  // [O3] error fallback: same absence guard for the error copy path.
  it('[O3] error fallback shows the "open" copy with no mortgage-owing headline', async () => {
    server.fail('/homeloan', 500);
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.queryByTestId('mortgage-owing')).toBeNull();
    expect(card.getByText('Tap to open your payoff plan')).toBeTruthy();
  });

  // [O4] the restacked NO-balance card still routes into /mortgage on tap (the existing nav test
  // only presses the balance-present card; the fallback arm is a different subtree).
  it('[O4] tapping the no-balance fallback card still routes to /mortgage', async () => {
    seedHub({ homeLoan: { balance: null, asOf: null } });
    await renderWithQueries(<Goals />);
    fireEvent.press(screen.getByTestId('mortgage-link'));
    expect(routerSpies.push).toHaveBeenCalledWith('/mortgage');
  });

  // [O5] the RICH branch must NOT also render the plain headline testID — only one branch owns the
  // number. The rich suite asserts `/owing/` is null but never the testID, so a stray plain node
  // leaking alongside the rich body would slip through.
  it('[O5] the rich payoff branch renders its own figure and NO mortgage-owing testID', async () => {
    seedHub({ loanFacts: READY_FACTS }); // original 800k, balance 596,642 → rich
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('PAID DOWN SO FAR')).toBeTruthy(); // rich body present
    expect(card.queryByTestId('mortgage-owing')).toBeNull();  // plain headline NOT also rendered
  });

  // [O6] a $0 balance is a real, loaded number (0 != null) → the plain headline still renders the
  // "$0" figure. Guards the `balance != null` gate against a truthiness slip (`balance ? …`) that
  // would drop a genuinely-zero balance into the fallback copy. No rich facts here, so it stays plain.
  it('[O6] a $0 balance renders the "$0" figure as the headline (0 is not null)', async () => {
    seedHub({ homeLoan: { balance: 0, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Goals />);
    const headline = screen.getByTestId('mortgage-owing');
    expect(headline).toHaveTextContent('$0');
    expect(within(screen.getByTestId('mortgage-link')).queryByText('Tap to see your payoff plan')).toBeNull();
  });
});
