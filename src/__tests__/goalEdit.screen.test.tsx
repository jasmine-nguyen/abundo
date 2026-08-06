// WHIT-234 — the real add/edit goal form (fleshes out the WHIT-233 stub). Presses the actual
// screen and asserts the (editId, GoalWriteBody) it hands to the saveGoal writer, so a rewired
// handler or a dropped source arm turns a test red. The writers are mocked at the boundary
// (the optimistic ['goals'] append + rollback are WHIT-233's own provider tests); here we lock
// the SCREEN's contract: field → body mapping, validation gates, create vs edit, delete.
//
// The date picker + safe-area are stubbed globally (jest.setup): the mock picker fires a fixed
// date on press. Platform defaults to iOS, so each DateField renders its picker inline.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';
import type { GoalRecord, AccountBalance } from '../api';

// WHIT-257/264 — override the global fixed-past picker mock (jest.setup fires 20 Jun 2026, which
// the new save-time guard rejects) with the shared configurable one, so the guard tests can drive
// a past/today date and the happy paths a future one. See support/mockDatePicker.
jest.mock('@react-native-community/datetimepicker', () => require('./support/mockDatePicker').mockDatePickerModule());
import { setPickedDate, resetPickedDate, FUTURE, FUTURE_ISO } from './support/mockDatePicker';

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
  useRecentTransactionsScreenData: () => ({ transactions: mockTransactions, balances: mockBalances }),
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

// A saved MANUAL grow goal (no account_id — the manual arm). Used by the edit-prefill gap test.
const CASH_POT: GoalRecord = {
  id: 'g2', name: 'Cash pot', icon: 'cash', direction: 'grow',
  target_amount: 5000, target_date: '2027-06-30', baseline: null,
  account_id: null, manual_balance: 800, manual_as_of: '2026-01-15',
};

// A minimally-valid synced GROW create: name + synced acc-1 + $5000 + a date.
function fillValidSyncedGrow(name = 'Holiday') {
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), name);
  fireEvent.press(screen.getByTestId('goal-source-synced'));
  fireEvent.press(screen.getByTestId('goal-account-acc-1'));
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
  setTargetDate();
}

beforeEach(() => {
  // Reset the writer IMPLEMENTATION each test, not just call history: some folded-in tests install
  // a persistent `=> false` impl, which mockClear alone would leak into later tests. `=> true`
  // matches the writers' constructor impl, so this is inert for the existing tests.
  mockSaveGoal.mockClear().mockImplementation(async () => true);
  mockDeleteGoal.mockClear().mockImplementation(async () => true);
  mockShowToast.mockClear();
  mockBack.mockClear();
  mockParams = {};
  mockGoals = [];
  mockBalances = new Map([['acc-1', balance('acc-1', 2500)]]);
  mockTransactions = [{ account_id: 'acc-1', account_name: 'Everyday Savings' }];
  resetPickedDate(); // reset to the future default; a guard test overrides it
});

// Restore any per-test console.error spy even if a test fails mid-body (a trailing mockRestore()
// would be skipped on an earlier assertion failure, leaking the silence into later tests). Targets
// console.error only, so jest.setup's console.warn silence stays intact (no RN warning noise).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

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

