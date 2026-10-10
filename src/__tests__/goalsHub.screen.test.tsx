// WHIT-233 — the Goals hub screen (app/(tabs)/goals). Locks: the empty state, real goal
// cards (progress %, pace, paydays from the actual balanceGoalView engine over injected
// useGoalsScreenData), the always-present mortgage card (balance / mortgageError / tap-through),
// loading + primary-error states, and every navigation target (the "+" and cards route to
// /goal/edit, the mortgage card to /mortgage). ScrollChromeHeader is mocked to a passthrough
// (its clearance/scroll wiring is covered by tabScreens*); the REAL balanceGoalView runs, so a
// selector revert reddens the % / pace assertions. Clock pinned to Sat 11 Jul 2026 so the
// pay-cycle pace is deterministic (matches the balanceGoal.logic fixtures).
// WHIT-685: the goals, pay cycle, balances and mortgage come from the fake server through the real
// screen data code (useGoalsScreenData), so a broken conversion reddens these too.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, WithQueries, settle, drawHeld, releaseAndSettle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith, type GoalsHubSeed } from './support/goalsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';
import type { GoalRecord, LoanFacts } from '../api';

// Passthrough header so the hub's content (and its `right` action) render without the
// NavBarsProvider the real ScrollChromeHeader needs.
jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule(() => mockOpenGoalBalance));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';

const GROW: GoalRecord = { id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
const PAYDOWN: GoalRecord = { id: 'g2', name: 'Car loan', icon: 'car', direction: 'paydown', target_amount: 0, target_date: '2026-08-15', baseline: 20000, manual_balance: 12000, manual_as_of: '2026-07-01', account_id: null };
// WHIT-296: a fully-populated LoanFacts (all six numbers) so loanFactsReady is true and the
// mortgage card takes its rich payoff branch. `original` sits well above the default balance
// (596,642) so paid-down is a sensible positive figure.
const READY_FACTS = { original: 800000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

const server = installFakeServer();
useTestQueryClient();

// `balances` is account id → live balance (the old balanceFor lookup); an account left out is unpolled.
const seedHub = (over: GoalsHubSeed = {}) => seedHubWith(server, over);

beforeEach(() => {
  resetAuth();
  resetRouter();
  mockOpenGoalBalance.mockClear();
  pinToday(new Date(2026, 6, 11)); // Sat 11 Jul 2026
  seedHub();
});
afterEach(() => { jest.useRealTimers(); });

describe('empty state (WHIT-295: the mortgage IS a goal)', () => {
  it('shows the mortgage as the headline goal + an additive invite — never "No goals yet"', async () => {
    await renderWithQueries(<Goals />);
    expect(screen.getByTestId('mortgage-link')).toBeTruthy(); // the headline goal, always shown
    expect(screen.getByTestId('add-goal-cta')).toBeTruthy();
    // The additive invite replaces the old contradictory "No goals yet" card.
    expect(screen.getByTestId('goals-empty-hint')).toBeTruthy();
    expect(screen.queryByText('No goals yet')).toBeNull();
    expect(screen.queryByTestId('goals-empty')).toBeNull();
  });
});

describe('goal cards (real balanceGoalView)', () => {
  beforeEach(() => { seedHub({ goals: [GROW, PAYDOWN] }); });

  it('renders a grow goal: 40% there, $2,000/payday, 3 paydays left', async () => {
    await renderWithQueries(<Goals />);
    expect(screen.getByText('Emergency fund')).toBeTruthy();
    expect(screen.getByText('Saving toward $10,000 · by Aug 2026')).toBeTruthy();
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getByText('40%')).toBeTruthy();
    expect(card.getByText('Set aside $2,000 each payday')).toBeTruthy();
    expect(card.getByText('3 paydays left')).toBeTruthy();
  });

  it('renders a paydown goal: 40% paid off, $4,000/payday', async () => {
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g2'));
    expect(screen.getByText('Paying down $0 · by Aug 2026')).toBeTruthy();
    expect(card.getByText('40%')).toBeTruthy();
    expect(card.getByText('Set aside $4,000 each payday')).toBeTruthy();
  });

  it('a synced goal with no live balance yet shows no % and a waiting label, not a crash', async () => {
    seedHub({ goals: [GROW], balances: {} }); // account not polled
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.queryByText(/%$/)).toBeNull();
    expect(card.queryByText('—')).toBeNull();
    expect(card.getByText('Waiting on your balance')).toBeTruthy();
  });

  // WHIT-478 / WHIT-813: the checkpoint line names the next unreached step.
  it('shows "Next: <label>" for a goal with checkpoints (grow, balance 4000)', async () => {
    // GROW balance 4000; rungs 2000/4000/6000/8000 → 2000 and 4000 reached.
    const withLadder = { ...GROW, checkpoints: [{ id: 'a', label: 'A', amount: 2000 }, { id: 'b', label: 'B', amount: 4000 }, { id: 'c', label: 'C', amount: 6000 }, { id: 'd', label: 'D', amount: 8000 }] };
    seedHub({ goals: [withLadder] });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getByTestId('goal-checkpoints-g1')).toHaveTextContent('Next: C');
  });

  // WHIT-486: checkpoint dots on the progress bar (bar-dot = hollow/not reached, bar-dot-reached = filled).
  it('renders one dot per checkpoint, filled up to the balance, matching the reached-count', async () => {
    const withLadder = { ...GROW, checkpoints: [{ id: 'a', label: 'A', amount: 2000 }, { id: 'b', label: 'B', amount: 4000 }, { id: 'c', label: 'C', amount: 6000 }, { id: 'd', label: 'D', amount: 8000 }] };
    seedHub({ goals: [withLadder] }); // balance 4000 → 2000 & 4000 reached
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getAllByTestId('bar-dot-reached')).toHaveLength(2);       // filled dots
    expect(card.getAllByTestId('bar-dot')).toHaveLength(2);               // hollow dots
    expect(card.getByTestId('goal-checkpoints-g1')).toHaveTextContent('Next: C'); // agrees
  });

  it('renders no dots (and no count line) for a synced goal not yet polled', async () => {
    const withLadder = { ...GROW, checkpoints: [{ id: 'a', label: 'A', amount: 2000 }] };
    seedHub({ goals: [withLadder], balances: {} }); // not polled
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.queryAllByTestId('bar-dot')).toHaveLength(0);
    expect(card.queryAllByTestId('bar-dot-reached')).toHaveLength(0);
    expect(card.queryByTestId('goal-checkpoints-g1')).toBeNull(); // dots + count travel together
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
});

