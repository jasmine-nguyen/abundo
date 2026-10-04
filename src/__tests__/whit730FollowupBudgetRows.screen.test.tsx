// WHIT-730 follow-up — on the Budgets tab, a slim $0 row lines up with the full rows (same
// left/right padding), "$X under plan" is quiet (grey, not bold) while "over plan" stays amber and bold.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { C } from '../theme';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { COFFEE, GROCERIES, DINING } from './support/categories';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

const sidePadding = (testID: string) => {
  const style = StyleSheet.flatten(screen.getByTestId(testID).props.style);
  return {
    left: style.paddingLeft ?? style.paddingHorizontal ?? style.padding,
    right: style.paddingRight ?? style.paddingHorizontal ?? style.padding,
  };
};

it('a slim $0 budget row lines up with full rows, and "under plan" is muted while "over plan" stays amber', async () => {
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

  const under = StyleSheet.flatten(screen.getByText('$20 under plan').props.style);
  expect(under.color).toBe(C.textDim);
  expect(under.fontWeight).not.toBe('700');

  const over = StyleSheet.flatten(screen.getByText('$30 over plan').props.style);
  expect(over.color).toBe(C.warn);
  expect(over.fontWeight).toBe('700');
});