// WHIT-249: an UNEXPECTED writer throw (not the normal false/null failure) used to leave the
// visible Save/Delete button stuck disabled — the caller's setSaving(false) sits after the await,
// so a throw skipped it and `saving` stayed true. The handler now resets it in a catch (and
// re-throws so the guard still logs). Fail-on-revert: drop the catch → the 2nd press early-returns
// on the stuck `saving` flag → saveGoal/deleteGoal called only once.
describe('WHIT-249: an unexpected writer throw re-enables the button', () => {
  it('goal-save re-enables so a retry runs after saveGoal throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockParams = { id: 'g1' };
    mockGoals = [RAINY_DAY];
    mockSaveGoal.mockRejectedValueOnce(new Error('network blew up'));
    render(<GoalEdit />);

    await press('goal-save'); // 1st: throws → guard logs → button must re-enable
    await press('goal-save'); // 2nd: only fires if `saving` was reset
    expect(mockSaveGoal).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled();
  });

  it('goal-delete re-enables so a retry runs after deleteGoal throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockParams = { id: 'g1' };
    mockGoals = [RAINY_DAY];
    mockDeleteGoal.mockRejectedValueOnce(new Error('network blew up'));
    render(<GoalEdit />);

    await press('goal-delete');
    await press('goal-delete');
    expect(mockDeleteGoal).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled();
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

// WHIT-257 — a save-time guard backs up the picker's minimumDate: if a platform lets a past date
// through at pick time, the save is still blocked. Scoped to a CHANGED date so editing an already-
// overdue goal (whose past date was saved earlier) isn't blocked.
describe('WHIT-257: save-time future-date guard on the target date', () => {
  const fillSyncedGrow = () => {
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Trip');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
  };

  it('a freshly-picked PAST target date is rejected with a toast, no save', async () => {
    setPickedDate(new Date(2020, 0, 1)); // definitively past
    render(<GoalEdit />);
    fillSyncedGrow();
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Pick a target date in the future.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  it('a target date of TODAY is rejected (strictly future, matching minimumDate=tomorrow)', async () => {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    setPickedDate(todayMidnight); // component's `today` is the same real day → today !> today
    render(<GoalEdit />);
    fillSyncedGrow();
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Pick a target date in the future.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  it('editing an OVERDUE goal without touching its date still saves (guard bites only changed dates)', async () => {
    const overdue: GoalRecord = { ...RAINY_DAY, id: 'gp', target_date: '2020-01-01' };
    mockParams = { id: 'gp' };
    mockGoals = [overdue];
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByDisplayValue('Rainy day'), 'Renamed');
    await press('goal-save');
    expect(mockShowToast).not.toHaveBeenCalled();
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('gp');
    expect(body).toMatchObject({ name: 'Renamed', target_date: '2020-01-01' });
  });
});

describe('keyboard', () => {
  // The Save/Delete buttons sit at the bottom of the form scroll, so the keyboard opens over
  // them. The scroll must inset for the keyboard AND keep taps alive, or they're unreachable
  // while typing. Fail-on-revert: drop the props in app/goal/edit.tsx → find() returns undefined.
  it('wraps the form in a keyboard-inset, tap-persisting scroll so Save/Delete stay reachable', () => {
    const { UNSAFE_getAllByType } = render(<GoalEdit />);
    const formScroll = UNSAFE_getAllByType(ScrollView).find(
      (sv) => sv.props.automaticallyAdjustKeyboardInsets === true && sv.props.keyboardShouldPersistTaps === 'handled',
    );
    expect(formScroll).toBeTruthy();
    // Save must live INSIDE that insetted scroll — that's what keeps it reachable over the keyboard.
    expect(formScroll!.findAll((n) => n === screen.getByTestId('goal-save'))).toHaveLength(1);
  });
});

// ===== WHIT-234 adversarial gaps (folded in) — arms the sibling suite above leaves open =====

describe('writer failure does not navigate', () => {
  // [A20] saveGoal → false (server write failed): stay on the form, do NOT router.back.
  it('saveGoal returns false → no back (the writer keeps its own toast)', async () => {
    mockSaveGoal.mockImplementation(async () => false);
    render(<GoalEdit />);
    fillValidSyncedGrow();
    await press('goal-save');

    expect(mockSaveGoal).toHaveBeenCalledTimes(1);
    // Let any (wrongly) scheduled navigation flush before asserting it did NOT happen.
    await act(async () => {});
    expect(mockBack).not.toHaveBeenCalled();
  });

  // [A21] deleteGoal → false: stay on the form, do NOT router.back.
  it('deleteGoal returns false → no back', async () => {
    mockParams = { id: 'g1' };
    mockGoals = [RAINY_DAY];
    mockDeleteGoal.mockImplementation(async () => false);
    render(<GoalEdit />);
    await press('goal-delete');

    expect(mockDeleteGoal).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('edit a MANUAL goal', () => {
  beforeEach(() => { mockParams = { id: 'g2' }; mockGoals = [CASH_POT]; });

  // [A22] Editing a manual goal prefills the manual arm: source=manual (its STARTING BALANCE
  // field renders, seeded), and a save carries manual_balance + manual_as_of, no account_id.
  it('prefills source=manual + starting balance + as-of, and saves the manual arm', async () => {
    render(<GoalEdit />);
    expect(screen.getByText('Edit goal')).toBeTruthy();
    // STARTING BALANCE input only renders when source==='manual' — its value proves the prefill.
    expect(screen.getByDisplayValue('800')).toBeTruthy();

    await press('goal-save');
    expect(mockShowToast).not.toHaveBeenCalled();
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('g2');
    expect(body).toMatchObject({ manual_balance: 800, manual_as_of: '2026-01-15', direction: 'grow' });
    expect(body).not.toHaveProperty('account_id');
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });
});

describe('pay-down baseline on the wrong side is blocked', () => {
  // [A23] A pay-down "starting amount owed" must sit ABOVE the target. baseline <= target is
  // the wrong side (a permanently-0% bar) → toast, no writer. The sibling suite only covers the
  // GROW side (baseline >= target).
  it('pay-down baseline not above the target → toast, no save', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Card');
    fireEvent.press(screen.getByTestId('goal-direction-paydown'));
    fireEvent.press(screen.getByTestId('goal-source-manual'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 2500'), '3000');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 0'), '1000'); // target (pay-down placeholder)
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 500'), '1000'); // baseline == target → not above
    setTargetDate();
    await press('goal-save');

    expect(mockShowToast).toHaveBeenCalledWith('The starting amount should be above your target.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});

describe('the target amount must be a clean number', () => {
  // [A24] A non-numeric amount ("80abc") is rejected — this guards the parseAmount REGEX. A
  // naive parseFloat('80abc') returns 80 and would silently save a $80 goal.
  it('rejects a non-numeric target amount', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Junk');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '80abc');
    setTargetDate();
    await press('goal-save');

    expect(mockShowToast).toHaveBeenCalledWith('Enter a target amount above $0.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  // [A25] A negative amount (a paste past the decimal-pad keyboard) is rejected too.
  it('rejects a negative target amount', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Neg');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '-5');
    setTargetDate();
    await press('goal-save');

    expect(mockShowToast).toHaveBeenCalledWith('Enter a target amount above $0.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});

describe('the icon picker feeds the body', () => {
  // [A26] Tapping a non-default icon changes the icon carried in the saved body (default 'star').
  it('picking "cash" sends icon: "cash"', async () => {
    render(<GoalEdit />);
    fillValidSyncedGrow('Piggy');
    fireEvent.press(screen.getByTestId('goal-icon-cash'));
    await press('goal-save');

    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(body.icon).toBe('cash');
    expect(body.target_date).toMatch(ISO);
  });
});

describe('manual source needs a real starting balance', () => {
  // [A27] Manual source, blank STARTING BALANCE → toast, no writer. (The sibling manual tests
  // always fill it.)
  it('blank manual starting balance → toast, no save', async () => {
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Cash');
    fireEvent.press(screen.getByTestId('goal-source-manual'));
    // leave STARTING BALANCE ('e.g. 2500') blank
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    setTargetDate();
    await press('goal-save');

    expect(mockShowToast).toHaveBeenCalledWith('Enter a starting balance.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});

describe('editing before the cache resolves cannot overwrite the goal', () => {
  // [A28] editId present but the ['goals'] cache hasn't loaded (existing === undefined): a save
  // is a NO-OP — no writer, no toast, no navigation — so the default blank form can't be written
  // over the real goal. The PRIMARY block is the disabled Save button (asserted directly below);
  // onSave's internal `editingUnloaded` early-return is defence-in-depth behind it.
  it('save is a no-op while the edited goal is still loading', async () => {
    mockParams = { id: 'g1' };
    mockGoals = []; // cold cache: g1 not present yet
    render(<GoalEdit />);

    // The button is disabled — that's what stops the blank-over-real save.
    expect(screen.getByTestId('goal-save').props.accessibilityState?.disabled).toBe(true);

    await press('goal-save');
    expect(mockSaveGoal).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('baseline must itself be a clean number', () => {
  // [A29] A garbage baseline ("abc") is rejected before the side check.
  it('non-numeric baseline → toast, no save', async () => {
    render(<GoalEdit />);
    fillValidSyncedGrow('Base');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 500'), 'abc');
    await press('goal-save');

    expect(mockShowToast).toHaveBeenCalledWith('Enter a valid starting amount.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});

// WHIT-257 — the manual "as of" date gets the mirror of the target-date guard: a freshly-picked
// FUTURE as-of is rejected at save (it can only be today or earlier); an untouched one saves.
describe('WHIT-257: save-time guard on the manual as-of date', () => {
  const fillManual = () => {
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Cash');
    fireEvent.press(screen.getByTestId('goal-source-manual'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 2500'), '800');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
  };

  it('a freshly-picked FUTURE as-of date is rejected with a toast, no save', async () => {
    setPickedDate(FUTURE); // future — drives BOTH pickers; target stays valid
    render(<GoalEdit />);
    fillManual();
    // The AS OF field is seeded to today, so on iOS its pill is the first inline picker.
    fireEvent.press(screen.getAllByTestId('mock-datepicker')[0]); // as-of → future
    setTargetDate();                                              // target → future (valid)
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith("The as-of date can't be in the future.");
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  it('a manual goal with the as-of left at today saves fine (the guard allows today)', async () => {
    render(<GoalEdit />);
    fillManual();
    setTargetDate(); // target future; as-of untouched = seeded today
    await press('goal-save');
    expect(mockShowToast).not.toHaveBeenCalled();
    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(body.manual_as_of).toMatch(ISO);
  });
});

// WHIT-257 QA GAPS (adversarial) — the changed-only scoping must still BITE a freshly-changed bad
// date on the EDIT path, and the boundary/ordering/arm-gating the implementer's tests leave open.
describe('WHIT-257 QA gaps: changed-date scoping still bites on the edit path', () => {
  const OVERDUE: GoalRecord = { ...RAINY_DAY, id: 'gp', target_date: '2020-01-01' };

  // [G1] Editing an overdue goal and CHANGING the target to a DIFFERENT past date must REJECT —
  // the changed-only scope is not a blanket "any edit of an overdue goal saves any date".
  it('overdue goal, target CHANGED to a new past date → rejected, no save', async () => {
    setPickedDate(new Date(2019, 5, 15)); // 2019-06-15, past AND != the seeded 2020-01-01
    mockParams = { id: 'gp' };
    mockGoals = [OVERDUE];
    render(<GoalEdit />);
    setTargetDate(); // picks 2019-06-15 → differs from existing.target_date → guard fires
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Pick a target date in the future.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  // [G2] Editing an overdue goal and CHANGING the target to a FUTURE date SAVES with the new date.
  it('overdue goal, target CHANGED to a future date → saves the new date', async () => {
    setPickedDate(FUTURE);
    mockParams = { id: 'gp' };
    mockGoals = [OVERDUE];
    render(<GoalEdit />);
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).not.toHaveBeenCalled();
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('gp');
    expect(body.target_date).toBe(FUTURE_ISO);
  });

  // [G3] Boundary on the EDIT path: changing the target to EXACTLY today is rejected (strictly
  // future). The implementer's today-boundary test is on the CREATE path only.
  it('edit path, target CHANGED to exactly today → rejected (strictly future)', async () => {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    setPickedDate(todayMidnight); // toISODate(today) === component todayISO → today !> today
    mockParams = { id: 'gp' };
    mockGoals = [OVERDUE];
    render(<GoalEdit />);
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Pick a target date in the future.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});

describe('WHIT-257 QA gaps: a synced goal omits manual_as_of and a stale unchanged one is inert', () => {
  // [G4] A SYNCED goal's saved body carries NO manual_as_of (that field belongs to the manual arm),
  // and a stale-but-unchanged as-of on the record doesn't block a rename — the changed-scope keeps
  // it inert. (Arm-placement itself isn't observable here: a synced goal has no AS OF field to
  // change, so manualAsOf can never differ from the seed to reach the guard.)
  it('synced goal with a stale future manual_as_of on the record → saves, body omits manual_as_of', async () => {
    const staleSynced: GoalRecord = { ...RAINY_DAY, id: 'gs', manual_as_of: '2999-01-01' };
    mockParams = { id: 'gs' };
    mockGoals = [staleSynced];
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByDisplayValue('Rainy day'), 'Renamed'); // target untouched
    await press('goal-save');
    expect(mockShowToast).not.toHaveBeenCalled();
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('gs');
    expect(body).toHaveProperty('account_id', 'acc-1');
    expect(body).not.toHaveProperty('manual_as_of'); // synced arm never emits it
  });
});

describe('WHIT-257 QA gaps: guard ordering', () => {
  // [G5] Both a wrong-side baseline AND a freshly-picked past target date are invalid. The target
  // guard runs BEFORE the baseline side-check, so the target-date toast wins. Locks the ordering.
  it('bad baseline + past target date → the target-date toast fires (guard runs first)', async () => {
    setPickedDate(new Date(2020, 0, 1)); // past
    render(<GoalEdit />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), 'Order');
    fireEvent.press(screen.getByTestId('goal-source-synced'));
    fireEvent.press(screen.getByTestId('goal-account-acc-1'));
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
    fireEvent.changeText(screen.getByPlaceholderText('e.g. 500'), '9000'); // baseline > target: wrong side
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Pick a target date in the future.');
    expect(mockShowToast).not.toHaveBeenCalledWith('The starting amount should be below your target.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});
