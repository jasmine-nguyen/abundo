// WHIT-743 QA — the edges the proof tests leave: every row text is capped (sign-off answer A),
// the pace line wraps, the money number alone may still shrink-to-fit (critic tweak), the stats
// keep their values, the over-budget and earning-only top cards, and the normal layout is untouched.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, within } from '@testing-library/react-native';
import React from 'react';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { COFFEE, GROCERIES, SALARY } from './support/categories';
import { styleOf, sharedHost, textOf } from './support/layout';
import { LARGE_TEXT_MAX_SCALE } from '../hooks/useLargeText';

let mockLarge = true;
jest.mock('../hooks/useLargeText', () =>
  require('./support/largeTextMock').largeTextMockModule(() => mockLarge));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  mockLarge = true;
  resetRouter();
  resetAuth();
});

// 14-day cycle, 7 days left (pace = half). Coffee $80 of $100 → "$20 left", "$30 over plan".
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

// The line under the bar holding the note and the "over plan" pace text (pace Text → its View → the line).
function paceLine() {
  let hosts = 0;
  for (let host = coffeeRow().getByText(/over plan$/).parent; host; host = host.parent) {
    if (typeof host.type === 'string') hosts += 1;
    if (hosts === 2) return host;
  }
  throw new Error('no pace line');
}

describe('WHIT-743 QA — Budgets tab at very large text', () => {
  // [A2]
  it('every row text (name, spent line, pending, amount, its label, note, pace) is capped at 2×', async () => {
    await showRows();
    const row = coffeeRow();
    const texts = [
      row.getByText('Cafes & Coffee'),
      row.getByText(/^\$80 of/),
      screen.getByTestId('budget-row-pending-coffee'),
      row.getByText('$20'),
      row.getByText('left'),
      screen.getByTestId('budget-row-note-groceries'),
      row.getByText(/over plan$/),
    ];
    expect(LARGE_TEXT_MAX_SCALE).toBe(2);
    for (const text of texts) expect(text.props.maxFontSizeMultiplier).toBe(LARGE_TEXT_MAX_SCALE);
  });

  // [A3]
  it('the note and "over plan" line wraps instead of squeezing', async () => {
    await showRows();
    expect(styleOf(paceLine()).flexWrap).toBe('wrap');
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
  it('the amount column keeps its 45% cap and the pace line does not wrap', async () => {
    await showRows();
    const row = coffeeRow();
    expect(styleOf(sharedHost(row.getByText('$20'), row.getByText('left'))).maxWidth).toBe('45%');
    expect(styleOf(paceLine()).flexWrap).toBeUndefined();
  });
});
