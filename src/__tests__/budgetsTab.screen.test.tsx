// The Budgets tab and the budget detail screen, one describe per ticket. The real screens and
// ../queries run over the fake server; ../auth and expo-router use the shared mocks, ../context is
// the real one with the delete/picker actions stubbed, and large text is off unless a describe
// turns it on.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { routerSpies, resetRouter, setParams } from './support/routerMock';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { pinToday } from './support/clock';
import { seedBudgets, renderBudgets, renderLoadedBudgets, heroTotals, renderLoadedBudgetsWithQueries, BUDGET_PAY_CYCLE, showBudgets, sidePadding, showTwoRows, tickBandOf, noteOffsetBelowBar } from './support/budgetsScreen';
import { MINUS, C } from '../theme';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { COFFEE, GROCERIES_RECORD, SALARY, SAVINGS, DINING, SUBSCRIPTIONS, GROCERIES, SUBS, LATTE, MORTGAGE_RECORD } from './support/categories';
import { seedBudgetsTab, budgetDetailFor } from './support/budgetsTab';
import { useBudgetsSuiteReset } from './support/budgetsSuite';
import { styleOf, sharedHost, textOf, hostParent } from './support/layout';
import { makeClient } from './support/queryClient';
import { resetListTabs } from './support/listTabsScreen';
import { pullAndSettle } from './support/pull';
import { BudgetBar } from '../components/ui';
import { HEADER_BODY_HEIGHT } from '../motion/ScrollChromeHeader';
import { LARGE_TEXT_MAX_SCALE } from '../hooks/useLargeText';

let mockLarge = false;
jest.mock('../hooks/useLargeText', () =>
  require('./support/largeTextMock').largeTextMockModule(() => mockLarge));
jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';
import BudgetDetail from '../../app/budget/[id]';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  mockLarge = false;
  resetRouter();
  resetAuth();
});

