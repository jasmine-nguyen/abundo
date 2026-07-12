// WHIT-234 — ADVERSARIAL gaps for the add/edit goal form. Complements the implementer's
// goalEdit.screen.test.tsx (happy paths + acceptance): here we lock the arms it leaves open —
// writer-failure navigation, manual-goal EDIT prefill, the pay-down baseline side, the
// non-numeric/negative amount guard (the parseAmount regex, not parseFloat), the icon picker
// actually mutating the body, blank manual balance, and the "cache not loaded yet" save guard.
//
// Same boundary mocks + global date-picker/safe-area stubs as the sibling suite. Platform
// defaults to iOS, so each DateField renders its picker inline; the mock picker fires a fixed
// date on press.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { GoalRecord, AccountBalance } from '../api';
import { toISODate } from '../dateutil';

// WHIT-257: override the global picker mock (fixed 20 Jun 2026, a PAST date the new save guard
// rejects) with a configurable one; default to a FUTURE date so the existing happy paths pass.
// Relative to the real clock (the guard is date-sensitive, so a hardcoded year would rot).
const FUTURE = new Date(new Date().getFullYear() + 2, 0, 15);
const FUTURE_ISO = toISODate(FUTURE);
let mockPickedDate = FUTURE;
jest.mock('@react-native-community/datetimepicker', () => {
  const ReactLib = require('react');
  const { Pressable, Text } = require('react-native');
  const MockPicker = (props: any) => ReactLib.createElement(
    Pressable,
    { testID: 'mock-datepicker', onPress: () => props.onChange && props.onChange({ type: 'set' }, mockPickedDate) },
    ReactLib.createElement(Text, null, 'picker'),
  );
  return { __esModule: true, default: MockPicker };
});

const mockSaveGoal = jest.fn(async (_editId: string | null, _body: unknown) => true);
const mockDeleteGoal = jest.fn(async (_id: string) => true);
const mockShowToast = jest.fn();
const mockBack = jest.fn();

let mockParams: { id?: string };
let mockGoals: GoalRecord[];
let mockBalances: Map<string, AccountBalance>;
let mockTransactions: { account_id: string; account_name: string }[];

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

const balance = (account_id: string, amount: number): AccountBalance => ({
  account_id, amount, available_balance: null, currency: 'AUD', as_of: '2026-07-01', account_type: 'savings',
});

// A saved MANUAL grow goal (no account_id — the manual arm). Used for the edit-prefill gap.
const CASH_POT: GoalRecord = {
  id: 'g2', name: 'Cash pot', icon: 'cash', direction: 'grow',
  target_amount: 5000, target_date: '2027-06-30', baseline: null,
  account_id: null, manual_balance: 800, manual_as_of: '2026-01-15',
};

// A saved synced grow goal for the delete-failure gap.
const RAINY_DAY: GoalRecord = {
  id: 'g1', name: 'Rainy day', icon: 'star', direction: 'grow',
  target_amount: 10000, target_date: '2027-12-31', baseline: null,
  account_id: 'acc-1', manual_balance: null, manual_as_of: null,
};

// Fill the target-date field. Platform-agnostic ON PURPOSE: the RN preset resolves the
// Platform module PER WORKER, so on some runs `edit.tsx` renders the Android DateField (a
// "Set date" button that mounts the picker on tap) instead of the iOS inline picker. Assuming
// iOS (tap `mock-datepicker` directly) makes the test flake red on an Android-resolving worker
// — the pre-existing bug in goalEdit.screen.test.tsx. So: open the field first if it's the
// Android variant, then tap the (last = target-date) picker.
function setTargetDate() {
  const opens = screen.queryAllByTestId('date-open');
  if (opens.length) fireEvent.press(opens[opens.length - 1]); // Android: mount the dialog
  const pickers = screen.getAllByTestId('mock-datepicker');
  fireEvent.press(pickers[pickers.length - 1]);
}

async function press(testID: string) {
  await act(async () => { fireEvent.press(screen.getByTestId(testID)); });
}

// A minimally-valid synced GROW create: name + synced acc-1 + $5000 + a date.
function fillValidSyncedGrow(name = 'Holiday') {
  fireEvent.changeText(screen.getByPlaceholderText('e.g. Emergency fund'), name);
  fireEvent.press(screen.getByTestId('goal-source-synced'));
  fireEvent.press(screen.getByTestId('goal-account-acc-1'));
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 10000'), '5000');
  setTargetDate();
}

beforeEach(() => {
  mockSaveGoal.mockClear().mockImplementation(async () => true);
  mockDeleteGoal.mockClear().mockImplementation(async () => true);
  mockShowToast.mockClear();
  mockBack.mockClear();
  mockParams = {};
  mockGoals = [];
  mockBalances = new Map([['acc-1', balance('acc-1', 2500)]]);
  mockTransactions = [{ account_id: 'acc-1', account_name: 'Everyday Savings' }];
  mockPickedDate = FUTURE; // reset to the future default; a guard test overrides it
});

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
    mockPickedDate = FUTURE; // future — drives BOTH pickers; target stays valid
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
    mockPickedDate = new Date(2019, 5, 15); // 2019-06-15, past AND != the seeded 2020-01-01
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
    mockPickedDate = FUTURE;
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
    mockPickedDate = todayMidnight; // toISODate(today) === component todayISO → today !> today
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
    mockPickedDate = new Date(2020, 0, 1); // past
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
