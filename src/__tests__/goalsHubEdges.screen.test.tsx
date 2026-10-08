// WHIT-233 — Goals hub (app/(tabs)/goals) EDGE coverage the goalsHub suite leaves open.
// Independent of goalsHub.screen.test: same mock scaffold (passthrough ScrollChromeHeader,
// injected useGoalsScreenData, stable router.push) but exercises the card branches the
// happy-path suite doesn't — a paydown with no baseline (progress null but a real pace),
// a goal past its date with no balance yet (still nudged), the singular "1 payday",
// the mortgage card's third branch (balance null, no error), an unknown icon (no crash),
// render order, and url-encoding of a goal id in the edit route. The REAL balanceGoalView
// runs, so a selector revert reddens the %/pace/paydays assertions. Clock pinned to
// Sat 11 Jul 2026 (balanceGoalView reads ambient Date, which fake timers control).
// WHIT-685: the hub's data comes from the fake server through the real screen data code
// (useGoalsScreenData), so a broken conversion of the server's reply reddens these too.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith, type GoalsHubSeed } from './support/goalsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { LOAN_FACTS } from './factory';
import type { GoalRecord, LoanFacts } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';


const server = installFakeServer();
useTestQueryClient();

// `balances` is account id → live balance (the old balanceFor lookup); an account left out is unpolled.
const seedHub = (over: GoalsHubSeed = {}) => seedHubWith(server, over);

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(new Date(2026, 6, 11)); // Sat 11 Jul 2026
  seedHub();
});
afterEach(() => { jest.useRealTimers(); });

describe('goal-card progress edges', () => {
  // [A20] paydown with NO baseline: balanceGoalView.progress is null (no start reference), so
  // there's no % and no "0%" — but the PACE is still known, so the foot shows a real figure,
  // NOT the "Waiting on your balance" copy.
  it('a paydown goal with no baseline shows no % yet still a real pace', async () => {
    const goal: GoalRecord = { id: 'nb', name: 'Credit card', icon: 'cash', direction: 'paydown', target_amount: 0, target_date: '2026-08-15', account_id: null, manual_balance: 9000 };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-nb'));
    expect(card.queryByText(/%$/)).toBeNull();                // progress null -> no headline %
    expect(card.getByText('Set aside $3,000 each payday')).toBeTruthy();   // 9000 owed / 3 paydays
    expect(card.queryByText('Waiting on your balance')).toBeNull();
  });

  // [A21] WHIT-749: a goal past its date whose balance hasn't arrived still gets the calm
  // "pick a new one?" nudge — there's nothing to say it's been met.
  it('a goal past its date with no balance yet still shows the nudge', async () => {
    const goal: GoalRecord = { id: 'od', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-06-01', account_id: 'up-spending' };
    seedHub({ goals: [goal], balances: {} });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-od'));
    expect(card.getByText('Past your date — pick a new one?')).toBeTruthy();
    expect(card.queryByText('Waiting on your balance')).toBeNull();
    expect(card.queryByText('due now')).toBeNull();
  });

  // [A22] exactly one payday left -> singular "1 payday left" (no trailing 's'). Guards the
  // `paydaysLeft === 1 ? '' : 's'` pluralisation the 3-payday happy path can't reach.
  it('pluralises correctly: exactly one payday reads "1 payday left"', async () => {
    const goal: GoalRecord = { id: 'one', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-07-20', account_id: 'up-spending' };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('goal-card-one')).getByText('1 payday left')).toBeTruthy();
  });

  // [A23] an unknown icon name must not crash the card (Icon falls back internally); the card
  // still renders its name + %.
  it('a goal with an unknown icon renders without crashing', async () => {
    const goal: GoalRecord = { id: 'ic', name: 'Mystery', icon: 'not-a-real-icon', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-ic'));
    expect(card.getByText('Mystery')).toBeTruthy();
    expect(card.getByText('40%')).toBeTruthy();
  });

  // [A24] multiple goals render in the order the data supplies them (a stray sort/reverse
  // regression would flip these).
  it('renders multiple goals in data order', async () => {
    const a: GoalRecord = { id: 'aa', name: 'First', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
    const b: GoalRecord = { id: 'bb', name: 'Second', icon: 'car', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
    seedHub({ goals: [a, b] });
    await renderWithQueries(<Goals />);
    const ids = screen.getAllByTestId(/^goal-card-/).map((n) => n.props.testID);
    expect(ids).toEqual(['goal-card-aa', 'goal-card-bb']);
  });
});

describe('mortgage card — the third (null, no-error) branch', () => {
  // [A25] balance null AND no mortgageError: neither "owing" nor the error copy — the honest
  // "Tap to see your payoff plan" waiting copy. The goalsHub suite covers owing + error only.
  it('shows "Tap to see your payoff plan" when the balance is not loaded and there is no error', async () => {
    // Facts set, so a null balance is "waiting", not WHIT-821's "no home loan".
    seedHub({ loanFacts: LOAN_FACTS, homeLoan: { balance: null, asOf: null } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('Tap to see your payoff plan')).toBeTruthy();
    expect(card.queryByText('Tap to open your payoff plan')).toBeNull();
    expect(card.queryByText(/owing/)).toBeNull();
  });
});

describe('navigation — url-encoding of the goal id', () => {
  // [A26] a goal id with reserved characters is percent-encoded into the goal page route, so the
  // param round-trips intact. Guards the encodeURIComponent call.
  it('encodes a goal id that needs escaping', async () => {
    const goal: GoalRecord = { id: 'a b&c', name: 'Weird id', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    fireEvent.press(screen.getByTestId('goal-card-a b&c'));
    expect(routerSpies.push).toHaveBeenCalledWith('/goal/a%20b%26c');
  });
});