describe('WHIT-706 Budgets top card', () => {
  // WHIT-706: the Budgets top card (hero) — first-time screen, days + money side by side, next
  // payday, and an over-budget next step.
  beforeEach(() => {
    seedBudgets(server, { payCycle: { length: 30, last_pay_date: '2026-07-01', days_left: 4 } });
  });

  describe('Budgets top card', () => {
    it('no budgets → days left stays, money part is replaced by one "Add a spending budget" button', async () => {
      server.seed('/budgets', {});
      renderBudgets();
      expect(await screen.findByText('Add a spending budget')).toBeTruthy();
      expect(screen.getByText("No spending budgets yet. Set one and this shows what's left to spend.")).toBeTruthy();
      expect(screen.getByText('days left')).toBeTruthy();
      expect(screen.queryByText('Budget remaining')).toBeNull();
      expect(screen.queryByText('Left to spend')).toBeNull();
      expect(screen.queryByText('Over budget')).toBeNull();
      expect(screen.queryByTestId('budgets-hero-spent')).toBeNull();
      expect(screen.queryByText('Add a budget')).toBeNull();  // the duplicate dashed button is hidden
      fireEvent.press(screen.getByTestId('budgets-hero-add'));
      expect(routerSpies.push).toHaveBeenCalledWith('/budget/pick');
    });

    it('under budget → "Left to spend", no over-budget line', async () => {
      await renderLoadedBudgets();
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(screen.getByText('days left')).toBeTruthy();
      expect(screen.queryByText('Over budget')).toBeNull();
      expect(screen.queryByText(/resets/)).toBeNull();
      expect(screen.queryByText('Budget remaining')).toBeNull();
    });

    it('over budget → real minus sign, the amount said once, no resets text', async () => {
      server.seed('/budgets', { coffee: { target: 100, posted: 200, pending: 0 } });
      await renderLoadedBudgets();
      expect(screen.getByText('Over budget')).toBeTruthy();
      expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();
      expect(screen.queryByText('-$100')).toBeNull();
      expect(screen.queryByText(/resets/)).toBeNull();
      expect(screen.queryByText(/Over by/)).toBeNull();
    });

    it('1 day left and over → singular "day left", no resets text', async () => {
      server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01', days_left: 1 });
      server.seed('/budgets', { coffee: { target: 100, posted: 200, pending: 0 } });
      await renderLoadedBudgets();
      expect(screen.getByText('day left')).toBeTruthy();
      expect(screen.queryByText('days left')).toBeNull();
      expect(screen.queryByText(/resets/)).toBeNull();
    });

    it('0 days left and over → "0 days left", no resets text', async () => {
      server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01', days_left: 0 });
      server.seed('/budgets', { coffee: { target: 100, posted: 200, pending: 0 } });
      await renderLoadedBudgets();
      expect(screen.getByText('0')).toBeTruthy();
      expect(screen.getByText('days left')).toBeTruthy();
      expect(screen.queryByText(/resets/)).toBeNull();
    });

    it('shows the next payday date instead of the cycle start', async () => {
      pinToday(new Date('2026-09-18T10:00:00+10:00')); // 18 Sep 2026, Melbourne
      try {
        // last payday 1 Sep, 30-day cycle → next payday 1 Oct
        server.seed('/paycycle', { length: 30, last_pay_date: '2026-09-01' });
        renderBudgets();
        await waitFor(() => expect(heroTotals().payday).toBe('1 Oct'));
        expect(screen.queryByText(/^Started /)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // WHIT-706 QA: adversarial edges for the Budgets top card (hero).
  const GROCERIES = { ...GROCERIES_RECORD, color: '#7fd1b9' };

  describe('Budgets top card — QA edges', () => {
    // [A1] (P0) under budget: the money-left amount itself is on the card next to its label
    it('[A1] under budget shows the left-to-spend amount (summed across rows) and the spent line', async () => {
      server.seed('/categories', [COFFEE, GROCERIES]);
      server.seed('/budgets', {
        coffee: { target: 100, posted: 40, pending: 10 },
        groceries: { target: 250, posted: 40, pending: 0 },
      });
      await renderLoadedBudgets();
      expect(screen.getByText('$260')).toBeTruthy();
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(heroTotals()).toMatchObject({ spent: '$90', budget: '$350' });
      expect(screen.getByText('4')).toBeTruthy();
    });

    // [A2] (P0) empty: no money figure or minus sign anywhere, days count kept, payday kept
    it('[A2] no budgets → no "$" figure, no spent line, but the days count and next payday stay', async () => {
      pinToday(new Date('2026-09-18T10:00:00+10:00'));
      try {
        server.seed('/paycycle', { length: 30, last_pay_date: '2026-09-01', days_left: 13 });
        server.seed('/budgets', {});
        renderBudgets();
        expect(await screen.findByText('Add a spending budget')).toBeTruthy();
        expect(screen.getByText('13')).toBeTruthy();
        expect(screen.getByText('days left')).toBeTruthy();
        expect(heroTotals()).toEqual({ spent: undefined, budget: undefined, payday: '1 Oct' });
        expect(screen.queryAllByText(/\$/)).toHaveLength(0);
        expect(screen.queryAllByText(/−/)).toHaveLength(0);
        expect(screen.queryByText("Today's pace")).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    // [A3] (P1) empty + 1 day left → singular
    it('[A3] no budgets with 1 day left → "day left"', async () => {
      server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01', days_left: 1 });
      server.seed('/budgets', {});
      renderBudgets();
      await screen.findByText('Add a spending budget');
      expect(screen.getByText('day left')).toBeTruthy();
      expect(screen.queryByText('days left')).toBeNull();
    });

    // [A4] (P0) once a first budget is added, the card switches to the normal money view
    it('[A4] empty → a budget appears on refetch → money view returns, first-time prompt goes', async () => {
      server.seed('/budgets', {});
      const { client } = renderBudgets();
      await screen.findByText('Add a spending budget');
      server.seed('/budgets', { coffee: { target: 100, posted: 40, pending: 10 } });
      await refreshInAct(() => client.invalidateQueries({ queryKey: ['budgets'] }));
      expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
      expect(screen.queryByText('Add a spending budget')).toBeNull();
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(screen.queryByText('Add a budget')).toBeNull(); // WHIT-814: no dashed row; the header "+" adds
    });

    // [A7] (P1) unparseable last_pay_date → no payday line, never "NaN" / "undefined"
    it('[A7] an unparseable last_pay_date hides the next payday line', async () => {
      server.seed('/paycycle', { length: 30, last_pay_date: 'garbage', days_left: 4 });
      await renderLoadedBudgets();
      expect(screen.queryByTestId('budgets-hero-payday')).toBeNull();
      expect(screen.queryByText('Next payday')).toBeNull();
      expect(screen.queryByText(/NaN|undefined/)).toBeNull();
    });

    // [A8] (P0) "Over budget" follows the 1-cent threshold (WHIT-716)
    it('[A8] under a cent over → "Left to spend"; a cent over → "−$0.01" and "Over budget"', async () => {
      server.seed('/budgets', { coffee: { target: 100, posted: 100, pending: 0.004 } });
      const first = await renderLoadedBudgets();
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(screen.queryAllByText(/−/)).toHaveLength(0);
      first.unmount();

      server.seed('/budgets', { coffee: { target: 100, posted: 100, pending: 0.01 } });
      await renderLoadedBudgets();
      expect(screen.getByText(`${MINUS}$0.01`)).toBeTruthy();
      expect(screen.getByText('Over budget')).toBeTruthy();
    });

    // [A9] (P1) a large deficit: comma-grouped in the big number, said once, no hyphen anywhere
    it('[A9] large deficit → "−$6,056" once, no hyphen-minus figure', async () => {
      server.seed('/budgets', { coffee: { target: 1000, posted: 7056, pending: 0 } });
      await renderLoadedBudgets();
      expect(screen.getByText(`${MINUS}$6,056`)).toBeTruthy();
      expect(screen.queryByText(/Over by/)).toBeNull();
      expect(screen.queryAllByText(/-\$/)).toHaveLength(0);
    });

    // [A10] (P1) the empty-state button press does not double-navigate
    it('[A10] tapping "Add a spending budget" pushes the picker exactly once', async () => {
      server.seed('/budgets', {});
      renderBudgets();
      fireEvent.press(await screen.findByTestId('budgets-hero-add'));
      expect(routerSpies.push).toHaveBeenCalledTimes(1);
      expect(routerSpies.push).toHaveBeenCalledWith('/budget/pick');
    });
  });
});

describe('WHIT-707 Budgets sections and rows', () => {
  describe('Spending and Earning sections', () => {
    // WHIT-707 — the Budgets tab shows Spending and Earning sections with no swatch legend.
    beforeEach(() => {
      server.seed('/paycycle', { length: 14, last_pay_date: '2026-07-01' });
      server.seed('/categories', [
        { id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#35d9a0' },
        COFFEE,
      ]);
      server.seed('/budgets', {
        salary: { target: 5000, posted: 1000, pending: 0 },
        coffee: { target: 100, posted: 120, pending: 0 }, // $20 over
      });
    });

    it('shows Spending and Earning sections', async () => {
      await renderLoadedBudgets();

      expect(screen.getByText('SPENDING')).toBeTruthy();
      expect(screen.getByText('EARNING')).toBeTruthy();
      expect(screen.queryByText("Today's pace")).toBeNull();
    });
  });

  describe('QA', () => {
    // WHIT-707 QA — the Budgets tab and budget detail on screen: headings only for sections with rows,
    // section order, the income "next pay" text from the real pay-cycle clock, the quiet over line,
    // the row press opening the detail, and "today's plan" on the detail screen.
    const SALARY = { id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#35d9a0' };

    // Last paid Fri 25 Sep, so the income "next pay ~Fri" checks line up with the pinned clock.
    const seed = (categories: unknown[], budgets: Record<string, unknown>, daysLeft = 6) =>
      seedBudgetsTab(server, budgets, categories, daysLeft, '2026-09-25');

    useBudgetsSuiteReset(); // today: Sat 3 Oct 2026, Melbourne

    // [A20] (P0) spend only → SPENDING heading, no EARNING heading.
    it('[A20] no income budgets → no EARNING heading', async () => {
      seed([COFFEE], { coffee: { target: 100, posted: 40, pending: 0 } });
      await renderLoadedBudgetsWithQueries();
      expect(screen.getByText('SPENDING')).toBeTruthy();
      expect(screen.queryByText('EARNING')).toBeNull();
    });

    // [A21] (P0) income only → EARNING heading, no SPENDING heading.
    it('[A21] only income → no SPENDING heading', async () => {
      seed([SALARY], { salary: { target: 5000, posted: 1000, pending: 0 } });
      await renderWithQueries(<Budgets />);
      await screen.findByText('Salary');
      expect(screen.getByText('EARNING')).toBeTruthy();
      expect(screen.queryByText('SPENDING')).toBeNull();
    });

    // [A22] (P0) on-screen order: SPENDING, its row, EARNING, the income row — even when the server
    // sends income first. The income row reads "next pay ~Fri" from the real clock (Sat + 6 = Fri),
    // shows "to go" once (no second even-pace "to go"), and has no pace words.
    it('[A22] sections in order, income reads "earned · next pay ~Fri" with no pace line', async () => {
      seed([SALARY, COFFEE], {
        salary: { target: 5000, posted: 1000, pending: 0 },
        coffee: { target: 100, posted: 57, pending: 0 }, // on pace (8 of 14 days ≈ $57), so no pace line on screen
      });
      await renderWithQueries(<Budgets />);
      await screen.findByText('Salary');
      const order = screen.getAllByText(/^(SPENDING|EARNING|Salary|Cafes & Coffee)$/).map((n) => n.props.children);
      expect(order).toEqual(['SPENDING', 'Cafes & Coffee', 'EARNING', 'Salary']);
      expect(screen.getByText('$1,000 earned · next pay ~Fri')).toBeTruthy();
      expect(screen.getAllByText('to go')).toHaveLength(1);
      expect(screen.queryByText(/under plan|over plan|\$[\d,]+ to go|on pace|above target/)).toBeNull();
    });

    // [A23] (P0) payday more than 6 days away (fortnightly, 14 days left) → the date.
    it('[A23] 14 days left → "next pay ~17 Oct"', async () => {
      seed([SALARY], { salary: { target: 5000, posted: 1000, pending: 0 } }, 14);
      server.seed('/paycycle', { length: 14, last_pay_date: '2026-10-03', days_left: 14 }); // paid today → next pay in 14 days
      await renderWithQueries(<Budgets />);
      expect(await screen.findByText('$1,000 earned · next pay ~17 Oct')).toBeTruthy();
    });

    // [A24] (P0) over but rollover → the overspend shows once on the amount.
    it('[A24] over + rollover → overspend said once', async () => {
      seed([COFFEE], { coffee: { target: 100, posted: 120, pending: 0, rollover: true, carryover: 0 } });
      await renderLoadedBudgetsWithQueries();
      expect(screen.getByText('$20')).toBeTruthy();
      expect(screen.queryByText('$20 over budget')).toBeNull();
    });

    // [A25] (P0) pressing a full row (with a bar) opens its detail.
    it('[A25] the row press opens the detail', async () => {
      seed([COFFEE], { coffee: { target: 80, posted: 90.25, pending: 0 } });
      await renderLoadedBudgetsWithQueries();
      fireEvent.press(screen.getByText('Cafes & Coffee'));
      expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
    });

    // [A26] (P1) pending is counted in the spent amount, with no pending line (WHIT-744).
    it('[A26] a row with pending reads "… of …" and names no pending (WHIT-744)', async () => {
      seed([COFFEE], { coffee: { target: 100, posted: 40, pending: 10 } });
      await renderWithQueries(<Budgets />);
      expect(await screen.findByText('$50 of $100')).toBeTruthy();
      expect(screen.queryByText(/pending/)).toBeNull();
    });

    // [A27] (P1) the detail screen's marker uses the same word: "today's plan", not "today's target".
    it("[A27] budget detail labels the marker \"today's plan\"", async () => {
      setParams({ id: 'coffee' });
      seed([COFFEE], { coffee: { target: 100, posted: 40, pending: 0 } });
      server.seed('/budgets/coffee/transactions', []);
      await renderWithQueries(<BudgetDetail />);
      expect(await screen.findByText("today's plan")).toBeTruthy();
      expect(screen.queryByText("today's target")).toBeNull();
    });

    // [A2] (P0) WHIT-715: the detail screen shows the new warning and the plain carry-over line.
    it('[A2] budget detail reads "Over plan — ease up" and "Includes $20 past leftovers"', async () => {
      setParams({ id: 'coffee' });
      seed([COFFEE], { coffee: { target: 100, posted: 100, pending: 0, rollover: true, carryover: 20, available: 120 } });
      server.seed('/budgets/coffee/transactions', []);
      await renderWithQueries(<BudgetDetail />);
      expect(await screen.findByText('Over plan — ease up')).toBeTruthy();
      expect(screen.getByText('Includes $20 past leftovers')).toBeTruthy();
      expect(screen.queryByText(/Ahead of pace|carried over|borrowed/)).toBeNull();
    });
  });
});

describe('WHIT-712 quiet budget rows', () => {
  // WHIT-712 — the Budgets tab rows on screen: an on-pace row is quiet (no "on pace"), an
  // over-budget row says the overspend once, and rows never show carried-over / borrowed text.
  // 14-day cycle, 7 days left → halfway, so a $100 budget's pace target is $50.
  const seed = (coffee: Record<string, unknown>) => seedBudgetsTab(server, { coffee });

  it('an on-pace row shows the money line and no pace line', async () => {
    seed({ target: 100, posted: 50, pending: 0 });
    await renderLoadedBudgetsWithQueries();
    expect(screen.getByText('$50 of $100')).toBeTruthy();
    expect(screen.queryByText(/on pace/)).toBeNull();
  });

  it('an over-budget row with no spread shows the overspend once', async () => {
    seed({ target: 100, posted: 120, pending: 0, rollover: true, carryover: 0 });
    await renderLoadedBudgetsWithQueries();
    expect(screen.getByText('$20')).toBeTruthy();
    expect(screen.getByText('over')).toBeTruthy();
    expect(screen.queryByText(/over budget/)).toBeNull();
  });

  it('a rollover row shows no carried-over or borrowed text', async () => {
    seed({ target: 100, posted: 0, pending: 0, rollover: true, carryover: 200 });
    await renderLoadedBudgetsWithQueries();
    expect(screen.queryByText(/carried over|borrowed|short from|left over from/)).toBeNull();
  });

  // WHIT-712 QA — a budget row is full-strength at rest and dims + shrinks while pressed
  // (DESIGN.md Buttons).

  // The row's Pressable host view: the nearest ancestor of the name that handles touches.
  function rowHost() {
    let node = screen.getByText('Cafes & Coffee').parent;
    while (node && !node.props.onResponderRelease) node = node.parent;
    return node!;
  }
  const rowStyle = () => styleOf(rowHost()) as { opacity?: number; transform?: { scale?: number }[] };
  const touch = { nativeEvent: { timestamp: 0, pageX: 0, pageY: 0, touches: [], changedTouches: [] }, persist: () => {}, currentTarget: { measure: () => {} } };

  // [A5] (P1) at rest the row is full-strength; press-in dims + shrinks it inside DESIGN.md's range.
  it('[A5] a pressed budget row dims and shrinks', async () => {
    seedBudgetsTab(server, { coffee: { target: 100, posted: 50, pending: 0 } });
    await renderLoadedBudgetsWithQueries();
    expect(rowStyle().opacity ?? 1).toBe(1);

    await act(async () => { fireEvent(rowHost(), 'responderGrant', touch); });
    const pressed = rowStyle();
    expect(pressed.opacity).toBeGreaterThanOrEqual(0.6);
    expect(pressed.opacity).toBeLessThanOrEqual(0.85);
    const scale = pressed.transform?.find((t) => t.scale !== undefined)?.scale;
    expect(scale).toBeGreaterThanOrEqual(0.92);
    expect(scale).toBeLessThanOrEqual(0.96);
  });
});

describe('WHIT-714 top card totals', () => {
  // WHIT-714 — the Budgets top card must tell the truth when there are no spending budgets
  // (income-only, Savings-only) and while budgets are still loading.
  const NO_SPENDING = /^No spending budgets yet/;

  beforeEach(() => {
    seedBudgets(server, { categories: [COFFEE, SALARY, SAVINGS], payCycle: { ...BUDGET_PAY_CYCLE, days_left: 4 } });
  });

  describe('WHIT-714 Budgets top card totals', () => {
    it('income-only budgets → no "$0 Left to spend" money column, honest empty wording', async () => {
      server.seed('/budgets', { salary: { target: 5000, posted: 1000, pending: 0 } });
      renderBudgets();
      await screen.findByText('Salary');
      expect(screen.queryByText('Left to spend')).toBeNull();
      expect(screen.queryByTestId('budgets-hero-spent')).toBeNull();
      expect(screen.getByText(NO_SPENDING)).toBeTruthy();
      expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
      expect(screen.queryByText('Add a budget')).toBeNull(); // WHIT-814: the header "+" is the one add button
      expect(screen.getByText('4')).toBeTruthy();
      expect(screen.getByText('days left')).toBeTruthy();
    });

    it('income-only over target → no "Over" text on the top card', async () => {
      server.seed('/budgets', { salary: { target: 1000, posted: 5000, pending: 0 } });
      renderBudgets();
      await screen.findByText('Salary');
      expect(screen.queryByText('Over budget')).toBeNull();
      expect(screen.queryByTestId('budgets-hero-spent')).toBeNull();
    });

    it('Savings-only budgets → not "No budgets yet"; offers "Add a spending budget"', async () => {
      server.seed('/budgets', { rainy: { target: 300, posted: 100, pending: 0 } });
      renderBudgets();
      expect(await screen.findByText(NO_SPENDING)).toBeTruthy();
      expect(screen.queryByText(/No budgets yet/)).toBeNull();
      expect(screen.getByText('Add a spending budget')).toBeTruthy();
      expect(screen.getByTestId('budgets-hero-add')).toBeTruthy();
      expect(screen.queryByText('Add a budget')).toBeNull();
    });

    it('mixed spending + income + Savings → money view from spending rows only', async () => {
      server.seed('/budgets', {
        coffee: { target: 100, posted: 40, pending: 10 },
        salary: { target: 5000, posted: 1000, pending: 0 },
        rainy: { target: 300, posted: 100, pending: 0 },
      });
      await renderLoadedBudgets();
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(heroTotals()).toMatchObject({ spent: '$50', budget: '$100' });
      expect(screen.queryByText(NO_SPENDING)).toBeNull();
    });

    it('while budgets load with the pay cycle ready → a days-only top card above the spinner', async () => {
      const held = server.hold('/budgets');
      renderBudgets();
      expect(await screen.findByText('days left')).toBeTruthy();
      expect(screen.getByText('4')).toBeTruthy();
      expect(heroTotals()).toEqual({ spent: undefined, budget: undefined, payday: expect.stringMatching(/^\d{1,2} [A-Z][a-z]{2}$/) });
      expect(screen.getByTestId('budgets-loading')).toBeTruthy();
      expect(screen.queryByText('Left to spend')).toBeNull();
      expect(screen.queryByText(NO_SPENDING)).toBeNull();
      expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
      held.release();
      expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
      expect(screen.queryByTestId('budgets-loading')).toBeNull();
    });

    it('while the pay cycle is still loading → spinner only, never the default cycle count', async () => {
      const heldPayCycle = server.hold('/paycycle');
      const heldBudgets = server.hold('/budgets');
      renderBudgets();
      await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByTestId('budgets-loading')).toBeTruthy();
      expect(screen.queryByText(/days? left/)).toBeNull();
      heldPayCycle.release();
      heldBudgets.release();
      expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    });
  });

  // WHIT-714 QA: adversarial edges for the Budgets top card with no spending rows and while loading.
  describe('WHIT-714 top card — QA edges', () => {
    // [A2] (P0) income-only → a spending budget is added on refetch → the money view replaces the empty wording
    it('[A2] income-only → spending budget appears on refetch → money column back, empty wording gone', async () => {
      server.seed('/budgets', { salary: { target: 5000, posted: 1000, pending: 0 } });
      const { client } = renderBudgets();
      await screen.findByText(NO_SPENDING);
      server.seed('/budgets', {
        salary: { target: 5000, posted: 1000, pending: 0 },
        coffee: { target: 100, posted: 40, pending: 10 },
      });
      await refreshInAct(() => client.invalidateQueries({ queryKey: ['budgets'] }));
      expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
      expect(screen.queryByText(NO_SPENDING)).toBeNull();
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(heroTotals()).toMatchObject({ spent: '$50', budget: '$100' });
    });

    // [A3] (P1) budgets loaded but categories still loading → days-only card + spinner, never the
    // "No spending budgets yet" prompt (rows are empty only because categories haven't arrived)
    it('[A3] categories still loading → days-only card, no false empty prompt', async () => {
      server.seed('/budgets', { coffee: { target: 100, posted: 40, pending: 10 } });
      const held = server.hold('/categories');
      renderBudgets();
      expect(await screen.findByText('days left')).toBeTruthy();
      expect(screen.getByText('4')).toBeTruthy();
      expect(screen.getByTestId('budgets-loading')).toBeTruthy();
      expect(screen.queryByText(NO_SPENDING)).toBeNull();
      expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
      held.release();
      expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    });

    // [A4] (P1) pay cycle fails while budgets are still loading → error card, never a days card from the default cycle
    it('[A4] pay cycle fails while budgets load → error view, no days-left card', async () => {
      server.fail('/paycycle', 500);
      server.hold('/budgets');
      renderBudgets();
      expect(await screen.findByTestId('budgets-error')).toBeTruthy();
      expect(screen.queryByText(/days? left/)).toBeNull();
      expect(screen.queryByTestId('budgets-loading')).toBeNull();
    });
  });
});

describe('WHIT-716 top card spent and over lines', () => {
  // WHIT-716 — the Budgets top card: the overspend said once ("−$X" + "Over budget"), the big number
  // in the rows' cents format, and "Over budget" from 1 cent over. The Spent and Budget
  // values use the same format (WHIT-735).

  describe('WHIT-716 Budgets top card spent line + over line', () => {
    it('over budget → "−$100" and "Over budget", the amount not repeated', async () => {
      await showBudgets(server, { coffee: { target: 100, posted: 200, pending: 0 } });
      expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();
      expect(screen.getByText('Over budget')).toBeTruthy();
      expect(screen.queryByText(/Over by/)).toBeNull();
    });

    it('big number and Spent keep cents like the rows ("$66.25"; "$83.75" of "$150")', async () => {
      await showBudgets(server, {
        coffee: { target: 100, posted: 73.5, pending: 0 },
        groceries: { target: 50, posted: 10.25, pending: 0 },
      });
      expect(screen.getByText('$66.25')).toBeTruthy();
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(heroTotals()).toMatchObject({ spent: '$83.75', budget: '$150' });
    });

    it('30 cents over → "−$0.30" and "Over budget", never "Left to spend"', async () => {
      await showBudgets(server, { coffee: { target: 100, posted: 100.3, pending: 0 } });
      expect(screen.getByText(`${MINUS}$0.30`)).toBeTruthy();
      expect(screen.getByText('Over budget')).toBeTruthy();
      expect(screen.queryByText('Left to spend')).toBeNull();
    });
  });

  // WHIT-716 QA — adversarial edges of the Budgets top card: spend summed across rows (spend only,
  // once per family, pending included), the 0.005 over cut-off on its exact edge, the Spent and
  // Budget values with cents only when present (WHIT-735), and float dust in the summed cents.
  const CAR = { id: 'car', name: 'Car', bucket: 'Living', icon: 'car', color: '#8AB4F8', parent: null };
  const PARKING = { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8AB4F8', parent: 'car' };

  describe('WHIT-716 QA — spent line totals', () => {
    // [A1] (P0) posted + pending from several rows sums into Spent, cents kept (WHIT-735)
    it('[A1] sums posted + pending across spending rows: Spent "$39.75" of "$150"', async () => {
      await showBudgets(server, {
        coffee: { target: 100, posted: 20, pending: 10.5 },
        groceries: { target: 50, posted: 5, pending: 4.25 },
      });
      expect(heroTotals()).toMatchObject({ spent: '$39.75', budget: '$150' });
    });

    // [A2] (P0) Income and Savings never reach the spent line
    it('[A2] Income and Savings stay out of the spent line', async () => {
      await showBudgets(
        server,
        {
          coffee: { target: 100, posted: 50, pending: 0 },
          salary: { target: 5000, posted: 1000, pending: 300 },
          rainy: { target: 300, posted: 100, pending: 70 },
        },
        { categories: [COFFEE, SALARY, SAVINGS] },
      );
      expect(heroTotals()).toMatchObject({ spent: '$50', budget: '$100' });
    });

    // [A3] (P0) a budgeted sub's spend is already in its parent's rollup → counted once
    it('[A3] a budgeted sub under a budgeted parent does not double-count', async () => {
      await showBudgets(
        server,
        {
          coffee: { target: 100, posted: 0, pending: 0 },
          car: { target: 200, posted: 60, pending: 15 },
          parking: { target: 50, posted: 20, pending: 10 },
        },
        { categories: [COFFEE, CAR, PARKING] },
      );
      expect(heroTotals()).toMatchObject({ spent: '$75', budget: '$300' });
    });
  });

  describe('WHIT-716 QA — money format', () => {
    // [A5] (P0) rollover cents show on Spent and Budget, like the big number (WHIT-735)
    it('[A5] rollover cents: Spent "$50.40" of "$100.40", big number "$50"', async () => {
      await showBudgets(server, { coffee: { target: 100, posted: 50.4, pending: 0, rollover: true, carryover: 0.4 } }, { categories: [COFFEE] });
      expect(heroTotals()).toMatchObject({ spent: '$50.40', budget: '$100.40' });
      expect(screen.getAllByText('$50')).toHaveLength(2); // card's money + the row's left
      expect(screen.getByText('Left to spend')).toBeTruthy();
    });

    // [A6] (P1) summed float cents (0.1 + 0.2) render cleanly, not 0.30000000000000004
    it('[A6] float dust in summed cents: Spent "$0.30" of "$100", left "$99.70"', async () => {
      await showBudgets(server, {
        coffee: { target: 50, posted: 0.1, pending: 0 },
        groceries: { target: 50, posted: 0.2, pending: 0 },
      });
      expect(heroTotals()).toMatchObject({ spent: '$0.30', budget: '$100' });
      expect(screen.getByText('$99.70')).toBeTruthy();
    });

    // [A7] (P0) the card's left equals the rows' lefts added up (both in cents)
    it('[A7] card left matches the rows: $26.50 + $39.75 = $66.25', async () => {
      await showBudgets(server, {
        coffee: { target: 100, posted: 70, pending: 3.5 },
        groceries: { target: 50, posted: 10.25, pending: 0 },
      });
      expect(screen.getByText('$26.50')).toBeTruthy();
      expect(screen.getByText('$39.75')).toBeTruthy();
      expect(screen.getByText('$66.25')).toBeTruthy();
    });
  });

  describe('WHIT-716 QA — over line', () => {
    // [A8] (P0) half a cent over is float dust → calm, no minus; the cut-off is strict
    it('[A8] half a cent over stays "Left to spend" (incl. exactly -0.005)', async () => {
      const first = await showBudgets(server, { coffee: { target: 100, posted: 100, pending: 0.005 } }, { categories: [COFFEE] });
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(screen.queryByText('Over budget')).toBeNull();
      expect(screen.queryAllByText(/−/)).toHaveLength(0);
      first.unmount();

      // 0.005 - 0.01 is exactly -0.005 in floating point: the strict `<` keeps it calm.
      await showBudgets(server, { coffee: { target: 0.005, posted: 0.01, pending: 0 } }, { categories: [COFFEE] });
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(screen.queryByText('Over budget')).toBeNull();
    });

    // [A10] (P1) over budget with pending: the spent line includes it, overspend amount said once
    it('[A10] over with pending → "−$20.50" once, Spent "$120.50", Budget "$100"', async () => {
      await showBudgets(server, { coffee: { target: 100, posted: 90, pending: 30.5 } }, { categories: [COFFEE] });
      expect(screen.getAllByText(`${MINUS}$20.50`)).toHaveLength(1);
      expect(screen.getByText('Over budget')).toBeTruthy();
      expect(heroTotals()).toMatchObject({ spent: '$120.50', budget: '$100' });
    });
  });
});

describe('WHIT-723 shared Budgets screen steps', () => {
  // WHIT-723: the shared Budgets "seed + render + wait" steps. showBudgets seeds the fake server
  // (coffee + groceries, 4 days left unless told otherwise) and hands back a loaded screen;
  // renderLoadedBudgets draws the tab and waits until the coffee row is on screen.

  describe('WHIT-723 shared Budgets screen steps', () => {
    it('showBudgets seeds coffee + groceries with 4 days left by default, and lets a test override both', async () => {
      const first = await showBudgets(server, {
        coffee: { target: 100, posted: 150, pending: 0 },
        groceries: { target: 50, posted: 10, pending: 0 },
      });
      expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
      expect(screen.getByText('Groceries')).toBeTruthy();
      expect(screen.getByText('4')).toBeTruthy();
      expect(screen.getByText('days left')).toBeTruthy();
      expect(screen.queryByText(/resets/)).toBeNull();
      first.unmount();

      await showBudgets(server, { coffee: { target: 100, posted: 150, pending: 0 } }, { categories: [COFFEE], daysLeft: 1 });
      expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
      expect(screen.queryByText('Groceries')).toBeNull();
      expect(screen.getByText('day left')).toBeTruthy();
      expect(screen.queryByText(/resets/)).toBeNull();
    });

    it('renderLoadedBudgets returns an already-loaded screen on the client it was given', async () => {
      seedBudgets(server);
      const client = makeClient();
      const view = await renderLoadedBudgets(client);
      expect(view.client).toBe(client);
      expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    });
  });
});

describe('WHIT-726 top card lines', () => {
  // WHIT-726 → WHIT-731 — Budgets top card: no pill, no "resets in" and no pending on the card. The
  // over-budget values and the Spent · Budget · Next payday order are covered under WHIT-731 below.
  function seedCoffee(coffee: { target: number; posted: number; pending?: number }) {
    seedBudgets(server, {
      budgets: { coffee },
      categories: [COFFEE],
      payCycle: { ...BUDGET_PAY_CYCLE, days_left: 22 },
    });
  }

  // The hero card: the closest host View above the eyebrow that holds the stats row.
  function hero(): ReactTestInstance {
    let node: ReactTestInstance | null = screen.getByText('THIS PAY CYCLE');
    while (node && !(String(node.type) === 'View' && within(node).queryByTestId('budgets-hero-payday'))) node = node.parent;
    if (!node) throw new Error('no hero card');
    return node;
  }

  describe('WHIT-731 Budgets top card: no pill, resets or pending', () => {
    it('over budget with pending → no resets, pending or pill on the card', async () => {
      seedCoffee({ target: 5785, posted: 5948.92, pending: 187.76 });
      await renderLoadedBudgets();

      expect(screen.getByText('Over budget')).toBeTruthy();
      expect(within(hero()).queryByText(/resets/)).toBeNull();
      expect(within(hero()).queryByText(/pending/)).toBeNull();
      expect(screen.queryByTestId('budgets-hero-pill')).toBeNull();
      expect(screen.queryByTestId('budgets-hero-resets')).toBeNull();
    });

    it('under budget → same three values: Spent $4,500.60 · Budget $5,785 · Next payday', async () => {
      seedCoffee({ target: 5785, posted: 4500.6, pending: 0 });
      await renderLoadedBudgets();

      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(heroTotals()).toMatchObject({ spent: '$4,500.60', budget: '$5,785' });
      expect(heroTotals().payday).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);

      expect(within(hero()).queryByText(/resets/)).toBeNull();
      expect(screen.queryByTestId('budgets-hero-pill')).toBeNull();
    });
  });

  // WHIT-726 → WHIT-731 QA — adversarial edges of the Spent · Budget · Next payday row on the Budgets
  // top card: pending is gone from the card and the rows (WHIT-744), the empty state keeps only the payday,
  // and the whole-dollar rounding at the half-dollar edge with thousands separators.

  describe('WHIT-731 QA — the Spent · Budget · Next payday row', () => {
    // [A4] (P1) cents stay when the amount has them (WHIT-735), thousands get commas
    it('[A4] $1,234.50 of $12,345 → Spent "$1,234.50", Budget "$12,345"', async () => {
      await showBudgets(server, { coffee: { target: 12345, posted: 1234, pending: 0.5 } }, { categories: [COFFEE] });
      expect(heroTotals()).toMatchObject({ spent: '$1,234.50', budget: '$12,345' });
    });
  });
});

describe('WHIT-727 urgent rows first', () => {
  // WHIT-727 QA / WHIT-745 — on the Budgets tab, a family whose sub-budget is only behind pace keeps
  // its category order (no pace tier), with the sub directly under its parent.
  useBudgetsSuiteReset();

  // [A4] (P0) the family stays in category order on screen, sub-budget still directly under its parent.
  it('keeps a family with a behind-pace sub in category order, sub under its parent', async () => {
    // 7 of 14 days left → pace is half the budget. Subscriptions $50/$100 on pace; Coffee
    // $100/$200 on pace; its sub Dining $45/$50 is over plan.
    seedBudgetsTab(
      server,
      {
        subs: { target: 100, posted: 50, pending: 0 },
        coffee: { target: 200, posted: 100, pending: 0 },
        dining: { target: 50, posted: 45, pending: 0 },
      },
      [SUBSCRIPTIONS, COFFEE, { ...DINING, parent: 'coffee' }],
    );
    await renderWithQueries(<Budgets />);
    await screen.findByText('Dining');
    const order = screen.getAllByText(/^(Cafes & Coffee|Dining|Subscriptions)$/).map((n) => n.props.children);
    expect(order).toEqual(['Subscriptions', 'Cafes & Coffee', 'Dining']);
  });
});

describe('WHIT-728 rollover and spread rows', () => {
  // WHIT-728 follow-up — on the Budgets tab, a rollover row pulled negative by a carried-over
  // deficit shows "$617.75 of −$659" and the muted "Includes $859 past overspend" under the bar.

  it('a rollover row in deficit shows "$617.75 of −$659" and "Includes $859 past overspend"', async () => {
    seedBudgetsTab(server, {
      coffee: { target: 200, posted: 617.75, pending: 0, rollover: true, carryover: -859, available: -659 },
    });
    await renderLoadedBudgetsWithQueries();
    expect(screen.getByText(`$617.75 of ${MINUS}$659`)).toBeTruthy();
    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $859 past overspend');
  });

  // WHIT-728 follow-up QA — on the Budgets tab a rollover row with saved-up leftovers draws
  // "Includes $40 past leftovers" under the bar, and a plain row draws no note at all.

  // [A3]
  it('a rollover row with leftovers shows "Includes $40 past leftovers"', async () => {
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 50, pending: 0, rollover: true, carryover: 40, available: 140 },
    });
    await renderLoadedBudgetsWithQueries();
    expect(screen.getByText(/^\$50 of \$140/)).toBeTruthy();
    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $40 past leftovers');
  });

  // [A4]
  it('a plain row (no rollover, no spread) draws no note', async () => {
    seedBudgetsTab(server, { coffee: { target: 100, posted: 50, pending: 0 } });
    await renderLoadedBudgetsWithQueries();
    expect(screen.getByText(/^\$50 of \$100/)).toBeTruthy();
    expect(screen.queryByTestId('budget-row-note-coffee')).toBeNull();
  });

  // WHIT-728 — the Budgets tab row keeps the minus on a negative (payback) budget and shows a
  // muted "Includes spread bills" in the line under the bar.

  it('a payback row shows "$617.75 of −$659" and the spread note; the top card budget keeps the minus', async () => {
    seedBudgetsTab(server, {
      // $41 target − $700 payback slice → this cycle's budget is −$659.
      coffee: { target: 41, posted: 617.75, pending: 0, spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 } },
    });
    await renderLoadedBudgetsWithQueries();
    expect(screen.getByText(`$617.75 of ${MINUS}$659`)).toBeTruthy();
    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes spread bills');
    expect(heroTotals().budget).toBe(`${MINUS}$659`);
  });

  it('an on-pace row with a spread cushion still draws the note under the bar', async () => {
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 150, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
    });
    await renderLoadedBudgetsWithQueries();
    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes spread bills');
  });

  // WHIT-728 QA — the top card's Budget total keeps its minus (fold-in), and a spread row that is
  // also off pace still shows its note under the bar.

  // [A2] a cushion row that is over plan → the note is drawn; no pace text (WHIT-744).
  it('a behind-pace spread row shows the note', async () => {
    seedBudgetsTab(server, {
      // $100 + $200 cushion = $300 available; pace runs on the $100 target, so $250 spent is behind,
      // with little room left per day.
      coffee: { target: 100, posted: 250, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
    });
    await renderLoadedBudgetsWithQueries();
    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes spread bills');
    expect(screen.queryByText(/over plan/)).toBeNull();
    expect(screen.getByText(/^\$250 of \$300/)).toBeTruthy();
  });
});

describe('WHIT-730 Budgets polish', () => {
  // WHIT-730 — a budget with nothing spent yet draws as a slim row: no bar, but it keeps its
  // muted note and still opens the budget. A budget with spending keeps its full card and bar.

  it('a $0 budget is a slim row with no bar that keeps its note and still opens the budget', async () => {
    seedBudgetsTab(server, {
      // Nothing spent; a spread cushion makes this cycle's budget $300 and adds the note.
      coffee: { target: 100, posted: 0, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
      groceries: { target: 100, posted: 30, pending: 0 },
    }, [COFFEE, GROCERIES]);
    await renderLoadedBudgetsWithQueries();
    await screen.findByText('Groceries');

    expect(screen.UNSAFE_queryAllByType(BudgetBar)).toHaveLength(1);
    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes spread bills');

    fireEvent.press(screen.getByText('Cafes & Coffee'));
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
  });

  describe('QA', () => {
    // WHIT-730 QA — the Budgets tab as drawn: over rows draw no "today" tick, a $0 row draws no
    // empty note, the small labels are at least 12pt, and the amount
    // column shrinks to fit instead of wrapping. Halfway through a 14-day cycle.
    beforeEach(() => {
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 0, pending: 0 }, // $0 → slim, no note
        groceries: { target: 100, posted: 130, pending: 0 }, // over budget
        subs: { target: 100, posted: 20, pending: 0 }, // under budget
      }, [COFFEE, GROCERIES, SUBS]);
    });

    const fontSize = (node: ReactTestInstance) => styleOf(node).fontSize as number;

    it('[A13] (P0) an over-budget row draws its bar without the tick; an under-plan row keeps it', async () => {
      await renderLoadedBudgetsWithQueries();
      const bars = screen.UNSAFE_queryAllByType(BudgetBar).map((bar) => bar.props);
      expect(bars).toHaveLength(2);
      const over = bars.find((p) => p.postedPct === 100)!;
      const under = bars.find((p) => p.postedPct === 20)!;
      expect(over.showTarget).toBe(false);
      expect(under.showTarget).toBe(true);
    });

    it('[A14] (P1) a $0 row shows no empty note, but keeps its amount left', async () => {
      await renderLoadedBudgetsWithQueries();
      expect(screen.queryByTestId('budget-row-note-coffee')).toBeNull();
      expect(screen.getByText('$100')).toBeTruthy();
    });

    it('[A15] (P1) the "left/over" label is at least 12pt', async () => {
      await renderLoadedBudgetsWithQueries();
      for (const label of screen.getAllByText(/^(left|over)$/)) expect(fontSize(label)).toBeGreaterThanOrEqual(12);
    });

    it('[A16] (P1) the amount shrinks to one line and the label never wraps, so a big number cannot squeeze the name', async () => {
      await renderLoadedBudgetsWithQueries();
      const amount = screen.getByText('$80');
      expect(amount.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
      const left = screen.getAllByText('left')[0];
      expect(left.props.numberOfLines).toBe(1);
      // The amount column is capped so the name keeps the rest of the row.
      const column = amount.parent!.parent!;
      const columnStyle = styleOf(column);
      expect(columnStyle.maxWidth).toBe('45%');
      expect(within(column).getByText('left')).toBeTruthy();
    });

    it('[A17] (P1) a $0 row with a note shows it at 12pt', async () => {
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 0, pending: 0, rollover: true, carryover: 40 },
      }, [COFFEE]);
      await renderLoadedBudgetsWithQueries();
      const note = await screen.findByTestId('budget-row-note-coffee');
      expect(note.props.children).toBe('Includes $40 past leftovers');
      expect(fontSize(note)).toBeGreaterThanOrEqual(12);
      expect(screen.UNSAFE_queryAllByType(BudgetBar)).toHaveLength(0);
    });
  });

  // WHIT-730 follow-up — on the Budgets tab, a slim $0 row lines up with the full rows (same
  // left/right padding), and no row shows an "over plan" line (WHIT-744).

  it('a slim $0 budget row lines up with full rows, and no row shows "over plan"', async () => {
    // Halfway through a 14-day cycle: a $100 budget's pace target is $50.
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 0, pending: 0 },
      groceries: { target: 100, posted: 30, pending: 0 },
      dining: { target: 100, posted: 80, pending: 0 },
    }, [COFFEE, GROCERIES, DINING]);
    await renderLoadedBudgetsWithQueries();
    await screen.findByText('Groceries');

    expect(sidePadding('budget-row-coffee')).toEqual({ left: 16, right: 16 });
    expect(sidePadding('budget-row-groceries')).toEqual({ left: 16, right: 16 });

    expect(screen.queryByText(/over plan/)).toBeNull();
  });

  describe('follow-up QA', () => {
    // WHIT-730 follow-up QA — edges the main suites skip: nested slim rows line up, and a slim row still opens.
    beforeEach(() => resetListTabs(server));
    afterEach(() => {
      jest.useRealTimers();
    });

    // [A1] (P0) a nested slim $0 row (Lattes under Coffee) keeps the full row's 16pt sides and its indent.
    it('[A1] a nested slim $0 row lines up with its full parent row and keeps its indent', async () => {
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 30, pending: 0 },
        latte: { target: 50, posted: 0, pending: 0 },
      }, [COFFEE, LATTE]);
      await renderLoadedBudgetsWithQueries();
      await screen.findByText('Lattes');

      expect(sidePadding('budget-row-latte')).toEqual(sidePadding('budget-row-coffee'));
      expect(sidePadding('budget-row-latte')).toEqual({ left: 16, right: 16 });
      expect(styleOf(screen.getByTestId('budget-row-latte')).marginLeft).toBe(18);
      expect(styleOf(screen.getByTestId('budget-row-latte')).paddingTop).toBe(16);
      expect(styleOf(screen.getByTestId('budget-row-latte')).paddingBottom).toBe(14);
    });

    // [A2] (P0) the slim row is still slim (one bar on screen: the full row's), and opens.
    it('[A2] the slim row has no bar and still opens its budget', async () => {
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 0, pending: 0 },
        groceries: { target: 100, posted: 30, pending: 0 },
      }, [COFFEE, GROCERIES]);
      await renderLoadedBudgetsWithQueries();
      await screen.findByText('Groceries');

      expect(screen.UNSAFE_queryAllByType(BudgetBar)).toHaveLength(1);
      fireEvent.press(screen.getByTestId('budget-row-coffee'));
      expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
    });
  });
});

