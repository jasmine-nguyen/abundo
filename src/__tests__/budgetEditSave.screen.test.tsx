// WHIT-250: happy-path tap test for the Budget save button. budgetEditIncome only asserts
// render states — nothing ever pressed Save. This presses the real button and asserts
// saveBudget fires once + navigation to the budgets tab, so an onPress rewired to the wrong
// handler (app/budget/edit.tsx) turns it red.
// WHIT-459: budgetEditIncome / budgetEditRollover / budgetPickIncome / budgetPickSavings are
// folded in as child describes at the END of this file. All five share the same ../context +
// expo-router mocks. The expo-router factory is reconciled to a SUPERSET: it exposes
// push/replace/back/dismissAll + useLocalSearchParams so both the edit screen (replace/params) and
// the pick screen (back) are served; each folded block asserts only the handles it needs. Two
// screens are imported (edit + pick).
// WHIT-672: the categories and budget rollups come from the fake server through the real query
// hooks; ../context keeps only the saveBudget writer.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { ScrollView, Switch } from 'react-native';

// Hoisted module-scope mocks so replace() + the writer are assertable across renders
// (see the delete test — useRouter() returns a fresh object each render).
const mockSaveBudget = jest.fn(async (_id: string, _amount: number, _rollover?: boolean) => true);
const mockReplace = jest.fn();

// `let` (was const): the folded income/rollover blocks reassign mockParams per test; the survivor
// tests never do, so they keep the initial coffee value.
let mockParams: { categoryId: string } = { categoryId: 'coffee' };

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ saveBudget: mockSaveBudget }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn(), dismissAll: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import BudgetEdit from '../../app/budget/edit';
import BudgetPick from '../../app/budget/pick';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { COFFEE } from './support/categories';

const SPEND = COFFEE;
const INCOME = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#7fd49b', bucket: 'Income', recent: 0 };
const PICK_INCOME = { ...INCOME, recent: 4000 };

const server = installFakeServer();
useTestQueryClient();

// What the server holds: the taxonomy, and the budget rollups keyed by category id.
function seedServer(categories: unknown[], budgets: Record<string, unknown> = {}) {
  server.seed('/categories', categories);
  server.seed('/budgets', budgets);
}

// A plain spend budget with an active bill spread (WHIT-550): the server's rollup carries the plan.
const SPREAD_COFFEE = {
  target: 100, posted: 0, pending: 0, rollover: false, carryover: 0,
  spread: { amount: 200, cycles: 4, index: 1, adjustment: -25 },
};

// mockParams is reassigned by the folded edit tests; reset it centrally so the top-level tests get
// the `coffee` default order-independently (was a `const` before the fold made it mutable).
beforeEach(() => {
  mockSaveBudget.mockClear();
  mockReplace.mockClear();
  mockParams = { categoryId: 'coffee' };
  resetAuth();
});

// Restore any per-test console.error spy even if a test fails mid-body (targets console.error
// only, so jest.setup's console.warn silence stays intact).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

it('pressing Add budget saves the amount once and navigates to the budgets tab', async () => {
  // SPEND category (not Income/Savings) with no existing budget → save button reads 'Add budget'.
  // saveBudget is read off useAppContext(); the categories and budgets come from the server.
  seedServer([SPEND]);
  await renderWithQueries(<BudgetEdit />);

  fireEvent.changeText(screen.getByPlaceholderText('0'), '300');
  await act(async () => { fireEvent.press(screen.getByText('Add budget')); });

  // The real onPress→save()→saveBudget chain fired with the parsed number + the rollover
  // toggle (spend category → the flag is sent; default off), then navigated.
  expect(mockSaveBudget).toHaveBeenCalledTimes(1);
  expect(mockSaveBudget).toHaveBeenCalledWith('coffee', 300, false);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
});

// WHIT-249: an UNEXPECTED saveBudget throw used to leave the Add budget button stuck disabled
// (the caller's setSubmitting(false) sits on the false-return branch, which a throw skips). The
// handler now resets `submitting` in a catch (and re-throws so the guard logs). Fail-on-revert:
// drop the catch → the 2nd press early-returns on the stuck `submitting` flag → saveBudget once.
it('re-enables the Add budget button so a retry runs after saveBudget throws', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  seedServer([SPEND]);
  mockSaveBudget.mockRejectedValueOnce(new Error('network blew up'));
  await renderWithQueries(<BudgetEdit />);

  fireEvent.changeText(screen.getByPlaceholderText('0'), '300');
  await act(async () => { fireEvent.press(screen.getByText('Add budget')); }); // throws → guard logs
  await act(async () => { fireEvent.press(screen.getByText('Add budget')); }); // only fires if re-enabled

  expect(mockSaveBudget).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
  expect(errorSpy).toHaveBeenCalled();
});

