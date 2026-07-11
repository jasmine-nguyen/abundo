// WHIT-234 — the real add/edit goal form (fleshes out the WHIT-233 stub). Presses the actual
// screen and asserts the (editId, GoalWriteBody) it hands to the saveGoal writer, so a rewired
// handler or a dropped source arm turns a test red. The writers are mocked at the boundary
// (the optimistic ['goals'] append + rollback are WHIT-233's own provider tests); here we lock
// the SCREEN's contract: field → body mapping, validation gates, create vs edit, delete.
//
// The date picker + safe-area are stubbed globally (jest.setup): the mock picker fires a fixed
// date on press. Platform defaults to iOS, so each DateField renders its picker inline.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { GoalRecord, AccountBalance } from '../api';

const mockSaveGoal = jest.fn(async (_editId: string | null, _body: unknown) => true);
const mockDeleteGoal = jest.fn(async (_id: string) => true);
const mockShowToast = jest.fn();
const mockBack = jest.fn();

let mockParams: { id?: string };
let mockGoals: GoalRecord[];
let mockBalances: Map<string, AccountBalance>;
let mockTransactions: { account_id: string; account_name: string }[];

// Keep accountSummaries (the real account-name resolver) — only the writers are stubbed.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ saveGoal: mockSaveGoal, deleteGoal: mockDeleteGoal, showToast: mockShowToast }) };
});

jest.mock('../queries', () => ({
  useIsAuthed: () => true,
  useGoalsQuery: () => ({ data: mockGoals }),
  useTransactionsScreenData: () => ({ transactions: mockTransactions, balances: mockBalances }),
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
}));

import GoalEdit from '../../app/goal/edit';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// A saved goal for the edit cases: a grow goal synced to acc-1, $10k by end of 2027.
const RAINY_DAY: GoalRecord = {
  id: 'g1', name: 'Rainy day', icon: 'star', direction: 'grow',
  target_amount: 10000, target_date: '2027-12-31', baseline: null,
  account_id: 'acc-1', manual_balance: null, manual_as_of: null,
};

const balance = (account_id: string, amount: number): AccountBalance => ({
  account_id, amount, available_balance: null, currency: 'AUD', as_of: '2026-07-01', account_type: 'savings',
});

// Fill the target-date field: it starts unset (a "Set date" affordance, testID date-open), so
// reveal the picker first, then tap it — the mock picker emits a fixed date. The target field
// is the last one on screen, so its picker is the last mock-datepicker node.
function setTargetDate() {
  // Platform-agnostic (the `screen` project resolves Platform per worker, so a test can run on
  // an iOS- OR Android-resolving worker): open the picker via the "Set date" affordance when
  // present, then tap the (last = target) mock picker, which emits a fixed date.
  const opens = screen.queryAllByTestId('date-open');
  if (opens.length) fireEvent.press(opens[opens.length - 1]);
  const pickers = screen.getAllByTestId('mock-datepicker');
  fireEvent.press(pickers[pickers.length - 1]);
}

async function press(testID: string) {
  await act(async () => { fireEvent.press(screen.getByTestId(testID)); });
}

beforeEach(() => {
  mockSaveGoal.mockClear();
  mockDeleteGoal.mockClear();
  mockShowToast.mockClear();
  mockBack.mockClear();
  mockParams = {};
  mockGoals = [];
  mockBalances = new Map([['acc-1', balance('acc-1', 2500)]]);
  mockTransactions = [{ account_id: 'acc-1', account_name: 'Everyday Savings' }];
});