describe('WHIT-731 top card stats row', () => {
  // WHIT-731 — Budgets top card: the money number is the same size as days-left (cents kept), and one full-width row of three labelled values replaces the two small lines:
  // Spent · Budget · Next payday.
  const STAT_IDS = ['budgets-hero-spent', 'budgets-hero-budget', 'budgets-hero-payday'];

  const showOverBudget = () =>
    showBudgets(server, { coffee: { target: 5785, posted: 5948.92, pending: 187.76 } }, { categories: [COFFEE], daysLeft: 22 });

  function statIdsInOrder() {
    return screen.UNSAFE_root
      .findAll((node) => typeof node.type === 'string' && STAT_IDS.includes(node.props.testID))
      .map((node) => node.props.testID);
  }

  describe('WHIT-731 Budgets top card: Spent · Budget · Next payday row', () => {
    it('over budget → money keeps cents, and the row shows Spent $6,136.68 · Budget $5,785 · Next payday, with no pending on the card', async () => {
      await showOverBudget();

      // 5948.92 posted + 187.76 pending − 5785 budget = 351.68 over.
      expect(screen.getByText(`${MINUS}$351.68`)).toBeTruthy();
      expect(screen.getByText('Over budget')).toBeTruthy();

      expect(screen.getByTestId('budgets-hero-spent')).toHaveTextContent('$6,136.68');
      expect(screen.getByTestId('budgets-hero-budget')).toHaveTextContent('$5,785');
      const payday = screen.getByTestId('budgets-hero-payday');
      expect(payday).toHaveTextContent(/^\d{1,2} [A-Z][a-z]{2}$/);

      expect(screen.getByText('Spent')).toBeTruthy();
      expect(screen.getByText('Budget')).toBeTruthy();
      expect(screen.getByText('Next payday')).toBeTruthy();
      expect(screen.queryByText(/ spent$/)).toBeNull();

      expect(statIdsInOrder()).toEqual(STAT_IDS);

      expect(heroTotals()).toMatchObject({ spent: '$6,136.68', budget: '$5,785' });

      // Pending shows nowhere: not on the card, not on the row (WHIT-744). No "resets" line either.
      expect(screen.queryByText(/pending/)).toBeNull();
      expect(screen.queryByText(/resets/)).toBeNull();
    });

    it('a budget total pulled negative with cents shows the minus and the cents (WHIT-735)', async () => {
      await showBudgets(server, {
        coffee: { target: 200, posted: 10, pending: 0, rollover: true, carryover: -859.5, available: -659.5 },
      }, { categories: [COFFEE] });

      expect(screen.getByTestId('budgets-hero-budget')).toHaveTextContent(`${MINUS}$659.50`);
      expect(screen.getByTestId('budgets-hero-spent')).toHaveTextContent('$10');
    });

    it('the money number is the same size as the days-left number', async () => {
      await showOverBudget();

      const daysLeftSize = styleOf(screen.getByText('22')).fontSize as number;
      const moneySize = styleOf(screen.getByText(`${MINUS}$351.68`)).fontSize as number;

      expect(moneySize).toBe(daysLeftSize);
    });
  });

  // WHIT-731 QA — adversarial edges of the Spent · Budget · Next payday row: the totals survive a
  // missing payday, and huge totals stay on one line instead of wrapping.

  describe('WHIT-731 QA — the Spent · Budget · Next payday row', () => {
    // [A1] (P1) unparseable payday → Spent and Budget still show, the payday cell and its label don't
    it('[A1] no payday date → Spent and Budget still show, no "Next payday" cell', async () => {
      seedBudgets(server, { payCycle: { length: 30, last_pay_date: 'garbage', days_left: 4 } });
      await renderLoadedBudgets();
      expect(heroTotals()).toEqual({ spent: '$50', budget: '$100', payday: undefined });
      expect(screen.getByText('Spent')).toBeTruthy();
      expect(screen.getByText('Budget')).toBeTruthy();
      expect(screen.queryByText('Next payday')).toBeNull();
    });

    // [A2] (P2) huge totals stay one line and shrink to fit rather than wrap
    it('[A2] million-dollar totals → each value is one line that shrinks to fit', async () => {
      await showBudgets(server, { coffee: { target: 1234567, posted: 2345678, pending: 0 } }, { categories: [COFFEE] });
      expect(heroTotals()).toMatchObject({ spent: '$2,345,678', budget: '$1,234,567' });
      for (const id of ['budgets-hero-spent', 'budgets-hero-budget', 'budgets-hero-payday']) {
        const value = screen.getByTestId(id);
        expect(value.props.numberOfLines).toBe(1);
        expect(value.props.adjustsFontSizeToFit).toBe(true);
      }
    });
  });
});

