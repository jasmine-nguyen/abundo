// WHIT-730 QA — the Budgets tab as drawn: over rows draw no "today" tick, a $0 row draws no
// empty note, the small labels are at least 12pt, and the amount
// column shrinks to fit instead of wrapping. Halfway through a 14-day cycle.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { BudgetBar } from '../components/ui';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { COFFEE, GROCERIES, SUBS } from './support/categories';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 0, pending: 0 }, // $0 → slim, no note
    groceries: { target: 100, posted: 130, pending: 0 }, // over budget
    subs: { target: 100, posted: 20, pending: 0 }, // under budget
  }, [COFFEE, GROCERIES, SUBS]);
});

const fontSize = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style).fontSize as number;

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
  const columnStyle = StyleSheet.flatten(column.props.style);
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
