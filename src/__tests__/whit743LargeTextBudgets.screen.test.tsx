// WHIT-743 — Budgets at very large text (AX1–AX5): stack instead of squeeze, so no word splits
// mid-word, both big top-card numbers stay one size, the detail status line wraps, and "of" stays
// with its amount. The large-text switch (../hooks/useLargeText) is forced on/off per test; the
// screens and ../queries run for real over the fake server.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { screen, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { resetRouter, setParams } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab, budgetDetailFor } from './support/budgetsTab';
import { showTwoRows } from './support/budgetsScreen';
import { SALARY } from './support/categories';
import { hostParent, sharedHost, styleOf, textOf } from './support/layout';
import { HEADER_BODY_HEIGHT } from '../motion/ScrollChromeHeader';

let mockLarge = true;
jest.mock('../hooks/useLargeText', () =>
  require('./support/largeTextMock').largeTextMockModule(() => mockLarge));
jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetDetail from '../../app/budget/[id]';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  mockLarge = true;
  resetRouter();
  resetAuth();
});

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