describe('WHIT-732 calm pace', () => {
  // WHIT-732 QA on screen: the Budgets tab shows no pace text (WHIT-744) and lifts no row for
  // pace alone (WHIT-745), and the detail screen's "today's plan" label sits on the base pace
  // of a rollover envelope.
  // [A14] (P0) halfway through: $70 of $100 is calm; $85 of $100 must slow down, but neither moves (WHIT-745).
  it('[A14] neither a slightly-ahead row nor a row that must slow down moves; no pace text', async () => {
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 70, pending: 0 },
      groceries: { target: 100, posted: 85, pending: 0 },
    }, [COFFEE, GROCERIES]);
    await renderLoadedBudgetsWithQueries();
    await screen.findByText('Groceries');
    const order = screen.getAllByTestId(/^budget-row-(coffee|groceries)$/).map((r) => r.props.testID);
    expect(order).toEqual(['budget-row-coffee', 'budget-row-groceries']);
    expect(screen.queryByText(/over plan/)).toBeNull();
  });
  // [A15] (P0) detail: rollover $100 + $100 buffer, halfway → base pace $50 sits a quarter along.
  it("[A15] the detail's \"today's plan\" label sits on the base pace of a rollover envelope", async () => {
    setParams({ id: 'coffee' });
    seedBudgetsTab(server, { coffee: { target: 100, posted: 30, pending: 0, rollover: true, carryover: 100, available: 200 } });
    server.seed('/budgets/coffee/transactions', []);
    await renderWithQueries(<BudgetDetail />);
    const label = await screen.findByText("today's plan");
    expect(styleOf(label).left).toBe('25%');
  });
});

