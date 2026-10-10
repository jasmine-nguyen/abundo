// WHIT-234 — the real add/edit goal form (fleshes out the WHIT-233 stub). Presses the actual
// screen and asserts the (editId, GoalWriteBody) it hands to the saveGoal writer, so a rewired
// handler or a dropped source arm turns a test red. The writers are mocked at the boundary
// (the optimistic ['goals'] append + rollback are WHIT-233's own provider tests); here we lock
// the SCREEN's contract: field → body mapping, validation gates, create vs edit, delete.
//
// The date picker + safe-area are stubbed globally (jest.setup): the mock picker fires a fixed
// date on press. Platform defaults to iOS, so each DateField renders its picker inline.
//
// WHIT-685: the goals, recent transactions and balances come from the fake server through the real
// screen data code (useGoalsQuery + useRecentTransactionsScreenData).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { GoalRecord, AccountBalance } from '../api';
import type { Transaction } from '../types';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, WithQueries, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { txn } from './factory';
import { queryClient } from '../queryClient';

// WHIT-257/264 — override the global fixed-past picker mock (jest.setup fires 20 Jun 2026, which
// the new save-time guard rejects) with the shared configurable one, so the guard tests can drive
// a past/today date and the happy paths a future one. See support/mockDatePicker.
jest.mock('@react-native-community/datetimepicker', () => require('./support/mockDatePicker').mockDatePickerModule());
import { setPickedDate, resetPickedDate, FUTURE } from './support/mockDatePicker';
import { routerSpies, setParams, resetRouter } from './support/routerMock';

const mockSaveGoal = jest.fn(async (_editId: string | null, _body: unknown) => true);
const mockDeleteGoal = jest.fn(async (_id: string) => true);
const mockShowToast = jest.fn();

let goals: GoalRecord[];
let balances: AccountBalance[];
let transactions: Transaction[];

// Keep accountSummaries (the real account-name resolver) — only the writers are stubbed.
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ saveGoal: mockSaveGoal, deleteGoal: mockDeleteGoal, showToast: mockShowToast })));

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

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

const server = installFakeServer();
useTestQueryClient();

function seedServer() {
  server.seed('/goals', goals);
  server.seed('/transactions', transactions);
  server.seed('/accounts/balances', balances);
}

function renderForm() {
  seedServer();
  return renderWithQueries(<GoalEdit />);
}

async function press(testID: string) {
  await act(async () => { fireEvent.press(screen.getByTestId(testID)); });
}

const saveDisabled = () => screen.getByTestId('goal-save').props.accessibilityState?.disabled === true;

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
  resetAuth();
  // Reset the writer IMPLEMENTATION each test, not just call history: some folded-in tests install
  // a persistent `=> false` impl, which mockClear alone would leak into later tests. `=> true`
  // matches the writers' constructor impl, so this is inert for the existing tests.
  mockSaveGoal.mockClear().mockImplementation(async () => true);
  mockDeleteGoal.mockClear().mockImplementation(async () => true);
  mockShowToast.mockClear();
  resetRouter();
  goals = [];
  balances = [balance('acc-1', 2500)];
  transactions = [txn({ account_id: 'acc-1', account_name: 'Everyday Savings' })];
  resetPickedDate(); // reset to the future default; a guard test overrides it
});

// Restore any per-test console.error spy even if a test fails mid-body (a trailing mockRestore()
// would be skipped on an earlier assertion failure, leaking the silence into later tests). Targets
// console.error only, so jest.setup's console.warn silence stays intact (no RN warning noise).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

