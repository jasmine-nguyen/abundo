// WHIT-685 QA — the goal add/edit form over the fake server: the read edges the moved suite leaves
// open. Each test drives the REAL useGoalsQuery + useRecentTransactionsScreenData through the real
// api.ts, so a change to how goals, recent transactions or balances reach the form turns one red.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { GoalRecord, AccountBalance } from '../api';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, WithQueries, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { txn } from './factory';
import { queryClient } from '../queryClient';

jest.mock('@react-native-community/datetimepicker', () => require('./support/mockDatePicker').mockDatePickerModule());
import { resetPickedDate } from './support/mockDatePicker';
import { routerSpies, setParams, resetRouter } from './support/routerMock';

const mockSaveGoal = jest.fn(async (_editId: string | null, _body: unknown) => true);
const mockDeleteGoal = jest.fn(async (_id: string) => true);
const mockShowToast = jest.fn();

jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ saveGoal: mockSaveGoal, deleteGoal: mockDeleteGoal, showToast: mockShowToast })));

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import GoalEdit from '../../app/goal/edit';

const RAINY_DAY: GoalRecord = {
  id: 'g1', name: 'Rainy day', icon: 'star', direction: 'grow',
  target_amount: 10000, target_date: '2027-12-31', baseline: null,
  account_id: 'acc-1', manual_balance: null, manual_as_of: null,
};

const balance = (account_id: string, amount: number): AccountBalance => ({
  account_id, amount, available_balance: null, currency: 'AUD', as_of: '2026-07-01', account_type: 'savings',
});

const server = installFakeServer();
useTestQueryClient();

async function press(testID: string) {
  await act(async () => { fireEvent.press(screen.getByTestId(testID)); });
}

const saveDisabled = () => screen.getByTestId('goal-save').props.accessibilityState?.disabled === true;

beforeEach(() => {
  resetAuth();
  mockSaveGoal.mockClear().mockImplementation(async () => true);
  mockDeleteGoal.mockClear().mockImplementation(async () => true);
  mockShowToast.mockClear();
  resetRouter();
  resetPickedDate();
});

afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

describe('the synced-account picker reads balances + recent transactions from the server', () => {
  // [A1] (P0) The options are the accounts with a live balance; the transactions only name them.
  it('lists only accounts with a balance, named from their transactions, with the balance amount', async () => {
    server.seed('/accounts/balances', [balance('acc-1', 2500)]);
    server.seed('/transactions', [
      txn({ transaction_id: 't1', account_id: 'acc-1', account_name: 'Everyday Savings' }),
      txn({ transaction_id: 't2', account_id: 'acc-9', account_name: 'Old Closed Card' }), // no balance → not offered
    ]);
    await renderWithQueries(<GoalEdit />);
    fireEvent.press(screen.getByTestId('goal-source-synced'));

    expect(screen.getByTestId('goal-account-acc-1')).toBeTruthy();
    expect(screen.getByText('Everyday Savings')).toBeTruthy();
    expect(screen.getByText('$2,500')).toBeTruthy();
    expect(screen.queryByTestId('goal-account-acc-9')).toBeNull();
    expect(screen.queryByText('Old Closed Card')).toBeNull();
  });

  // [A2] (P1) The name is the account's most common name across its recent transactions.
  it('names an account by its most common transaction account_name', async () => {
    server.seed('/accounts/balances', [balance('acc-1', 100)]);
    server.seed('/transactions', [
      txn({ transaction_id: 't1', account_id: 'acc-1', account_name: 'Bills' }),
      txn({ transaction_id: 't2', account_id: 'acc-1', account_name: 'Bills Account' }),
      txn({ transaction_id: 't3', account_id: 'acc-1', account_name: 'Bills Account' }),
    ]);
    await renderWithQueries(<GoalEdit />);
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    expect(screen.getByText('Bills Account')).toBeTruthy();
    expect(screen.queryByText('Bills')).toBeNull();
  });

  // [A3] (P0) A failed transactions read still offers every balance account, under its tidied id.
  it('when GET /transactions fails, still lists the balance accounts under their tidied ids', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    server.seed('/accounts/balances', [balance('acc-1', 2500)]);
    server.fail('/transactions', 500);
    await renderWithQueries(<GoalEdit />);
    fireEvent.press(screen.getByTestId('goal-source-synced'));

    expect(screen.getByTestId('goal-account-acc-1')).toBeTruthy();
    expect(screen.getByText('Acc 1')).toBeTruthy();
  });

  // [A4] (P1) No balances at all → the "link one, or track manually" hint, no rows.
  it('with no balances on the server shows the no-synced-accounts hint', async () => {
    server.seed('/transactions', [txn({ account_id: 'acc-1', account_name: 'Everyday Savings' })]);
    await renderWithQueries(<GoalEdit />);
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    expect(screen.getByText(/No synced accounts yet/)).toBeTruthy();
    expect(screen.queryByTestId('goal-account-acc-1')).toBeNull();
  });

  // [A5] (P0) Editing a synced goal whose account has no balance this session: the saved account
  // stays selectable (named from transactions, no amount) and the save keeps its account_id.
  it('editing a synced goal whose account has no balance keeps that account selected and saves it', async () => {
    setParams({ id: 'g1' });
    server.seed('/goals', [RAINY_DAY]);
    server.seed('/accounts/balances', [balance('acc-2', 50)]);
    server.seed('/transactions', [txn({ account_id: 'acc-1', account_name: 'Everyday Savings' })]);
    await renderWithQueries(<GoalEdit />);

    expect(screen.getByTestId('goal-account-acc-1')).toBeTruthy();
    expect(screen.getByText('✓ Everyday Savings')).toBeTruthy();
    await press('goal-save');
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('g1');
    expect(body).toMatchObject({ account_id: 'acc-1' });
  });
});