describe('WHIT-735 Budgets polish', () => {
  // WHIT-735 — Budgets polish: the top card's amounts follow one rule (cents only when the amount has them),
  // and a short "nothing spent yet" row uses the full row's 16pt top / 14pt bottom padding.

  // Coffee: 5948.92 posted + 187.76 pending = 6136.68 spent of 5685. Groceries: nothing spent of 100.
  // Totals: spent $6,136.68, budget $5,785, over by $351.68.
  const showOverWithSlimRow = () =>
    showBudgets(server, {
      coffee: { target: 5685, posted: 5948.92, pending: 187.76 },
      groceries: { target: 100, posted: 0, pending: 0 },
    });

  describe('WHIT-735 Budgets polish', () => {
    it('the top card shows cents only when the amount has them: Spent $6,136.68 · Budget $5,785 · −$351.68', async () => {
      await showOverWithSlimRow();

      expect(screen.getByTestId('budgets-hero-spent')).toHaveTextContent('$6,136.68');
      expect(screen.getByTestId('budgets-hero-budget')).toHaveTextContent('$5,785');
      expect(screen.getByText(`${MINUS}$351.68`)).toBeTruthy();
      expect(screen.getByText('Over budget')).toBeTruthy();
    });

    it('a short "nothing spent yet" row has the same top and bottom padding as a full row', async () => {
      await showOverWithSlimRow();
      await screen.findByText('Groceries');

      const full = styleOf(screen.getByTestId('budget-row-coffee'));
      const slim = styleOf(screen.getByTestId('budget-row-groceries'));

      expect({ top: slim.paddingTop, bottom: slim.paddingBottom }).toEqual({ top: 16, bottom: 14 });
      expect({ top: slim.paddingTop, bottom: slim.paddingBottom }).toEqual({ top: full.paddingTop, bottom: full.paddingBottom });
    });
  });

  // WHIT-735 QA — the top card's one rule (cents only when the amount has them) on the cases the
  // build's tests don't draw (under budget with cents, over budget in whole dollars, a budget total
  // with cents). Its tab-label check lives in tabBarDot.screen.test.tsx.

  describe('WHIT-735 QA: top card amounts', () => {
    // [A3] (P0) under budget with cents → no minus, cents kept, "Left to spend".
    it('[A3] under budget with cents shows $249.75 left, Spent $50.25 · Budget $300', async () => {
      await showBudgets(server, {
        coffee: { target: 200, posted: 50.25, pending: 0 },
        groceries: { target: 100, posted: 0, pending: 0 },
      });

      expect(screen.getByText('$249.75')).toBeTruthy();
      expect(screen.getByText('Left to spend')).toBeTruthy();
      expect(screen.queryByText(/^−/)).toBeNull();
      expect(heroTotals()).toMatchObject({ spent: '$50.25', budget: '$300' });
    });

    // [A4] (P0) over budget by whole dollars → a real minus, no ".00".
    it('[A4] over budget by whole dollars shows −$100, not −$100.00', async () => {
      await showBudgets(server, { coffee: { target: 100, posted: 200, pending: 0 } }, { categories: [COFFEE] });

      expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();
      expect(screen.getByText('Over budget')).toBeTruthy();
      expect(heroTotals()).toMatchObject({ spent: '$200', budget: '$100' });
    });

    // [A5] (P1) a positive budget total with cents keeps them (was rounded to whole dollars).
    it('[A5] a budget total of $200.50 shows its cents', async () => {
      await showBudgets(server, {
        coffee: { target: 200, posted: 10, pending: 0, rollover: true, carryover: 0.5, available: 200.5 },
      }, { categories: [COFFEE] });

      expect(heroTotals().budget).toBe('$200.50');
    });
  });
});

