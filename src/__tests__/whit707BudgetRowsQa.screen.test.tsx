// WHIT-707 QA — the Budgets tab and budget detail on screen: headings only for sections with rows,
// section order, the income "next pay" text from the real pay-cycle clock, the quiet over line vs
// the spread link, the row press still opening the detail, and "today's pace" on the detail screen.
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { routerSpies, resetRouter, setParams } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { pinToday } from './support/clock';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: jest.fn(), openPicker: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';
import BudgetDetail from '../../app/budget/[id]';
import { resetAuth } from './support/authMock';

const server = installFakeServer();
useTestQueryClient();

const SALARY = { id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#35d9a0', recent: 0 };
const COFFEE = { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 };

function seed(categories: unknown[], budgets: Record<string, unknown>, daysLeft = 6) {
  server.seed('/paycycle', { length: 14, last_pay_date: '2026-09-25', days_left: daysLeft });
  server.seed('/categories', categories);
  server.seed('/budgets', budgets);
}

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(new Date('2026-10-03T10:00:00+10:00')); // Sat 3 Oct 2026, Melbourne
});
afterEach(() => {
  jest.useRealTimers();
});

// [A20] (P0) spend only → SPENDING heading, no EARNING heading.
it('[A20] no income budgets → no EARNING heading', async () => {
  seed([COFFEE], { coffee: { target: 100, posted: 40, pending: 0 } });
  await renderWithQueries(<Budgets />);
  await screen.findByText('Cafes & Coffee');
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
    coffee: { target: 100, posted: 40, pending: 0 },
  });
  await renderWithQueries(<Budgets />);
  await screen.findByText('Salary');
  const order = screen.getAllByText(/^(SPENDING|EARNING|Salary|Cafes & Coffee)$/).map((n) => n.props.children);
  expect(order).toEqual(['SPENDING', 'Cafes & Coffee', 'EARNING', 'Salary']);
  expect(screen.getByText('$1,000 earned · next pay ~Fri')).toBeTruthy();
  expect(screen.getAllByText('to go')).toHaveLength(1);
  expect(screen.queryByText(/ahead of pace|\$[\d,]+ to go|on pace|over target/)).toBeNull();
});

// [A23] (P0) payday more than 6 days away (fortnightly, 14 days left) → the date.
it('[A23] 14 days left → "next pay ~17 Oct"', async () => {
  seed([SALARY], { salary: { target: 5000, posted: 1000, pending: 0 } }, 14);
  server.seed('/paycycle', { length: 14, last_pay_date: '2026-10-03', days_left: 14 }); // paid today → next pay in 14 days
  await renderWithQueries(<Budgets />);
  expect(await screen.findByText('$1,000 earned · next pay ~17 Oct')).toBeTruthy();
});

// [A24] (P0) over but rollover → quiet "$X over budget", no spread link.
it('[A24] over + rollover → quiet text, no spread link', async () => {
  seed([COFFEE], { coffee: { target: 100, posted: 120, pending: 0, rollover: true, carryover: 0 } });
  await renderWithQueries(<Budgets />);
  await screen.findByText('Cafes & Coffee');
  expect(screen.getByText('$20 over budget')).toBeTruthy();
  expect(screen.queryByTestId('budget-row-spread-coffee')).toBeNull();
  expect(screen.queryByText('Spread it over pay cycles →')).toBeNull();
});

// [A25] (P0) the spread link carries exact-cents prefill; pressing the row body still opens detail.
it('[A25] spread link prefill keeps cents; the row press still opens the detail', async () => {
  seed([COFFEE], { coffee: { target: 80, posted: 90.25, pending: 0 } });
  await renderWithQueries(<Budgets />);
  await screen.findByText('Cafes & Coffee');
  fireEvent.press(screen.getByTestId('budget-row-spread-coffee'));
  expect(routerSpies.push).toHaveBeenCalledTimes(1);
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=10.25');
  routerSpies.push.mockClear();
  fireEvent.press(screen.getByText('Cafes & Coffee'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
});

// [A26] (P1) pending is named on the row.
it('[A26] a row with pending reads "spent of … · … pending"', async () => {
  seed([COFFEE], { coffee: { target: 100, posted: 40, pending: 10 } });
  await renderWithQueries(<Budgets />);
  expect(await screen.findByText('$50 spent of $100 · $10 pending')).toBeTruthy();
});

// [A27] (P1) the detail screen's marker uses the same word: "today's pace", not "today's target".
it("[A27] budget detail labels the marker \"today's pace\"", async () => {
  setParams({ id: 'coffee' });
  seed([COFFEE], { coffee: { target: 100, posted: 40, pending: 0 } });
  server.seed('/budgets/coffee/transactions', []);
  await renderWithQueries(<BudgetDetail />);
  expect(await screen.findByText("today's pace")).toBeTruthy();
  expect(screen.queryByText("today's target")).toBeNull();
});