describe('create', () => {
  it('a synced grow goal → saveGoal(null, {…account_id}) with no manual arm, then back', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Holiday');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    setTargetDate();
    await press('goal-save');

    expect(mockSaveGoal).toHaveBeenCalledTimes(1);
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBeNull();
    expect(body).toMatchObject({ name: 'Holiday', icon: 'star', direction: 'grow', target_amount: 5000, account_id: 'acc-1', baseline: null });
    expect(body).not.toHaveProperty('manual_balance');
    expect(body.target_date).toMatch(ISO);
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('a manual goal → saveGoal(null, {…manual_balance, manual_as_of}) with no account arm', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Cash pot');
    fireEvent.press(screen.getByTestId('goal-source-manual'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 2500'), '800');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    setTargetDate();
    await press('goal-save');

    expect(mockSaveGoal).toHaveBeenCalledTimes(1);
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBeNull();
    expect(body).toMatchObject({ name: 'Cash pot', manual_balance: 800 });
    expect(body.manual_as_of).toMatch(ISO);
    expect(body).not.toHaveProperty('account_id');
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('a pay-down goal saves with target_amount 0 (debt default) — 0 is valid', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Card');
    fireEvent.press(screen.getByTestId('goal-direction-paydown'));
    fireEvent.press(screen.getByTestId('goal-source-manual'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 2500'), '1200');
    setTargetDate();
    await press('goal-save');

    expect(mockShowToast).not.toHaveBeenCalled();
    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(body).toMatchObject({ direction: 'paydown', target_amount: 0, manual_balance: 1200 });
  });

  it('has no Delete button when creating', () => {
    render(<GoalEdit />);
    expect(screen.queryByTestId('goal-delete')).toBeNull();
  });
});

describe('synced account picker', () => {
  it('lists an account that has a balance but NO transactions (falls back to the id)', () => {
    mockBalances = new Map([['acc-2', balance('acc-2', 999)]]);
    mockTransactions = []; // acc-2 has a live balance but no transaction history yet
    render(<GoalEdit />);
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    const row = screen.getByTestId('goal-account-acc-2');
    expect(row).toBeTruthy();
    expect(screen.getByText('acc-2')).toBeTruthy(); // id fallback name
  });

  it('a manual body carries NO account_id even after an account was picked then switched away', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Mix');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1')); // a synced account IS selected
    fireEvent.press(screen.getByTestId('goal-source-manual')); // …then the source flips to manual
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 2500'), '300');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    setTargetDate();
    await press('goal-save');

    // The body is built from the CHOSEN source's arm, so the stale account pick can't leak in.
    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(body).toHaveProperty('manual_balance', 300);
    expect(body).not.toHaveProperty('account_id');
  });
});

describe('edit', () => {
  beforeEach(() => { mockParams = { id: 'g1' }; mockGoals = [RAINY_DAY]; });

  it('titles the screen "Edit goal" and prefills from the saved goal', () => {
    render(<GoalEdit />);
    expect(screen.getByText('Edit goal')).toBeTruthy();
    expect(screen.getByDisplayValue('Rainy day')).toBeTruthy();
    expect(screen.getByDisplayValue('10000')).toBeTruthy();
  });

  it('saves the edit under the SAME id (upsert, not a new create)', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByDisplayValue('10000'), '20000');
    await press('goal-save');
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('g1');
    expect(body).toMatchObject({ target_amount: 20000, account_id: 'acc-1' });
  });

  it('re-seeds the form when the goals cache resolves a beat after mount', () => {
    mockGoals = []; // cold cache: the goal isn't there yet at first render
    const { rerender } = render(<GoalEdit />);
    expect(screen.queryByDisplayValue('Rainy day')).toBeNull();

    mockGoals = [RAINY_DAY]; // cache lands
    rerender(<GoalEdit />);
    expect(screen.getByDisplayValue('Rainy day')).toBeTruthy();
  });

  it('a background cache refetch does NOT clobber what the user is mid-editing', () => {
    const { rerender } = render(<GoalEdit />);
    fireEvent.changeText(screen.getByDisplayValue('Rainy day'), 'My own edit');

    // A later refetch hands back a fresh record object with server-side values. The re-seed
    // only runs ONCE (on first load), so the in-progress edit must survive.
    mockGoals = [{ ...RAINY_DAY, name: 'Server name' }];
    rerender(<GoalEdit />);

    expect(screen.getByDisplayValue('My own edit')).toBeTruthy();
    expect(screen.queryByDisplayValue('Server name')).toBeNull();
  });

  it('Delete → deleteGoal(id) once, then back', async () => {
    render(<GoalEdit />);
    await press('goal-delete');
    expect(mockDeleteGoal).toHaveBeenCalledTimes(1);
    expect(mockDeleteGoal).toHaveBeenCalledWith('g1');
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });
});

describe('validation blocks the save (toast, no writer call)', () => {
  const fillSyncedBase = () => {
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    setTargetDate();
  };

  it('empty name', async () => {
    render(<GoalEdit />);
    fillSyncedBase();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Give your goal a name.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  it('no balance source chosen', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'X');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith("Choose where this goal's balance comes from.");
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  it('a grow goal with a $0 target', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'X');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '0');
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Enter a target amount above $0.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  it('no target date picked', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'X');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Pick a target date.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  it('a grow baseline that is not below the target', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'X');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 500'), '9000'); // baseline > target
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('The starting amount should be below your target.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});