describe('WHIT-741 Budgets polish', () => {
  // WHIT-741 — Budgets tab polish at large text: no "·" on the row, the top card's labels and
  // values in separate rows, both big numbers sized together, brighter notes, and a short tick band
  // on every row (WHIT-744).

  // The height of the band under a row's bar that holds the target tick.
  const tickBandHeight = (rowTestID: string) => styleOf(tickBandOf(screen.getByTestId(rowTestID))!).height;

  describe('WHIT-741 Budgets tab polish', () => {
    it('no line on the row starts with "·", and no row shows pending (WHIT-744)', async () => {
      await showTwoRows(server);

      expect(screen.queryByTestId('budget-row-pending-coffee')).toBeNull();
      expect(screen.queryByText(/pending/)).toBeNull();
      expect(textOf(screen.getByTestId('budget-row-coffee'))).not.toContain('·');
    });

    it('the top card puts Spent · Budget · Next payday labels in one row and their values in the next', async () => {
      await showTwoRows(server);

      const spent = screen.getByTestId('budgets-hero-spent');
      const payday = screen.getByTestId('budgets-hero-payday');
      expect(screen.getByTestId('budgets-hero-budget')).toBeTruthy();
      expect(spent.props.numberOfLines).toBe(1);
      expect(spent.props.adjustsFontSizeToFit).toBe(true);

      const valuesRow = sharedHost(spent, payday);
      expect(textOf(valuesRow)).not.toMatch(/Spent|Budget|Next payday/);

      const labelsRow = sharedHost(screen.getByText('Spent'), screen.getByText('Next payday'));
      expect(textOf(labelsRow)).not.toContain('$105');
    });

    it('both big numbers grow and shrink together: same size cap, and the days number never shrinks alone', async () => {
      await showTwoRows(server);

      const days = screen.getByText('7');
      const money = screen.getByText('$95');
      expect(typeof days.props.maxFontSizeMultiplier).toBe('number');
      expect(money.props.maxFontSizeMultiplier).toBe(days.props.maxFontSizeMultiplier);
      expect(days.props.adjustsFontSizeToFit).toBeFalsy();
      expect(styleOf(days).fontSize).toBe(44);
      expect(styleOf(money).fontSize).toBe(44);
    });

    it('every row\'s tick band is short (WHIT-744)', async () => {
      await showTwoRows(server);

      expect(screen.queryByText(/over plan/)).toBeNull();
      expect(tickBandHeight('budget-row-coffee')).toBe(3);
      expect(tickBandHeight('budget-row-groceries')).toBe(3);
    });

    it('the "Includes …" note is a little brighter than the dim sub-line', async () => {
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 150, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
      });
      await renderLoadedBudgetsWithQueries();

      expect(styleOf(screen.getByTestId('budget-row-note-coffee')).color).toBe(C.textMid);
    });
  });

  describe('QA', () => {
    // WHIT-741 QA — the Budgets polish on screen, beyond the main suite: no tick on a "$0 left" row,
    // a note-only row has the short tick band (WHIT-744), the top card's label and value columns line up one-for-one,
    // the days column sizes to its number, "−$" stays glued in the hero and the row, and the detail
    // screen hides "today's plan" on a used-up budget.
    useBudgetsSuiteReset();

    const isHostText = (n: ReactTestInstance) => String(n.type) === 'Text';

    // Host Text children of a host row, in order.
    const hostCells = (row: ReactTestInstance) => row.findAll((n) => isHostText(n) && hostParent(n) === row);

    // The height of the band holding the first tick under `root`.
    const tickBandHeight = (root: ReactTestInstance) => styleOf(tickBandOf(root)!).height;

    // [A13] (P0) a fully used budget ("$0 left") shows its bar with no tick; a budget with money left keeps it.
    it('[A13] "$0 left" row has no tick; a row with money left has one', async () => {
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 100, pending: 0 },
        groceries: { target: 100, posted: 20, pending: 0 },
      }, [COFFEE, GROCERIES]);
      await renderLoadedBudgetsWithQueries();
      await screen.findByText('Groceries');
      expect(tickBandOf(screen.getByTestId('budget-row-coffee'))).toBeNull();
      expect(tickBandOf(screen.getByTestId('budget-row-groceries'))).not.toBeNull();
    });

    // [A14] (P1) a row with a note gets the same short tick band as every row (WHIT-744).
    it('[A14] a note-only row has the short tick band', async () => {
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 20, pending: 0, rollover: true, carryover: 40 },
      });
      await renderLoadedBudgetsWithQueries();
      expect(screen.getByTestId('budget-row-note-coffee')).toBeTruthy();
      expect(screen.queryByText(/over plan/)).toBeNull();
      expect(tickBandHeight(screen.getByTestId('budget-row-coffee'))).toBe(3);
    });

    // [A15] (P0) an earning row never shows a pending line, even with pending money.
    it('[A15] income row with pending has no pending line', async () => {
      seedBudgetsTab(server, { salary: { target: 5000, posted: 1000, pending: 300 } }, [SALARY]);
      await renderWithQueries(<Budgets />);
      await screen.findByText('Salary');
      expect(screen.queryByTestId('budget-row-pending-salary')).toBeNull();
      const rowTexts = screen.getByTestId('budget-row-salary').findAll(isHostText).map((n) => String(n.props.children));
      expect(rowTexts.join(' ')).not.toMatch(/pending/);
    });

    // [A16] (P0) the top card: labels and values line up column for column (same count, same order,
    // same flex), so "26 Oct" sits under "Next payday" whatever wraps.
    it('[A16] hero labels and values are matching columns', async () => {
      seedBudgetsTab(server, { coffee: { target: 100, posted: 40, pending: 0 } });
      await renderLoadedBudgetsWithQueries();
      const valuesRow = hostParent(screen.getByTestId('budgets-hero-spent'));
      const labelsRow = hostParent(screen.getByText('Spent'));
      const labels = hostCells(labelsRow);
      const values = hostCells(valuesRow);
      expect(labels.map((l) => l.props.children)).toEqual(['Spent', 'Budget', 'Next payday']);
      expect(values.map((v) => v.props.testID)).toEqual(['budgets-hero-spent', 'budgets-hero-budget', 'budgets-hero-payday']);
      labels.forEach((label, i) => expect(styleOf(label).flex).toBe(styleOf(values[i]).flex));
      expect(styleOf(labelsRow).flexDirection).toBe('row');
      expect(styleOf(valuesRow).flexDirection).toBe('row');
    });

    // [A17] (P0) the days column sizes to its number (no flex, never shrinks); the money column takes the rest.
    it('[A17] days column is content-sized, money column flexes', async () => {
      seedBudgetsTab(server, { coffee: { target: 100, posted: 40, pending: 0 } });
      await renderLoadedBudgetsWithQueries();
      const daysCol = styleOf(hostParent(screen.getByText('7')));
      const moneyCol = styleOf(hostParent(screen.getByText('Left to spend')));
      expect(daysCol.flex).toBeUndefined();
      expect(daysCol.flexShrink).toBe(0);
      expect(moneyCol.flex).toBe(1);
      expect(moneyCol.minWidth).toBe(0);
    });

    // [A18] (P0) over budget: the hero amount and the Budget total keep the minus glued to "$".
    it('[A18] hero "−$" amounts carry the word joiner', async () => {
      seedBudgetsTab(server, { coffee: { target: 100, posted: 120.5, pending: 0, spreadAdjustment: -150, spread: { amount: 450, cycles: 3, index: 1, adjustment: -150 } } });
      await renderLoadedBudgetsWithQueries();
      expect(heroTotals().budget).toBe(`${MINUS}$50`);
      expect(screen.getByText(`${MINUS}$170.50`)).toBeTruthy();
      expect(screen.getByText(`$120.50 of ${MINUS}$50`)).toBeTruthy();
    });

    // [A19] (P0) detail: a used-up budget hides the tick and "today's plan"; the "of" line has cents.
    it('[A19] used-up budget detail: no "today\'s plan", "of $140.67"', async () => {
      setParams({ id: 'coffee' });
      seedBudgetsTab(server, { coffee: { target: 140.67, posted: 140.67, pending: 0 } });
      server.seed('/budgets/coffee/transactions', []);
      await renderWithQueries(<BudgetDetail />);
      expect(await screen.findByText('of $140.67')).toBeTruthy();
      expect(screen.queryByText("today's plan")).toBeNull();
    });

    // [A20] (P1) detail with money left keeps the default 18pt band (the tab's short tail doesn't leak).
    it('[A20] budget detail with money left keeps "today\'s plan" and its 18pt band', async () => {
      setParams({ id: 'coffee' });
      seedBudgetsTab(server, { coffee: { target: 100, posted: 40, pending: 0 } });
      server.seed('/budgets/coffee/transactions', []);
      const view = await renderWithQueries(<BudgetDetail />);
      expect(await screen.findByText("today's plan")).toBeTruthy();
      expect(tickBandOf(view.UNSAFE_root)).not.toBeNull();
      expect(tickBandHeight(view.UNSAFE_root)).toBe(18);
    });
  });
});