describe('create', () => {
  it('a synced grow goal → saveGoal(null, {…account_id}) with no manual arm, then back', async () => {
    await renderForm();
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
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
  });

  it('a manual goal → saveGoal(null, {…manual_balance, manual_as_of}) with no account arm', async () => {
    await renderForm();
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
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
  });

  it('a pay-down goal saves with target_amount 0 (debt default) — 0 is valid', async () => {
    await renderForm();
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
});

describe('synced account picker', () => {
  it('a manual body carries NO account_id even after an account was picked then switched away', async () => {
    await renderForm();
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
  beforeEach(() => { setParams({ id: 'g1' }); goals = [RAINY_DAY]; });

  it('saves the edit under the SAME id (upsert, not a new create)', async () => {
    await renderForm();
    fireEvent.changeText(screen.getByDisplayValue('10000'), '20000');
    await press('goal-save');
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('g1');
    expect(body).toMatchObject({ target_amount: 20000, account_id: 'acc-1' });
  });

  // [A11] WHIT-749: saving an edit goes BACK (to the goal page it came from), never to the tab.
  it('saving an edit → back, not a replace to the Goals tab', async () => {
    await renderForm();
    await press('goal-save');
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(routerSpies.dismissAll).not.toHaveBeenCalled();
  });

  it('a background cache refetch does NOT clobber what the user is mid-editing', async () => {
    await renderForm();
    fireEvent.changeText(screen.getByDisplayValue('Rainy day'), 'My own edit');

    // A later refetch hands back a fresh record object with server-side values. The re-seed
    // only runs ONCE (on first load), so the in-progress edit must survive.
    server.seed('/goals', [{ ...RAINY_DAY, name: 'Server name' }]);
    await refreshInAct(() => queryClient.refetchQueries());

    expect(server.sent('GET', '/goals')).toHaveLength(2);
    expect(screen.getByDisplayValue('My own edit')).toBeTruthy();
    expect(screen.queryByDisplayValue('Server name')).toBeNull();
  });

  // WHIT-749: the goal's page is gone too, so delete returns straight to the Goals tab.
  it('Delete → deleteGoal(id) once, then straight to the Goals tab', async () => {
    await renderForm();
    await press('goal-delete');
    expect(mockDeleteGoal).toHaveBeenCalledTimes(1);
    expect(mockDeleteGoal).toHaveBeenCalledWith('g1');
    await waitFor(() => expect(routerSpies.replace).toHaveBeenCalledWith('/(tabs)/goals'));
    expect(routerSpies.dismissAll).toHaveBeenCalledTimes(1);
    expect(routerSpies.back).not.toHaveBeenCalled();
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
    setParams({ id: 'g1' });
    goals = [RAINY_DAY];
    mockSaveGoal.mockRejectedValueOnce(new Error('network blew up'));
    await renderForm();

    await press('goal-save'); // 1st: throws → guard logs → button must re-enable
    await press('goal-save'); // 2nd: only fires if `saving` was reset
    expect(mockSaveGoal).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled();
  });

  it('goal-delete re-enables so a retry runs after deleteGoal throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setParams({ id: 'g1' });
    goals = [RAINY_DAY];
    mockDeleteGoal.mockRejectedValueOnce(new Error('network blew up'));
    await renderForm();

    await press('goal-delete');
    await press('goal-delete');
    expect(mockDeleteGoal).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(routerSpies.replace).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('validation blocks the save (toast, no writer call)', () => {
  const type = (placeholder: string, value: string) => fireEvent.changeText(screen.getByPlaceholderText(placeholder), value);
  const tap = (testID: string) => fireEvent.press(screen.getByTestId(testID));
  const synced = (amount: string) => { tap('goal-source-synced'); tap('goal-account-acc-1'); type('e.g. 10000', amount); };

  it.each<[string, () => void, string]>([
    ['empty name', () => { synced('5000'); setTargetDate(); }, 'Give your goal a name.'],
    ['no balance source chosen', () => { type('e.g. Emergency fund', 'X'); type('e.g. 10000', '5000'); setTargetDate(); }, "Choose where this goal's balance comes from."],
    ['a grow goal with a $0 target', () => { type('e.g. Emergency fund', 'X'); synced('0'); setTargetDate(); }, 'Enter a target amount above $0.'],
    ['no target date picked', () => { type('e.g. Emergency fund', 'X'); synced('5000'); }, 'Pick a target date.'],
    ['a grow baseline that is not below the target', () => {
      type('e.g. Emergency fund', 'X'); synced('5000'); type('e.g. 500', '9000'); setTargetDate();
    }, 'The starting amount should be below your target.'],
    // a pay-down "starting amount owed" must sit ABOVE the target; equal is the wrong side.
    ['pay-down baseline not above the target', () => {
      type('e.g. Emergency fund', 'Card'); tap('goal-direction-paydown'); tap('goal-source-manual');
      type('e.g. 2500', '3000'); type('e.g. 0', '1000'); type('e.g. 500', '1000'); setTargetDate();
    }, 'The starting amount should be above your target.'],
    // guards the parseAmount regex: a naive parseFloat('80abc') would save a $80 goal.
    ['a non-numeric target amount', () => { type('e.g. Emergency fund', 'Junk'); synced('80abc'); setTargetDate(); }, 'Enter a target amount above $0.'],
    ['blank manual starting balance', () => {
      type('e.g. Emergency fund', 'Cash'); tap('goal-source-manual'); type('e.g. 10000', '5000'); setTargetDate();
    }, 'Enter a starting balance.'],
    ['non-numeric baseline', () => { fillValidSyncedGrow('Base'); type('e.g. 500', 'abc'); }, 'Enter a valid starting amount.'],
  ])('validation blocks the save: %s', async (_case, fill, toast) => {
    await renderForm();
    fill();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith(toast);
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
    await renderForm();
    fillSyncedGrow();
    setTargetDate();
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith('Pick a target date in the future.');
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });

  it('editing an OVERDUE goal without touching its date still saves (guard bites only changed dates)', async () => {
    const overdue: GoalRecord = { ...RAINY_DAY, id: 'gp', target_date: '2020-01-01' };
    setParams({ id: 'gp' });
    goals = [overdue];
    await renderForm();
    fireEvent.changeText(screen.getByDisplayValue('Rainy day'), 'Renamed');
    await press('goal-save');
    expect(mockShowToast).not.toHaveBeenCalled();
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('gp');
    expect(body).toMatchObject({ name: 'Renamed', target_date: '2020-01-01' });
  });
});

// ===== WHIT-234 adversarial gaps (folded in) — arms the sibling suite above leaves open =====

describe('writer failure does not navigate', () => {
  // [A20] saveGoal → false (server write failed): stay on the form, do NOT router.back.
  it('saveGoal returns false → no back (the writer keeps its own toast)', async () => {
    mockSaveGoal.mockImplementation(async () => false);
    await renderForm();
    fillValidSyncedGrow();
    await press('goal-save');

    expect(mockSaveGoal).toHaveBeenCalledTimes(1);
    // Let any (wrongly) scheduled navigation flush before asserting it did NOT happen.
    await act(async () => {});
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // [A21] deleteGoal → false: stay on the form, do NOT router.back.
  it('deleteGoal returns false → no back', async () => {
    setParams({ id: 'g1' });
    goals = [RAINY_DAY];
    mockDeleteGoal.mockImplementation(async () => false);
    await renderForm();
    await press('goal-delete');

    expect(mockDeleteGoal).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(routerSpies.back).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });
});

describe('edit a MANUAL goal', () => {
  beforeEach(() => { setParams({ id: 'g2' }); goals = [CASH_POT]; });

  // [A22] Editing a manual goal prefills the manual arm: source=manual (its STARTING BALANCE
  // field renders, seeded), and a save carries manual_balance + manual_as_of, no account_id.
  it('prefills source=manual + starting balance + as-of, and saves the manual arm', async () => {
    await renderForm();
    expect(screen.getByText('Edit goal')).toBeTruthy();
    // STARTING BALANCE input only renders when source==='manual' — its value proves the prefill.
    expect(screen.getByDisplayValue('800')).toBeTruthy();

    await press('goal-save');
    expect(mockShowToast).not.toHaveBeenCalled();
    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('g2');
    expect(body).toMatchObject({ manual_balance: 800, manual_as_of: '2026-01-15', direction: 'grow' });
    expect(body).not.toHaveProperty('account_id');
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
  });
});

describe('the icon picker feeds the body', () => {
  // [A26] Tapping a non-default icon changes the icon carried in the saved body (default 'star').
  it('picking "cash" sends icon: "cash"', async () => {
    await renderForm();
    fillValidSyncedGrow('Piggy');
    fireEvent.press(screen.getByTestId('goal-icon-cash'));
    await press('goal-save');

    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(body.icon).toBe('cash');
    expect(body.target_date).toMatch(ISO);
  });
});

describe('editing before the cache resolves cannot overwrite the goal', () => {
  // [A28] editId present but the ['goals'] cache hasn't loaded (existing === undefined): a save
  // is a NO-OP — no writer, no toast, no navigation — so the default blank form can't be written
  // over the real goal. The PRIMARY block is the disabled Save button (asserted directly below);
  // onSave's internal `editingUnloaded` early-return is defence-in-depth behind it.
  it('save is a no-op while the edited goal is still loading', async () => {
    setParams({ id: 'g1' });
    goals = [RAINY_DAY];
    seedServer();
    const held = server.hold('/goals'); // cold cache: g1 not loaded yet
    render(<WithQueries><GoalEdit /></WithQueries>);

    // The button is disabled — that's what stops the blank-over-real save.
    expect(screen.getByTestId('goal-save').props.accessibilityState?.disabled).toBe(true);

    await press('goal-save');
    expect(mockSaveGoal).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(routerSpies.back).not.toHaveBeenCalled();

    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.getByDisplayValue('Rainy day')).toBeTruthy());
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
    await renderForm();
    fillManual();
    // AS OF is seeded to today → shows a "Change" affordance now; open it (the first date field),
    // then tap its picker → future.
    fireEvent.press(screen.getAllByTestId('date-open')[0]);
    fireEvent.press(screen.getAllByTestId('mock-datepicker')[0]); // as-of → future
    setTargetDate();                                              // target → future (valid)
    await press('goal-save');
    expect(mockShowToast).toHaveBeenCalledWith("The as-of date can't be in the future.");
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});

// WHIT-477 — the checkpoint editor on the goal form: add / edit / delete rows, sorted into the
// goal's direction on save, validated client-side before any 400. RAINY_DAY is a grow goal with a
// $10k target, so a valid rung sits in (0, 10000).
describe('WHIT-477: the checkpoint editor', () => {
  const LADDER = [
    { id: 'cp-1', label: 'First $1k', amount: 1000 },
    { id: 'cp-2', label: 'Halfway', amount: 5000 },
  ];

  beforeEach(() => { setParams({ id: 'g1' }); goals = [{ ...RAINY_DAY, checkpoints: LADDER }]; });

  it('carries a saved ladder through an unrelated edit, ids intact', async () => {
    await renderForm();
    fireEvent.changeText(screen.getByDisplayValue('Rainy day'), 'Rainy day fund');
    await press('goal-save');

    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(body).toMatchObject({ name: 'Rainy day fund' });
    expect(body.checkpoints).toEqual(LADDER);   // same rows, same permanent ids
  });

  it('adds a rung and saves it sorted, with a minted id', async () => {
    goals = [RAINY_DAY]; // no existing ladder
    await renderForm();
    fireEvent.press(screen.getByTestId('goal-cp-add'));
    fireEvent.changeText(screen.getByTestId('goal-cp-label-0'), 'Halfway');
    fireEvent.changeText(screen.getByTestId('goal-cp-amount-0'), '5000');
    await press('goal-save');

    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    const rungs = body.checkpoints as { id: string; label: string; amount: number }[];
    expect(rungs).toHaveLength(1);
    expect(rungs[0]).toMatchObject({ label: 'Halfway', amount: 5000 });
    expect(rungs[0].id).toMatch(/^test-uuid-/);   // client-minted (auto-mocked randomUUID)
  });

  it('editing a rung label keeps its id', async () => {
    await renderForm();
    fireEvent.changeText(screen.getByTestId('goal-cp-label-0'), 'First grand');
    await press('goal-save');

    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    const rungs = body.checkpoints as { id: string; label: string; amount: number }[];
    expect(rungs[0]).toEqual({ id: 'cp-1', label: 'First grand', amount: 1000 });
  });

  it('saves rungs SORTED even when entered out of order', async () => {
    goals = [RAINY_DAY];
    await renderForm();
    fireEvent.press(screen.getByTestId('goal-cp-add'));
    fireEvent.changeText(screen.getByTestId('goal-cp-label-0'), 'Later');
    fireEvent.changeText(screen.getByTestId('goal-cp-amount-0'), '4000');
    fireEvent.press(screen.getByTestId('goal-cp-add'));
    fireEvent.changeText(screen.getByTestId('goal-cp-label-1'), 'Earlier');
    fireEvent.changeText(screen.getByTestId('goal-cp-amount-1'), '1000');
    await press('goal-save');

    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    const rungs = body.checkpoints as { amount: number }[];
    expect(rungs.map((r) => r.amount)).toEqual([1000, 4000]);   // grow → ascending
  });

  it('deleting every rung of a saved ladder sends [] to clear it', async () => {
    await renderForm();
    fireEvent.press(screen.getByTestId('goal-cp-delete-0'));
    fireEvent.press(screen.getByTestId('goal-cp-delete-0'));   // indices shift after each delete
    await press('goal-save');

    const [, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(body.checkpoints).toEqual([]);
  });

  it('blocks save with a toast when a rung is out of bounds (grow rung ≥ target)', async () => {
    goals = [RAINY_DAY];
    await renderForm();
    fireEvent.press(screen.getByTestId('goal-cp-add'));
    fireEvent.changeText(screen.getByTestId('goal-cp-label-0'), 'Too big');
    fireEvent.changeText(screen.getByTestId('goal-cp-amount-0'), '15000');   // ≥ 10000 target
    await press('goal-save');

    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/below the target/i));
    expect(mockSaveGoal).not.toHaveBeenCalled();
  });
});

// WHIT-477 QA gaps — the MANUAL body-assembly arm carrying rungs.
describe('WHIT-477 QA gaps: checkpoint editor edges', () => {
  // [A-G12] The MANUAL arm of the body assembly must carry the sorted ladder (it spreads `common`,
  // which now holds `checkpoints`). Fail-on-revert: if the manual branch stopped spreading the
  // checkpoint field, the ladder would vanish for manual goals only.
  it('a manual-goal edit that adds a rung sends BOTH the ladder and the manual arm', async () => {
    setParams({ id: 'g2' });
    goals = [CASH_POT]; // manual grow, target 5000, no ladder
    await renderForm();

    fireEvent.press(screen.getByTestId('goal-cp-add'));
    fireEvent.changeText(screen.getByTestId('goal-cp-label-0'), 'Half');
    fireEvent.changeText(screen.getByTestId('goal-cp-amount-0'), '2500');
    await press('goal-save');

    const [editId, body] = mockSaveGoal.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(editId).toBe('g2');
    const rungs = body.checkpoints as { label: string; amount: number }[];
    expect(rungs).toHaveLength(1);
    expect(rungs[0]).toMatchObject({ label: 'Half', amount: 2500 });
    // still the manual arm, not smuggled into a synced body
    expect(body.manual_balance).toBe(800);
    expect(body.account_id).toBeUndefined();
  });
});

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