describe('editing waits for the real goals read', () => {
  // [A6] (P0) The goals read FAILS on an edit: Save stays blocked, so the blank form can't be
  // written over the real goal.
  it('when GET /goals fails, the edit form never enables Save and never calls the writer', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setParams({ id: 'g1' });
    server.fail('/goals', 500);
    await renderWithQueries(<GoalEdit />);

    expect(server.sent('GET', '/goals')).toHaveLength(1);
    expect(saveDisabled()).toBe(true);
    await press('goal-save');
    expect(mockSaveGoal).not.toHaveBeenCalled();
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A7] (P1) The edited id isn't in the server's goals (deleted on another device) → Save blocked.
  it('an edit id missing from GET /goals keeps Save blocked', async () => {
    setParams({ id: 'gone' });
    server.seed('/goals', [RAINY_DAY]);
    await renderWithQueries(<GoalEdit />);
    expect(saveDisabled()).toBe(true);
    expect(screen.queryByDisplayValue('Rainy day')).toBeNull();
  });

  // [A8] (P0) The form fills from the goal matching the route id, not the first goal in the list.
  it('prefills from the goal whose id matches, among several', async () => {
    setParams({ id: 'g1' });
    server.seed('/goals', [{ ...RAINY_DAY, id: 'g0', name: 'Holiday', target_amount: 3000 }, RAINY_DAY]);
    await renderWithQueries(<GoalEdit />);
    expect(screen.getByDisplayValue('Rainy day')).toBeTruthy();
    expect(screen.getByDisplayValue('10000')).toBeTruthy();
    expect(screen.queryByDisplayValue('Holiday')).toBeNull();
  });

  // [A9] (P1) A create never waits on the goals read: Save is enabled while /goals is held.
  it('a create keeps Save enabled while GET /goals is still in flight', async () => {
    server.seed('/accounts/balances', [balance('acc-1', 2500)]);
    const held = server.hold('/goals');
    render(<WithQueries><GoalEdit /></WithQueries>);
    expect(saveDisabled()).toBe(false);
    await act(async () => { held.release(); });
    await settle();
  });

  // [A10] (P1) The edited goal disappears on a background refetch: Save blocks again, and the
  // typed values stay on screen (no reset to a blank form).
  it('a refetch that drops the edited goal blocks Save and keeps the typed values', async () => {
    setParams({ id: 'g1' });
    server.seed('/goals', [RAINY_DAY]);
    await renderWithQueries(<GoalEdit />);
    expect(saveDisabled()).toBe(false);
    fireEvent.changeText(screen.getByDisplayValue('Rainy day'), 'Typed');

    server.seed('/goals', []);
    await refreshInAct(() => queryClient.refetchQueries());

    expect(server.sent('GET', '/goals')).toHaveLength(2);
    expect(saveDisabled()).toBe(true);
    expect(screen.getByDisplayValue('Typed')).toBeTruthy();
    await press('goal-save');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  // [A11] (P1) A failed refetch after the goal loaded keeps the cached goal: Save stays enabled.
  it('a failed GET /goals refetch keeps the loaded goal and Save', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setParams({ id: 'g1' });
    server.seed('/goals', [RAINY_DAY]);
    await renderWithQueries(<GoalEdit />);
    server.fail('/goals', 500);
    await refreshInAct(() => queryClient.refetchQueries());

    expect(server.sent('GET', '/goals')).toHaveLength(2);
    expect(saveDisabled()).toBe(false);
    await press('goal-save');
    expect(mockSaveGoal).toHaveBeenCalledTimes(1);
    expect((mockSaveGoal.mock.calls[0] as [string, unknown])[0]).toBe('g1');
  });
});