describe('WHIT-742 carryover cycles', () => {
  // WHIT-742 — the budget detail page lists the cycles behind a rollover's carryover under the note,
  // with settling and estimated cycles tagged. The Budgets tab row keeps only the note.

  const UTILITIES = {
    target: 200, posted: 100, pending: 0, rollover: true, carryover: -879, available: -679,
    carryover_cycles: [
      { start: '2026-09-12', end: '2026-09-25', target: 200, spent: 720, leftover: -520, settling: true },
      { start: '2026-08-29', end: '2026-09-11', target: 200, spent: 539, leftover: -339, settling: false, rebuilt: true },
    ],
    carryover_earlier: -20,
  };

  it('the detail page lists each cycle under the carryover note, tagging settling and estimated ones', async () => {
    setParams({ id: 'coffee' });
    seedBudgetsTab(server, { coffee: UTILITIES });
    server.seed('/budgets/coffee/transactions', []);
    await renderWithQueries(<BudgetDetail />);

    await screen.findByText('Includes $879 past overspend');
    const first = within(screen.getByTestId('carryover-cycle-0'));
    expect(first.getByText(/12 Sep – 25 Sep/)).toBeTruthy();
    expect(first.getByText(/settling/)).toBeTruthy();
    expect(first.queryByText(/estimated/)).toBeNull();
    expect(first.getByText('−$520')).toBeTruthy();

    const second = within(screen.getByTestId('carryover-cycle-1'));
    expect(second.getByText(/estimated/)).toBeTruthy();
    expect(second.queryByText(/settling/)).toBeNull();
    expect(second.getByText('−$339')).toBeTruthy();

    const gap = within(screen.getByTestId('carryover-cycle-2'));
    expect(gap.getByText(/Not matched to a cycle/)).toBeTruthy();
    expect(gap.getByText('−$20')).toBeTruthy();
  });

  it('the Budgets tab row keeps only the note, no cycle lines', async () => {
    seedBudgetsTab(server, { coffee: UTILITIES });
    await renderLoadedBudgetsWithQueries();

    expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $879 past overspend');
    expect(screen.queryByTestId('carryover-cycle-0')).toBeNull();
  });

  describe('QA', () => {
    // WHIT-742 QA — the budget detail page on the day this ships: no cycles saved yet, so the whole
    // carryover reads as one "Earlier cycles" line.
    beforeEach(() => {
      setParams({ id: 'coffee' });
      server.seed('/budgets/coffee/transactions', []);
    });

    // [C7] (P0) A budget saved before this change: one "Earlier cycles" line for the whole amount.
    it('with no saved cycles the whole carryover shows as one "Earlier cycles" line', async () => {
      seedBudgetsTab(server, { coffee: {
        target: 200, posted: 100, pending: 0, rollover: true, carryover: -859, available: -659,
        carryover_cycles: [], carryover_earlier: -859,
      } });
      await renderWithQueries(<BudgetDetail />);

      await screen.findByText('Includes $859 past overspend');
      const only = within(screen.getByTestId('carryover-cycle-0'));
      expect(only.getByText(/Earlier cycles/)).toBeTruthy();
      expect(only.getByText('−$859')).toBeTruthy();
      expect(screen.queryByTestId('carryover-cycle-1')).toBeNull();
    });

    // [C8] (P1) A row from a server that hasn't shipped the new fields still renders the note alone.
    it('a rollover row without the new fields shows the note and no cycle lines', async () => {
      seedBudgetsTab(server, { coffee: {
        target: 200, posted: 100, pending: 0, rollover: true, carryover: 136, available: 336,
      } });
      await renderWithQueries(<BudgetDetail />);

      await screen.findByText('Includes $136 past leftovers');
      expect(screen.queryByTestId('carryover-cycle-0')).toBeNull();
    });
  });
});

describe('WHIT-743 large text', () => {
  beforeEach(() => {
    mockLarge = true;
  });

  // WHIT-743 — Budgets at very large text (AX1–AX5): stack instead of squeeze, so no word splits
  // mid-word, both big top-card numbers stay one size, the detail status line wraps, and "of" stays
  // with its amount.
  const rowParts = (id: string, name: string, remain: string) => {
    const row = within(screen.getByTestId(`budget-row-${id}`));
    return { name: row.getByText(name), remain: row.getByText(remain) };
  };

  describe('WHIT-743 Budgets tab at very large text', () => {
    it('a budget row stacks: the amount sits below the name, not squeezed beside it', async () => {
      await showTwoRows(server);
      const { name, remain } = rowParts('coffee', 'Cafes & Coffee', '$20');

      expect(styleOf(sharedHost(name, remain)).flexDirection).not.toBe('row');
      for (let host: ReactTestInstance | null = remain.parent; host; host = host.parent) {
        if (typeof host.type === 'string') expect(styleOf(host).maxWidth).not.toBe('45%');
      }
    });

    it('row name, sub-lines and amount stop growing at about 2× so no word splits mid-word', async () => {
      await showTwoRows(server);
      const row = within(screen.getByTestId('budget-row-coffee'));
      const texts = [
        row.getByText('Cafes & Coffee'),
        row.getByText(/^\$80 of/),
        row.getByText('$20'),
      ];
      for (const text of texts) {
        expect(typeof text.props.maxFontSizeMultiplier).toBe('number');
        expect(text.props.maxFontSizeMultiplier).toBeLessThanOrEqual(2);
      }
    });

    it('the top card stacks the days and money numbers, and both stay the same size', async () => {
      await showTwoRows(server);
      const days = screen.getByText('7');
      const money = screen.getByText('$95');

      expect(styleOf(sharedHost(days, money)).flexDirection).not.toBe('row');
      expect(styleOf(money).fontSize).toBe(styleOf(days).fontSize);
      expect(typeof days.props.maxFontSizeMultiplier).toBe('number');
      expect(money.props.maxFontSizeMultiplier).toBe(days.props.maxFontSizeMultiplier);
    });

    it('the top card shows each stat as its own label-above-value pair', async () => {
      await showTwoRows(server);
      const pairs: [string, string][] = [['Spent', 'budgets-hero-spent'], ['Budget', 'budgets-hero-budget'], ['Next payday', 'budgets-hero-payday']];
      for (const [label, testID] of pairs) {
        const pair = textOf(sharedHost(screen.getByText(label), screen.getByTestId(testID)));
        const others = pairs.filter(([other]) => other !== label).map(([other]) => other);
        for (const other of others) expect(pair).not.toContain(other);
      }
    });

    it('the tab title cannot grow taller than its fixed-height title bar (no covering "THIS PAY CYCLE")', async () => {
      await showTwoRows(server);
      const title = screen.UNSAFE_getAllByType(Text).find((t) => textOf(t) === 'Budgets' && styleOf(t).fontSize === 19)!;
      expect(title).toBeTruthy();
      expect(typeof title.props.maxFontSizeMultiplier).toBe('number');
      // The bar is HEADER_BODY_HEIGHT tall with 6 top + 12 bottom padding → 40px for the title.
      expect(19 * title.props.maxFontSizeMultiplier).toBeLessThanOrEqual(HEADER_BODY_HEIGHT - 18);
    });

    it('at normal text the row keeps its side-by-side layout', async () => {
      mockLarge = false;
      await showTwoRows(server);
      const { name, remain } = rowParts('coffee', 'Cafes & Coffee', '$20');
      expect(styleOf(sharedHost(name, remain)).flexDirection).toBe('row');
    });
  });

  describe('WHIT-743 budget detail at very large text', () => {
    const showDetail = async () => {
      setParams({ id: 'coffee' });
      seedBudgetsTab(server, { coffee: { target: 100, posted: 40, pending: 0 } });
      server.seed('/budgets/coffee/transactions', []);
      await renderWithQueries(<BudgetDetail />);
      return screen.findByText('On track for payday');
    };

    it('the status line wraps inside the card instead of running off the right edge', async () => {
      const status = await showDetail();
      expect(styleOf(hostParent(status)).flexWrap).toBe('wrap');
      expect(styleOf(status).flexShrink).toBe(1);
    });

    it('the name/amount column can shrink and "of $X" can drop under the big number', async () => {
      await showDetail();
      const of = await screen.findByText(/^of.\$100$/);
      const spentRow = hostParent(of);
      expect(styleOf(spentRow).flexWrap).toBe('wrap');
      const column = hostParent(spentRow);
      expect(styleOf(column).flex).toBe(1);
      expect(styleOf(column).minWidth).toBe(0);
    });

    it('an earning budget keeps "of" glued to its amount with a no-break space', () => {
      const detail = budgetDetailFor({ budget: 5000, posted: 1000 }, undefined, SALARY);
      expect(detail.ofBudget.startsWith('of ')).toBe(true);
    });
  });

  // WHIT-743 QA — the edges the proof tests leave: every row text is capped (sign-off answer A),
  // the note wraps, the money number alone may still shrink-to-fit (critic tweak), the stats
  // keep their values, the over-budget and earning-only top cards, and the normal layout is untouched.
  // 14-day cycle, 7 days left (pace = half). Coffee $80 of $100 → "$20 left".
  // Groceries $25 of $100 + $200 spread → the spread note. Totals $105 of $400 → "$295".
  const showRows = async () => {
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 70, pending: 10 },
      groceries: { target: 100, posted: 25, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
    }, [COFFEE, GROCERIES]);
    await renderLoadedBudgetsWithQueries();
    await screen.findByText('Groceries');
  };

  const coffeeRow = () => within(screen.getByTestId('budget-row-coffee'));

  describe('WHIT-743 QA — Budgets tab at very large text', () => {
    // [A2]
    it('every row text (name, spent line, amount, its label, note) is capped at 2×', async () => {
      await showRows();
      const row = coffeeRow();
      const texts = [
        row.getByText('Cafes & Coffee'),
        row.getByText(/^\$80 of/),
        row.getByText('$20'),
        row.getByText('left'),
        screen.getByTestId('budget-row-note-groceries'),
      ];
      expect(LARGE_TEXT_MAX_SCALE).toBe(2);
      for (const text of texts) expect(text.props.maxFontSizeMultiplier).toBe(LARGE_TEXT_MAX_SCALE);
    });

    // [A3]
    it('the note has no line limit, so it wraps, and its cap is the large-text cap', async () => {
      await showRows();
      const note = screen.getByTestId('budget-row-note-groceries');
      expect(note.props.numberOfLines).toBeUndefined();
      expect(note.props.maxFontSizeMultiplier).toBe(LARGE_TEXT_MAX_SCALE);
    });

    // [A4]
    it('the stacked amount keeps one line and spans the row (no 45% cap)', async () => {
      await showRows();
      const remain = coffeeRow().getByText('$20');
      expect(remain.props.numberOfLines).toBe(1);
      for (let host = remain.parent; host; host = host.parent) {
        if (host.props.testID === 'budget-row-coffee') break;
        if (typeof host.type === 'string') expect(styleOf(host).maxWidth).toBeUndefined();
      }
    });

    // [A5]
    it('the money number may still shrink to fit, the days number never does; both one line', async () => {
      await showRows();
      const days = screen.getByText('7');
      const money = screen.getByText('$295');
      expect(money.props.adjustsFontSizeToFit).toBe(true);
      expect(days.props.adjustsFontSizeToFit).toBeFalsy();
      expect(days.props.numberOfLines).toBe(1);
      expect(money.props.numberOfLines).toBe(1);
      expect(styleOf(days).fontSize).toBe(styleOf(money).fontSize);
    });

    // [A6]
    it('stacked stats keep their values and testIDs, each at full width', async () => {
      await showRows();
      expect(textOf(screen.getByTestId('budgets-hero-spent'))).toBe('$105');
      expect(textOf(screen.getByTestId('budgets-hero-budget'))).toBe('$400');
      expect(textOf(screen.getByTestId('budgets-hero-payday'))).not.toBe('');
      for (const testID of ['budgets-hero-spent', 'budgets-hero-budget', 'budgets-hero-payday']) {
        expect(styleOf(screen.getByTestId(testID)).flex).toBeUndefined();
      }
      expect(styleOf(screen.getByText('Next payday')).flex).toBeUndefined();
    });

    // [A7]
    it('over budget: the "Over budget" label sits under the money, not beside the days', async () => {
      seedBudgetsTab(server, { coffee: { target: 100, posted: 150, pending: 0 } });
      await renderLoadedBudgetsWithQueries();
      const label = await screen.findByText('Over budget');
      expect(styleOf(sharedHost(label, screen.getByText('days left'))).flexDirection).not.toBe('row');
    });

    // [A8]
    it('an earning-only list shows the days block alone, with no money or stats', async () => {
      seedBudgetsTab(server, { salary: { target: 5000, posted: 1000, pending: 0 } }, [SALARY]);
      await renderWithQueries(<Budgets />);
      await screen.findByText('Salary');
      expect(screen.getByText('7')).toBeTruthy();
      expect(screen.queryByTestId('budgets-hero-spent')).toBeNull();
      expect(screen.queryByText('Left to spend')).toBeNull();
    });
  });

  describe('WHIT-743 QA — Budgets tab at normal text', () => {
    beforeEach(() => { mockLarge = false; });

    // [A9]
    it('the stats keep their label row and value row of three', async () => {
      await showRows();
      const labels = sharedHost(screen.getByText('Spent'), screen.getByText('Next payday'));
      expect(styleOf(labels).flexDirection).toBe('row');
      expect(textOf(labels)).toBe('SpentBudgetNext payday');
      const values = sharedHost(screen.getByTestId('budgets-hero-spent'), screen.getByTestId('budgets-hero-payday'));
      expect(styleOf(values).flexDirection).toBe('row');
      expect(styleOf(screen.getByTestId('budgets-hero-spent')).flex).toBe(1);
    });

    // [A10]
    it('the amount column keeps its 45% cap', async () => {
      await showRows();
      const row = coffeeRow();
      expect(styleOf(sharedHost(row.getByText('$20'), row.getByText('left'))).maxWidth).toBe('45%');
    });
  });
});

