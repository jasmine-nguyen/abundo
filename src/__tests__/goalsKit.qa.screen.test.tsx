// WHIT-685 slice 1 — QA: the shared Goals kit is faithful to the old makeGoalData fakes through the
// REAL screen data hooks, and the mortgage / milestone screens behave over the fake server in the
// states the moved suites don't reach (a held first balance load, a Retry that actually recovers,
// a failed milestones read, a background refetch under the editor).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { makeGoalData, LOAN_FACTS } from './factory';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, WithQueries } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal, seedGoalsHub } from './support/goalsScreen';
import { queryClient } from '../queryClient';
import { useGoalScreenData, useGoalsScreenData, type GoalScreenData, type GoalsScreenData } from '../queries';
import type { GoalRecord, MilestoneRecord } from '../api';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockSaveMilestones = jest.fn(async (_rows: MilestoneRecord[]) => true);
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ saveMilestones: mockSaveMilestones, showToast: jest.fn() }) };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Mortgage from '../../app/mortgage';
import Milestone from '../../app/milestone';
import MilestoneEdit from '../../app/milestone/edit';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  mockPush.mockClear();
  mockSaveMilestones.mockClear();
});

const AS_OF = '2026-07-04T00:24:37.614Z';
const SAVED_PLAN: MilestoneRecord[] = [
  { id: 'a', label: 'Start', targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

let goal: GoalScreenData;
function GoalProbe() {
  goal = useGoalScreenData();
  return null;
}
let hub: GoalsScreenData;
function HubProbe() {
  hub = useGoalsScreenData();
  return null;
}

describe('the kit matches the old makeGoalData fakes through the real screen data code', () => {
  // [A1] defaults move over one for one: seedGoal() with no overrides gives the screens exactly
  // what makeGoalData() used to hand them.
  it('[A1] seedGoal() defaults read back as makeGoalData() defaults', async () => {
    seedGoal(server);
    await renderWithQueries(<GoalProbe />);
    const old = makeGoalData();
    expect(goal.loanFacts).toEqual(old.loanFacts);
    expect(goal.homeLoan).toEqual(old.homeLoan);
    expect(goal.repayment).toEqual(old.repayment);
    expect(goal.milestones).toEqual(old.milestones);
    expect(goal.homeLoanError).toBe(false);
    expect(goal.repaymentError).toBe(false);
    expect(goal.isError).toBe(false);
    expect(goal.isLoading).toBe(false);
  });

  // [A2] the app-shaped overrides tests pass in read back unchanged (homeLoan.asOf survives the
  // as_of wire hop).
  it('[A2] seedGoal() overrides read back as the same app-shaped values', async () => {
    const over = {
      loanFacts: { ...LOAN_FACTS, depositTarget: 100000 },
      homeLoan: { balance: 566000, asOf: AS_OF },
      repayment: { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 },
      milestones: SAVED_PLAN,
    };
    seedGoal(server, over);
    await renderWithQueries(<GoalProbe />);
    const old = makeGoalData(over);
    expect(goal.loanFacts).toEqual(old.loanFacts);
    expect(goal.homeLoan).toEqual(old.homeLoan);
    expect(goal.repayment).toEqual(old.repayment);
    expect(goal.milestones).toEqual(old.milestones);
  });

  // [A3] seedGoalsHub turns the old balanceFor lookup into the /accounts/balances list the real
  // hook maps back: a seeded account reads its amount (sign kept), an unknown one reads null.
  it('[A3] seedGoalsHub() balances come back through balanceFor; a missing account is null', async () => {
    const goals: GoalRecord[] = [
      { id: 'g1', name: 'Holiday', icon: '🏖️', direction: 'grow', target_amount: 5000, target_date: '2027-01-01', account_id: 'acc-1' },
    ];
    const payCycle = { length: 7, last_pay_date: '2026-06-30' };
    seedGoalsHub(server, {
      goals,
      payCycle,
      balances: { 'acc-1': 1234.5, 'acc-loan': -250000 },
      homeLoan: { balance: 432900, asOf: AS_OF },
    });
    await renderWithQueries(<HubProbe />);
    expect(hub.balanceFor('acc-1')).toBe(1234.5);
    expect(hub.balanceFor('acc-loan')).toBe(-250000);
    expect(hub.balanceFor('acc-missing')).toBeNull();
    expect(hub.goals).toEqual(goals);
    expect(hub.payCycle).toEqual(payCycle);
    expect(hub.loanFacts).toEqual(LOAN_FACTS);
    expect(hub.homeLoan).toEqual({ balance: 432900, asOf: AS_OF });
    expect(hub.isError).toBe(false);
    expect(hub.mortgageError).toBe(false);
  });

  // [A4] seedGoalsHub with no overrides: an empty hub, not an error.
  it('[A4] seedGoalsHub() defaults give an empty, loaded hub', async () => {
    seedGoalsHub(server);
    await renderWithQueries(<HubProbe />);
    expect(hub.goals).toEqual([]);
    expect(hub.balanceFor('anything')).toBeNull();
    expect(hub.homeLoan).toEqual({ balance: null, asOf: null });
    expect(hub.isLoading).toBe(false);
    expect(hub.isError).toBe(false);
  });
});

describe('the mortgage and milestone screens over the fake server', () => {
  // [A5] the balance's FIRST load still in flight: the waiting copy, never the error or a number.
  it('[A5] mortgage hero waits (no error, no balance) while the first balance read is held, then shows it', async () => {
    seedGoal(server, { homeLoan: { balance: 432900, asOf: AS_OF } });
    const held = server.hold('/homeloan');
    render(<WithQueries><Mortgage /></WithQueries>);
    await waitFor(() => expect(screen.getByText("We'll show your payoff progress once your balance loads.")).toBeTruthy());
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
    expect(screen.queryByText('$67,100')).toBeNull();

    await act(async () => { held.release(); });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await refreshInAct(() => {});
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.queryByText("We'll show your payoff progress once your balance loads.")).toBeNull();
  });

  // [A6] same on the milestone screen.
  it('[A6] milestone hero shows "Fetching your live balance…" while the first balance read is held', async () => {
    seedGoal(server, { homeLoan: { balance: 596642.43, asOf: AS_OF } });
    const held = server.hold('/homeloan');
    render(<WithQueries><Milestone /></WithQueries>);
    await waitFor(() => expect(screen.getByText('Fetching your live balance…')).toBeTruthy());
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();

    await act(async () => { held.release(); });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await refreshInAct(() => {});
    expect(screen.getByText('$596,642')).toBeTruthy();
  });

  // [A7] Retry doesn't just re-ask: once the server answers, the error goes and the balance shows.
  it('[A7] mortgage hero Retry after a failed first load recovers to the real balance', async () => {
    seedGoal(server, { homeLoan: { balance: 432900, asOf: AS_OF } });
    server.once('GET', '/homeloan', { status: 500 });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();

    await refreshInAct(() => fireEvent.press(screen.getByTestId('hero-balance-retry')));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await refreshInAct(() => {});
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
    expect(screen.getByText('$67,100')).toBeTruthy();
  });

  // [A8] the milestone screen's own Retry recovers too.
  it('[A8] milestone hero Retry after a failed first load recovers to the real balance', async () => {
    seedGoal(server, { homeLoan: { balance: 596642.43, asOf: AS_OF } });
    server.once('GET', '/homeloan', { status: 500 });
    await renderWithQueries(<Milestone />);
    expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();

    await refreshInAct(() => fireEvent.press(screen.getByTestId('milestone-balance-retry')));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await refreshInAct(() => {});
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
    expect(screen.getByText('$596,642')).toBeTruthy();
  });

  // [A9] the repayment card's Retry recovers to the real card.
  it('[A9] repayment Retry after a failed first load shows the real repayment card', async () => {
    seedGoal(server, { repayment: { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 } });
    server.once('GET', '/repayment', { status: 500 });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();

    await refreshInAct(() => fireEvent.press(screen.getByTestId('repayment-retry')));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await refreshInAct(() => {});
    expect(screen.queryByText("Couldn't load your last repayment.")).toBeNull();
    expect(screen.getByText('$1,268 principal · $232 interest')).toBeTruthy();
  });

  // [A10] milestones are SECONDARY: a failed plan read never blanks the balance hero or shows a
  // balance error; the Sprint summary falls back to the "set your milestones" invite.
  it('[A10] a failed milestones read keeps the mortgage balance and shows the set-milestones invite', async () => {
    seedGoal(server, { homeLoan: { balance: 432900, asOf: AS_OF } });
    server.fail('/milestones', 500);
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
    expect(screen.getByText('Set your payoff milestones')).toBeTruthy();
  });

  // [A10b] the same with the balance not polled yet (null): the hero must stay on the waiting copy,
  // the only state where a milestones failure leaking into the balance error would show.
  it('[A10b] a failed milestones read never turns the waiting balance hero into a balance error', async () => {
    seedGoal(server, { homeLoan: { balance: null, asOf: null } });
    server.fail('/milestones', 500);
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText("We'll show your payoff progress once your balance loads.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
  });

  // [A11] a cached real balance survives a later null ("not polled") reply — keep-last-good, seen
  // on screen rather than only in the hook.
  it('[A11] a later null balance reply keeps the loaded balance on the mortgage hero', async () => {
    seedGoal(server, { homeLoan: { balance: 432900, asOf: AS_OF } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('$67,100')).toBeTruthy();

    seedGoal(server, { homeLoan: { balance: null, asOf: null } });
    await refreshInAct(() => queryClient.refetchQueries());
    expect(server.sent('GET', '/homeloan')).toHaveLength(2);
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.queryByText("We'll show your payoff progress once your balance loads.")).toBeNull();
  });
});

describe('the milestone editor over the fake server', () => {
  const labelAt = (i: number) => screen.getByTestId(`milestone-label-${i}`).props.value;

  // [A12] the seeded latch: once rows are filled from the saved plan, a background refetch that
  // brings a different plan must not wipe the user's edits.
  it('[A12] a background refetch after hydration does not overwrite the rows being edited', async () => {
    server.seed('/milestones', SAVED_PLAN);
    await renderWithQueries(<MilestoneEdit />);
    expect(labelAt(0)).toBe('Start');
    fireEvent.changeText(screen.getByTestId('milestone-label-0'), 'Typed');

    server.seed('/milestones', [{ id: 'z', label: 'Server', targetBalance: 50000, targetDate: '2030-01-01' }]);
    await refreshInAct(() => queryClient.refetchQueries());
    expect(server.sent('GET', '/milestones')).toHaveLength(2);
    expect(labelAt(0)).toBe('Typed');
    expect(labelAt(1)).toBe('Midway');
  });

  // [A13] a held cold load that then FAILS keeps save blocked (no default plan written over a real one).
  it('[A13] a cold load that ends in a failure keeps save blocked', async () => {
    const held = server.hold('/milestones');
    render(<WithQueries><MilestoneEdit /></WithQueries>);
    await act(async () => { held.fail('GET', { status: 500 }); });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await refreshInAct(() => {});
    // The blank row would fail validation anyway, so the Save button's own disabled state is what
    // proves the unresolved-plan guard (not just the ordering check).
    expect(screen.getByTestId('milestone-save')).toBeDisabled();
    fireEvent.changeText(screen.getByTestId('milestone-label-0'), 'Mine');
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(mockSaveMilestones).not.toHaveBeenCalled();
  });
});