describe('the mortgage card', () => {
  it('shows the balance owing when the home loan has loaded', async () => {
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('$596,642')).toBeTruthy();
  });

  // [O4] WHIT-821: balance checked but none found + nothing set up → the calm "no home loan" line,
  // no "Tap to see", and the card still routes into /mortgage on tap.
  it('[O4] no home loan: shows the calm line and tapping still routes to /mortgage', async () => {
    seedHub({ homeLoan: { balance: null, asOf: null } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByTestId('mortgage-no-home-loan')).toBeTruthy();
    expect(card.queryByText('Tap to see your payoff plan')).toBeNull();
    fireEvent.press(screen.getByTestId('mortgage-link'));
    expect(routerSpies.push).toHaveBeenCalledWith('/mortgage');
  });

  // WHIT-821: while the balance check is still loading, "no home loan" must not flash — only a
  // check that worked and found nothing says that.
  it('[O4b] balance still loading: no "no home loan" line until the check lands empty', async () => {
    seedHub({ homeLoan: { balance: null, asOf: null } });
    const held = server.hold('/homeloan');
    drawHeld(<Goals />);
    await refreshInAct(() => undefined);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.queryByTestId('mortgage-no-home-loan')).toBeNull();
    expect(card.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();

    await releaseAndSettle(held);
    expect(within(screen.getByTestId('mortgage-link')).getByTestId('mortgage-no-home-loan')).toBeTruthy();
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

// WHIT-296: once loan facts + balance are known the card mirrors the /mortgage hero. Real
// goalView runs (the suite keeps the real selectors), so the payoff numbers are computed for
// real and a selector revert reddens these.
describe('the mortgage card — rich payoff state', () => {
  it('shows the hero payoff detail: paid-down figure, % gone, to-go, and started-at', async () => {
    seedHub({ loanFacts: READY_FACTS }); // original 800k, balance 596,642 → 25% gone
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(card.getByText('$203,358')).toBeTruthy();       // 800,000 − 596,642
    expect(card.getByText('25% gone')).toBeTruthy();        // 203,358 / 800,000
    expect(card.getByText('$596,642 to go')).toBeTruthy();
    expect(card.getByText('started at $800,000')).toBeTruthy();
    expect(card.queryByText(/owing/)).toBeNull();           // no longer the plain line
  });

  it('a balance AT or ABOVE the original shows the plain "owing" line, not a nonsense $0 rich card', async () => {
    // original 500k below the 596,642 balance → no genuine paydown to show; the rich card would
    // read "$0 paid" next to "owe more than you started", so it must fall through to the plain line.
    seedHub({ loanFacts: { ...READY_FACTS, original: 500000 } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$596,642')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
  });

  it('facts ready but balance not loaded yet degrades to the plain "tap to see" line', async () => {
    seedHub({ loanFacts: READY_FACTS, homeLoan: { balance: null, asOf: null } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('Tap to see your payoff plan')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull(); // not the rich state
  });
});

describe('loading + error', () => {
  it('shows a spinner while loading with nothing cached', async () => {
    const held = server.hold('/goals');
    render(<WithQueries><Goals /></WithQueries>);
    expect(screen.getByTestId('goals-loading')).toBeTruthy();
    expect(screen.queryByTestId('goals-empty-hint')).toBeNull();
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.getByTestId('goals-empty-hint')).toBeTruthy());
  });

  it('shows an error + Retry when a PRIMARY read fails with nothing cached', async () => {
    seedHub({ goals: [GROW] });
    server.once('GET', '/goals', { status: 500 });
    await renderWithQueries(<Goals />);
    expect(screen.getByTestId('goals-error')).toBeTruthy();
    await refreshInAct(() => fireEvent.press(screen.getByTestId('goals-retry')));
    await waitFor(() => expect(screen.getByTestId('goal-card-g1')).toBeTruthy());
    expect(server.sent('GET', '/goals')).toHaveLength(2);
  });

  it('keeps showing goals when a refetch fails but rows are cached (cache-first)', async () => {
    seedHub({ goals: [GROW] });
    await renderWithQueries(<Goals />);
    server.fail('/goals', 500);
    await refreshInAct(() => queryClient.refetchQueries());
    await settle();
    expect(server.sent('GET', '/goals')).toHaveLength(2);
    expect(screen.queryByTestId('goals-error')).toBeNull();
    expect(screen.getByTestId('goal-card-g1')).toBeTruthy();
  });
});

describe('navigation', () => {
  beforeEach(() => { seedHub({ goals: [GROW] }); });

  it('the "+" routes to the goal add screen', async () => {
    await renderWithQueries(<Goals />);
    fireEvent.press(screen.getByTestId('add-goal'));
    expect(routerSpies.push).toHaveBeenCalledWith('/goal/edit');
  });

  it('the mortgage card routes to the full mortgage screen', async () => {
    await renderWithQueries(<Goals />);
    fireEvent.press(screen.getByTestId('mortgage-link'));
    expect(routerSpies.push).toHaveBeenCalledWith('/mortgage');
  });
});

describe('manual goal balance (WHIT-235)', () => {
  beforeEach(() => { seedHub({ goals: [GROW, PAYDOWN] }); });

  it('a MANUAL goal shows its "as of" date + an Update balance affordance', async () => {
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g2'));
    expect(card.getByText('Balance as of 1 Jul 2026')).toBeTruthy();
    expect(card.getByTestId('goal-balance-g2')).toBeTruthy();
  });

  it('tapping Update balance opens the balance sheet for that goal', async () => {
    await renderWithQueries(<Goals />);
    fireEvent.press(screen.getByTestId('goal-balance-g2'));
    expect(mockOpenGoalBalance).toHaveBeenCalledWith('g2');
    // (The card-body-still-navigates complement is goalsHubBalanceGaps [A17]; RNTL never bubbles
    // an inner press to the parent, so asserting "no push" here would pass tautologically.)
  });
});

// ===== WHIT-235 (folded from goalsHubBalanceGaps.screen.test.tsx) =====
// GAP tests for the manual-balance affordance: the stale BOUNDARY (30 vs 31 days), a manual goal
// with NO as-of date ("Balance not set"), and the regression that tapping the card BODY of a
// manual goal still routes to edit despite the nested "Update balance" button. Same harness
// (identical mocks + baseData), so these run at module scope alongside the suite above.

// [A14] the stale threshold is "> 30 days". Exactly 30 days old must NOT flag; 31 days must. The
// implementer only tested 71 days (stale) and 10 days (fresh) — neither pins the boundary, so an
// off-by-one (>= vs >) would pass their suite. 2026-06-11 is 30 days before the pinned clock.
it('does NOT flag a balance exactly 30 days old (boundary, not > 30)', async () => {
  seedHub({ goals: [{ ...PAYDOWN, id: 'g30', manual_as_of: '2026-06-11' }] });
  await renderWithQueries(<Goals />);
  expect(within(screen.getByTestId('goal-card-g30')).queryByText('Haven’t updated in a while')).toBeNull();
});

// [A15] the matching over-boundary case.
it('flags a balance 31 days old (just over the boundary)', async () => {
  seedHub({ goals: [{ ...PAYDOWN, id: 'g31', manual_as_of: '2026-06-10' }] });
  await renderWithQueries(<Goals />);
  expect(within(screen.getByTestId('goal-card-g31')).getByText('Haven’t updated in a while')).toBeTruthy();
});

// [A1] WHIT-797: the stale age counts whole UTC days, so the Melbourne spring-forward (4 Oct 2026,
// a 23-hour day) between the as-of date and today can't shave a day off. 31 calendar days must
// still flag; a local-midnight subtraction floors 30.96 days to 30 and wrongly drops the tag.
it('flags a balance 31 days old across the daylight-saving spring-forward', async () => {
  pinToday(new Date(2026, 9, 5)); // Mon 5 Oct 2026, the day after clocks go forward
  seedHub({ goals: [{ ...PAYDOWN, id: 'gdst', manual_as_of: '2026-09-04' }] });
  await renderWithQueries(<Goals />);
  expect(within(screen.getByTestId('goal-card-gdst')).getByText('Haven’t updated in a while')).toBeTruthy();
});

// [A16] a manual goal with NO as-of date shows "Balance not set" (never a crash / blank / "as of
// undefined") and is not flagged stale. balanceIsStale(null) short-circuits to false.
it('a manual goal with a null as-of shows "Balance not set" and no stale tag', async () => {
  seedHub({ goals: [{ ...PAYDOWN, id: 'gnull', manual_as_of: null }] });
  await renderWithQueries(<Goals />);
  const card = within(screen.getByTestId('goal-card-gnull'));
  expect(card.getByText('Balance not set')).toBeTruthy();
  expect(card.queryByText(/Balance as of/)).toBeNull();
  expect(card.queryByText('Haven’t updated in a while')).toBeNull();
});

describe('secondary reads degrade one card, never the hub', () => {
  // [A1b] with no goals the hub error would show if a secondary read counted as primary.
  it('failed balances, home loan and loan facts reads with no goals still show the invite, not the hub error', async () => {
    server.fail('/accounts/balances', 500);
    server.fail('/homeloan', 500);
    server.fail('/loanfacts', 500);
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('goals-error')).toBeNull();
    expect(screen.getByTestId('goals-empty-hint')).toBeTruthy();
    expect(within(screen.getByTestId('mortgage-link')).getByText('Tap to open your payoff plan')).toBeTruthy();
  });

  // [A4] a slow home loan never holds the hub on the spinner.
  it('a held home loan read leaves the goals drawn and the mortgage card on its waiting line', async () => {
    seedHub({ goals: [GROW] });
    const held = server.hold('/homeloan');
    render(<WithQueries><Goals /></WithQueries>);
    await waitFor(() => expect(screen.getByTestId('goal-card-g1')).toBeTruthy());
    expect(screen.queryByTestId('goals-loading')).toBeNull();
    expect(within(screen.getByTestId('mortgage-link')).getByText('Tap to see your payoff plan')).toBeTruthy();
    await act(async () => { held.release(); });
    await waitFor(() => expect(within(screen.getByTestId('mortgage-link')).getByText('$596,642')).toBeTruthy());
  });

  // [A5] mortgageError is first-load only: a cached balance survives a failed refetch.
  it('a cached home loan balance survives a failed refetch (no "Tap to open" error copy)', async () => {
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('$596,642')).toBeTruthy();
    server.fail('/homeloan', 500);
    await refreshInAct(() => queryClient.refetchQueries());
    await settle();
    expect(server.sent('GET', '/homeloan')).toHaveLength(2);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$596,642')).toBeTruthy();
    expect(card.queryByText('Tap to open your payoff plan')).toBeNull();
  });

  // [A8] a balance change on the server reaches the card after a refresh (no stale lookup).
  it('a refreshed balance updates the synced goal card', async () => {
    seedHub({ goals: [GROW] });
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('goal-card-g1')).getByText('40%')).toBeTruthy();
    seedHub({ goals: [GROW], balances: { 'up-spending': 7000 } });
    await refreshInAct(() => queryClient.invalidateQueries());
    await waitFor(() => expect(within(screen.getByTestId('goal-card-g1')).getByText('70%')).toBeTruthy());
  });
});

describe('the pay cycle is a primary read', () => {
  // [A2] a pay cycle failure with nothing cached shows the hub error + Retry.
  it('a failed pay cycle read with no goals shows the error + Retry', async () => {
    server.fail('/paycycle', 500);
    await renderWithQueries(<Goals />);
    expect(screen.getByTestId('goals-error')).toBeTruthy();
    expect(screen.getByTestId('goals-retry')).toBeTruthy();
  });

  // [A3] a held pay cycle keeps the spinner up until it lands.
  it('a held pay cycle read shows the spinner until it lands', async () => {
    const held = server.hold('/paycycle');
    render(<WithQueries><Goals /></WithQueries>);
    await waitFor(() => expect(queryClient.isFetching()).toBe(1)); // every read but the pay cycle has landed
    expect(screen.getByTestId('goals-loading')).toBeTruthy();
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.getByTestId('goals-empty-hint')).toBeTruthy());
    expect(screen.queryByTestId('goals-loading')).toBeNull();
  });

  // [A9] the server's pay cycle drives the pace (weekly → more paydays → smaller step).
  it('a weekly pay cycle from the server changes the per-payday pace', async () => {
    seedHub({ goals: [GROW], payCycle: { length: 7, last_pay_date: '2026-07-04' } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.queryByText('Set aside $2,000 each payday')).toBeNull(); // the fortnightly figure
    expect(card.getByText('5 paydays left')).toBeTruthy();  // weekly from Jul 4, as the real engine counts them to Aug 15
    expect(card.getByText('Set aside $1,200 each payday')).toBeTruthy(); // 6,000 over 5 paydays
  });
});

describe('Retry refreshes every read', () => {
  // [A7] Retry fires the secondary reads too, so a failed balance comes back with it.
  it('Retry after a first-load failure refetches goals, pay cycle, balances, home loan and loan facts', async () => {
    seedHub({ goals: [GROW] });
    server.once('GET', '/goals', { status: 500 });
    await renderWithQueries(<Goals />);
    expect(screen.getByTestId('goals-error')).toBeTruthy();
    await refreshInAct(() => fireEvent.press(screen.getByTestId('goals-retry')));
    await waitFor(() => expect(screen.getByTestId('goal-card-g1')).toBeTruthy());
    for (const path of ['/goals', '/paycycle', '/accounts/balances', '/homeloan', '/loanfacts']) {
      expect(server.sent('GET', path).length).toBeGreaterThanOrEqual(2);
    }
  });
});