describe('WHIT-744 quiet budget rows', () => {
  // WHIT-744 — Budgets tab rows go quiet: no pending line, no over/under plan line, and every
  // "Includes …" note starts at the left, the same distance below the bar whether or not the row
  // draws a pace tick.

  describe('WHIT-744 quiet Budgets tab rows', () => {
    it('rows show no pending or plan line, keep a short tick, and put every note the same distance below the bar', async () => {
      // Halfway through a 14-day cycle. Coffee: $80 spent ($10 pending) of $105 → under budget but
      // spending too fast, draws a tick, note "Includes $5 past leftovers". Groceries: $150 of $50
      // → over budget, no tick, note "Includes $50 past overspend".
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 70, pending: 10, rollover: true, carryover: 5 },
        groceries: { target: 100, posted: 150, pending: 0, rollover: true, carryover: -50 },
      }, [COFFEE, GROCERIES]);
      await renderLoadedBudgetsWithQueries();
      await screen.findByText('Groceries');

      expect(screen.queryByTestId('budget-row-pending-coffee')).toBeNull();
      expect(screen.queryByText(/pending/)).toBeNull();
      expect(screen.queryByText(/over plan/)).toBeNull();
      expect(screen.queryByText(/under plan/)).toBeNull();
      expect(within(screen.getByTestId('budget-row-coffee')).getByText('$25')).toBeTruthy();
      expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $5 past leftovers');
      expect(screen.getByTestId('budget-row-note-groceries').props.children).toBe('Includes $50 past overspend');

      const coffeeBand = tickBandOf(screen.getByTestId('budget-row-coffee'));
      expect(coffeeBand).not.toBeNull();
      expect(styleOf(coffeeBand!).height).toBe(3);
      expect(tickBandOf(screen.getByTestId('budget-row-groceries'))).toBeNull();

      expect(noteOffsetBelowBar('coffee')).toBe(noteOffsetBelowBar('groceries'));
      expect(noteOffsetBelowBar('coffee')).toBeGreaterThan(4);

      // QA [A3]: the bar keeps its lighter pending part. Posted $70 and pending $10 of $105: the
      // pending segment starts where posted ends and has width.
      const segments = screen.getByTestId('budget-row-coffee')
        .findAll((n) => typeof n.type === 'string' && typeof styleOf(n).left === 'string' && typeof styleOf(n).width === 'string');
      expect(segments).toHaveLength(1);
      expect(parseFloat(String(styleOf(segments[0]).width))).toBeGreaterThan(5);
    });
  });

  // WHIT-744 QA — the edges the proof test leaves: notes still line up at very large text (WHIT-743
  // layout kept), a row spent exactly to its budget (no tick, not over) lines up with a ticked spread
  // row, and the bar keeps its lighter pending part now the pending line is gone.

  // Halfway through a 14-day cycle. Coffee: $80 ($10 pending) of $105 → ticked, "Includes $5 past
  // leftovers". Groceries: $150 of $50 → over, no tick, "Includes $50 past overspend".
  const showTickAndOver = async () => {
    seedBudgetsTab(server, {
      coffee: { target: 100, posted: 70, pending: 10, rollover: true, carryover: 5 },
      groceries: { target: 100, posted: 150, pending: 0, rollover: true, carryover: -50 },
    }, [COFFEE, GROCERIES]);
    await renderLoadedBudgetsWithQueries();
    await screen.findByText('Groceries');
  };

  describe('WHIT-744 QA — quiet Budgets rows', () => {
    // [A1] (P0)
    it('[A1] at very large text, a ticked and an unticked row still put the note the same distance below the bar', async () => {
      mockLarge = true;
      await showTickAndOver();
      expect(tickBandOf(screen.getByTestId('budget-row-coffee'))).not.toBeNull();
      expect(tickBandOf(screen.getByTestId('budget-row-groceries'))).toBeNull();
      expect(noteOffsetBelowBar('coffee')).toBe(noteOffsetBelowBar('groceries'));
      expect(screen.queryByText(/pending|over plan|under plan/)).toBeNull();
    });

    // [A2] (P1)
    it('[A2] a row spent exactly to its budget (no tick, not over) lines up with a ticked spread-bills row', async () => {
      // Coffee: $105 of $105 ($100 + $5 leftovers) → $0 left, not over, no tick. Groceries: $25 of $300
      // with a $200 spread → ticked, "Includes spread bills".
      seedBudgetsTab(server, {
        coffee: { target: 100, posted: 105, pending: 0, rollover: true, carryover: 5 },
        groceries: { target: 100, posted: 25, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
      }, [COFFEE, GROCERIES]);
      await renderLoadedBudgetsWithQueries();
      await screen.findByText('Groceries');
      expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $5 past leftovers');
      expect(screen.getByTestId('budget-row-note-groceries').props.children).toBe('Includes spread bills');
      expect(tickBandOf(screen.getByTestId('budget-row-coffee'))).toBeNull();
      expect(tickBandOf(screen.getByTestId('budget-row-groceries'))).not.toBeNull();
      expect(noteOffsetBelowBar('coffee')).toBe(noteOffsetBelowBar('groceries'));
    });
  });
});

describe('WHIT-745 only over-budget rows move up', () => {
  // WHIT-745 on screen: only an over-budget row moves up. A fully used (behind-pace) Mortgage keeps its
  // category place below Coffee, and the Budgets tab sends no charge-list lookups.

  const rowOrder = () =>
    screen.getAllByTestId(/^budget-row-(mortgage|coffee|groceries)$/).map((r) => r.props.testID);

  it('lifts only the over-budget row; a fully used mortgage keeps its place and no charge lists are fetched', async () => {
    // Halfway through a 14-day cycle: Coffee on pace, Mortgage fully used (behind pace), Groceries over.
    seedBudgetsTab(
      server,
      {
        coffee: { target: 100, posted: 40, pending: 0 },
        mortgage: { target: 3667, posted: 3667, pending: 0 },
        groceries: { target: 100, posted: 150, pending: 0 },
      },
      [COFFEE, MORTGAGE_RECORD, GROCERIES_RECORD],
    );
    await renderLoadedBudgetsWithQueries();
    await waitFor(() =>
      expect(rowOrder()).toEqual(['budget-row-groceries', 'budget-row-coffee', 'budget-row-mortgage']),
    );
    expect(server.sentUnder('GET', '/budgets/')).toEqual([]);
  });

  // WHIT-745 QA on screen: a pull-to-refresh with a fully used Mortgage still sends no charge-list
  // lookups and doesn't move it; pending charges that tip it over do move it.

  // [A6] (P0) refreshing the tab doesn't bring the lookups back or lift the fully used bill.
  it('a pull-to-refresh sends no charge-list lookups and keeps a fully used mortgage below coffee', async () => {
    seedBudgetsTab(
      server,
      {
        coffee: { target: 100, posted: 40, pending: 0 },
        mortgage: { target: 3667, posted: 3667, pending: 0 },
      },
      [COFFEE, MORTGAGE_RECORD],
    );
    await renderLoadedBudgetsWithQueries();
    await waitFor(() => expect(rowOrder()).toEqual(['budget-row-coffee', 'budget-row-mortgage']));
    await pullAndSettle();
    expect(rowOrder()).toEqual(['budget-row-coffee', 'budget-row-mortgage']);
    expect(server.sentUnder('GET', '/budgets/')).toEqual([]);
  });

  // [A7] (P1) a mortgage that tips over budget by pending charges moves above coffee on screen.
  it('a mortgage pushed over by a pending charge moves above coffee', async () => {
    seedBudgetsTab(
      server,
      {
        coffee: { target: 100, posted: 40, pending: 0 },
        mortgage: { target: 3667, posted: 3600, pending: 100 },
      },
      [COFFEE, MORTGAGE_RECORD],
    );
    await renderLoadedBudgetsWithQueries();
    await waitFor(() => expect(rowOrder()).toEqual(['budget-row-mortgage', 'budget-row-coffee']));
  });
});