// The Save button sits below the amount field, so the keyboard opens over it. The form scroll
// must inset for the keyboard AND keep taps alive. Fail-on-revert: drop the props in
// app/budget/edit.tsx → find() returns undefined.
it('wraps the form in a keyboard-inset, tap-persisting scroll so Save stays reachable', async () => {
  seedServer([SPEND]);
  const { UNSAFE_getAllByType } = await renderWithQueries(<BudgetEdit />);
  const formScroll = UNSAFE_getAllByType(ScrollView).find(
    (sv) => sv.props.automaticallyAdjustKeyboardInsets === true && sv.props.keyboardShouldPersistTaps === 'handled',
  );
  expect(formScroll).toBeTruthy();
  // Save must live INSIDE that insetted scroll — that's what keeps it reachable over the keyboard.
  expect(formScroll!.findAll((n) => n === screen.getByText('Add budget'))).toHaveLength(1);
});

// ===== WHIT-169 (folded from budgetEditIncome.screen.test.tsx) =====
// edit.tsx must GATE the spend UI for an income category, and a Savings deep-link lands on a
// "can't budget" state. SPEND and INCOME reuse the module-scope consts (the pick blocks below use
// PICK_INCOME, a different recent). replace is the module-scope mockReplace here
// (inert: these render-only tests never press Save).
describe('budgetEditIncome (folded)', () => {
  describe('BudgetEdit — income framing is wired into the screen (WHIT-169)', () => {
    it('income category: prompt shown, recommend button + "Recommended:" line absent, earning history, dashed stats', async () => {
      mockParams = { categoryId: 'salary' };
      seedServer([INCOME]);
      await renderWithQueries(<BudgetEdit />);

      expect(screen.getByText('Set your income floor')).toBeTruthy();     // recPrompt (else-branch)
      expect(screen.queryByText(/^Recommended:/)).toBeNull();             // no spend recommendation line
      expect(screen.queryByText('Use my average spend')).toBeNull();      // recommend button gated OFF
      expect(screen.queryByText('Use my average income')).toBeNull();     // ...and no income-CTA button either
      expect(screen.getByText('View earning history')).toBeTruthy();      // historyToggleLabel
      expect(screen.getAllByText('—')).toHaveLength(2);                   // Last + 6-cycle stats both dashed, never "$0"
    });

    it('spend category (control): recommendation line + button + spending history all present', async () => {
      mockParams = { categoryId: 'coffee' };
      seedServer([SPEND]);
      await renderWithQueries(<BudgetEdit />);

      expect(screen.getByText('Recommended: $52')).toBeTruthy();          // real spend recommendation
      expect(screen.getByText('Use my average spend')).toBeTruthy();      // recommend button present
      expect(screen.getByText('View spending history')).toBeTruthy();     // spend history label
      expect(screen.queryByText('Set your income floor')).toBeNull();     // no income prompt
      expect(screen.queryByText('View earning history')).toBeNull();
    });
  });

  describe('BudgetEdit — a Savings category lands on a "can\'t budget" state (WHIT-202)', () => {
    it('Savings category: shows the explanatory note, none of the amount/history/save UI', async () => {
      // A deep-link to /budget/edit on a Savings category must NOT show an amount field whose
      // save is doomed to a 400 — it shows a coherent "can't budget" note instead. Fail-on-
      // revert: removing the early-return falls through to the full spend screen (history +
      // stats reappear, note gone).
      const SAVINGS = { id: 'nest_egg', name: 'Nest Egg', icon: 'piggy', color: '#8fd4c0', bucket: 'Savings', recent: 0 };
      mockParams = { categoryId: 'nest_egg' };
      seedServer([SAVINGS]);
      await renderWithQueries(<BudgetEdit />);

      expect(screen.getByText('Nest Egg')).toBeTruthy();                              // category header still shown
      expect(screen.getByText(/Savings categories can't be budgeted/)).toBeTruthy();  // the note
      expect(screen.queryByText('View spending history')).toBeNull();                 // no spend UI...
      expect(screen.queryByText('6-cycle average')).toBeNull();                       // ...no stats/amount field
      expect(screen.queryByText('View earning history')).toBeNull();
    });
  });
});

// ===== budget-rollover (folded from budgetEditRollover.screen.test.tsx) =====
// edit.tsx must WIRE the rollover Switch. mockSaveBudget/mockReplace reuse the module-scope mocks;
// SPEND and INCOME reuse the outer consts. Own beforeEach re-clears the writer/replace.
describe('budgetEditRollover (folded)', () => {
  beforeEach(() => { mockSaveBudget.mockClear(); mockReplace.mockClear(); });

  it('spend budget: flipping the Smoothing toggle ON makes Save pass rollover=true', async () => {
    mockParams = { categoryId: 'coffee' };
    seedServer([SPEND]);
    const { UNSAFE_getByType } = await renderWithQueries(<BudgetEdit />);

    expect(screen.getByText('Smoothing')).toBeTruthy();                 // the toggle row is shown
    fireEvent.changeText(screen.getByPlaceholderText('0'), '300');
    fireEvent(UNSAFE_getByType(Switch), 'valueChange', true);           // user turns rollover ON
    await act(async () => { fireEvent.press(screen.getByText('Add budget')); });

    expect(mockSaveBudget).toHaveBeenCalledWith('coffee', 300, true);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
  });

  it('existing rollover-ON budget SEEDS the toggle on, so Update saves rollover=true unchanged', async () => {
    mockParams = { categoryId: 'coffee' };
    // existing budget already has rollover ON — the editor must seed the Switch from it.
    seedServer([SPEND], { coffee: { target: 100, posted: 0, pending: 0, rollover: true, carryover: 0 } });
    const { UNSAFE_getByType } = await renderWithQueries(<BudgetEdit />);

    expect(UNSAFE_getByType(Switch).props.value).toBe(true);            // seeded ON from existing.rollover
    await act(async () => { fireEvent.press(screen.getByText('Update budget')); });

    expect(mockSaveBudget).toHaveBeenCalledWith('coffee', 100, true);   // not silently flipped off
  });

  it('income category: no rollover toggle, and Save passes rollover=undefined (spend-only)', async () => {
    mockParams = { categoryId: 'salary' };
    seedServer([INCOME]);
    const { UNSAFE_queryAllByType } = await renderWithQueries(<BudgetEdit />);

    expect(screen.queryByText('Smoothing')).toBeNull();                 // toggle hidden for Income
    expect(UNSAFE_queryAllByType(Switch)).toHaveLength(0);
    fireEvent.changeText(screen.getByPlaceholderText('0'), '5000');
    await act(async () => { fireEvent.press(screen.getByText('Add budget')); });

    expect(mockSaveBudget).toHaveBeenCalledWith('salary', 5000, undefined);
  });

  // WHIT-550: a bill spread IS a form of smoothing, so the switch shows ON but locked —
  // and Save must send rollover=undefined (never a forced true: the server 400s a rollover
  // write on a spread category).
  it('active bill spread: Smoothing shows ON+disabled, and Save passes rollover=undefined', async () => {
    mockParams = { categoryId: 'coffee' };
    seedServer([SPEND], { coffee: SPREAD_COFFEE });
    const { UNSAFE_getByType } = await renderWithQueries(<BudgetEdit />);

    expect(screen.getByText('Smoothing')).toBeTruthy();                 // row shown, not hidden
    const smoothingSwitch = UNSAFE_getByType(Switch);
    expect(smoothingSwitch.props.value).toBe(true);                     // reads ON (a spread is smoothing)
    expect(smoothingSwitch.props.disabled).toBe(true);                  // but locked
    await act(async () => { fireEvent.press(screen.getByText('Update budget')); });

    expect(mockSaveBudget).toHaveBeenCalledWith('coffee', 100, undefined);  // never a forced true
  });

  // GAP [A-S1] WHIT-550 — the LOCKED help copy must render while a spread is active (and the
  // normal smoothing help must NOT). Fail-on-revert: swap the locked/normal help ternary.
  it('active bill spread: shows the locked help copy, not the normal smoothing help', async () => {
    mockParams = { categoryId: 'coffee' };
    seedServer([SPEND], { coffee: SPREAD_COFFEE });
    await renderWithQueries(<BudgetEdit />);

    expect(screen.getByText(/Manage the spread from the bill instead/)).toBeTruthy();  // locked branch
    expect(screen.queryByText(/Unused budget carries forward/)).toBeNull();            // normal help hidden
  });

  // GAP [A-S1b] WHIT-550 — the reverse branch: a plain spend budget shows the normal help, not locked.
  it('plain spend budget: shows the normal smoothing help, not the locked copy', async () => {
    mockParams = { categoryId: 'coffee' };
    seedServer([SPEND]);
    await renderWithQueries(<BudgetEdit />);

    expect(screen.getByText(/Unused budget carries forward/)).toBeTruthy();            // normal branch
    expect(screen.queryByText(/Manage the spread from the bill instead/)).toBeNull();  // locked help hidden
  });

  // GAP [A-S2] WHIT-550 — defensive: an existing budget with BOTH rollover=true AND a spread.
  // The seeded ON flag must NOT leak into save() while locked, and a stray valueChange on the
  // disabled switch must not change what Save sends. Fail-on-revert: send `rollover` while locked.
  it('spread + rollover-ON seed: a stray toggle cannot leak the flag past the lock', async () => {
    mockParams = { categoryId: 'coffee' };
    seedServer([SPEND], { coffee: { ...SPREAD_COFFEE, rollover: true, carryover: 40 } });
    const { UNSAFE_getByType } = await renderWithQueries(<BudgetEdit />);

    const smoothingSwitch = UNSAFE_getByType(Switch);
    expect(smoothingSwitch.props.value).toBe(true);     // reads ON (spread is smoothing) despite the seed
    expect(smoothingSwitch.props.disabled).toBe(true);  // locked
    fireEvent(smoothingSwitch, 'valueChange', false);   // stray interaction the platform shouldn't allow
    await act(async () => { fireEvent.press(screen.getByText('Update budget')); });

    // Never a boolean while locked — not the seeded true, not the toggled false. Only undefined.
    expect(mockSaveBudget).toHaveBeenCalledWith('coffee', 100, undefined);
    expect(UNSAFE_getByType(Switch).props.value).toBe(true);  // still ON — the lock ignores the stray toggle
  });
});

// ===== WHIT-69 (folded from budgetPickIncome.screen.test.tsx) =====
// app/budget/pick.tsx lists Income categories in "Add a budget" while hiding already-budgeted ones.
// Renders BudgetPick (imported at module scope). SPEND and PICK_INCOME (recent 4000, unlike the edit
// blocks' INCOME) reuse the outer consts; SIDE is block-scoped.
describe('budgetPickIncome (folded)', () => {
  const SIDE = { id: 'side_gig', name: 'Side Gig', icon: 'briefcase', color: '#7fd49b', bucket: 'Income', recent: 300 };

  describe('BudgetPick — income is pickable (WHIT-69)', () => {
    it('lists an Income category alongside spend categories', async () => {
      seedServer([PICK_INCOME, SPEND]);
      await renderWithQueries(<BudgetPick />);
      expect(screen.getByText('Salary')).toBeTruthy();          // was filtered out pre-WHIT-69
      expect(screen.getByText('Cafes & Coffee')).toBeTruthy();  // control: spend still listed
    });

    it('still hides an income category that already has a budget', async () => {
      // A rollup needs a target above 0, or the budgets read drops it.
      seedServer([PICK_INCOME, SIDE], { salary: { target: 1, posted: 0, pending: 0 } });
      await renderWithQueries(<BudgetPick />);
      expect(screen.queryByText('Salary')).toBeNull();          // already budgeted → excluded
      expect(screen.getByText('Side Gig')).toBeTruthy();        // not budgeted → still pickable
    });

    // WHIT-169: an income row must NOT show its spend `recent` (4000) as an average —
    // it shows an "earn-target" tag instead. A spend row still shows its avg.
    it('shows "earn-target" for income rows, not a spend average, while spend rows keep theirs', async () => {
      seedServer([PICK_INCOME, SPEND]);
      await renderWithQueries(<BudgetPick />);
      expect(screen.getByText('earn-target')).toBeTruthy();     // income row's right side
      expect(screen.queryByText('$4,000')).toBeNull();          // income spend-avg suppressed
      expect(screen.getByText('$52')).toBeTruthy();             // spend control row keeps its avg
      expect(screen.getByText('avg / fortnight')).toBeTruthy(); // ...and its label
    });
  });
});

// ===== WHIT-201 (folded from budgetPickSavings.screen.test.tsx) =====
// Savings categories are NOT budgetable — pick.tsx excludes them (Income stays pickable). SPEND
// and PICK_INCOME (recent 4000) reuse the outer consts; SAVINGS is block-scoped.
describe('budgetPickSavings (folded)', () => {
  const SAVINGS = { id: 'nest_egg', name: 'Nest Egg', icon: 'home', color: '#C7A8F0', bucket: 'Savings', recent: 0 };

  describe('BudgetPick — Savings is not budgetable (WHIT-201)', () => {
    it('hides a Savings category while still listing spend and income categories', async () => {
      seedServer([SAVINGS, PICK_INCOME, SPEND]);
      await renderWithQueries(<BudgetPick />);
      expect(screen.queryByText('Nest Egg')).toBeNull();        // Savings excluded
      expect(screen.getByText('Salary')).toBeTruthy();          // Income still pickable (WHIT-69)
      expect(screen.getByText('Cafes & Coffee')).toBeTruthy();  // spend still pickable
    });
  });
});
