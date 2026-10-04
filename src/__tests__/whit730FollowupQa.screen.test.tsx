// WHIT-730 follow-up QA — edges the main suites skip: nested slim rows line up, the spread link keeps its accent + bold, and a nested row's "under plan" is muted.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { fireEvent, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { C } from '../theme';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { routerSpies } from './support/routerMock';
import { resetListTabs } from './support/listTabsScreen';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries, sidePadding } from './support/budgetsScreen';
import { COFFEE, GROCERIES, LATTE } from './support/categories';
import { BudgetBar } from '../components/ui';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetListTabs(server);
});

const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style);

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
  expect(flat(screen.getByTestId('budget-row-latte')).marginLeft).toBe(18);
  // Still slim: tighter top/bottom than the full row.
  expect(flat(screen.getByTestId('budget-row-latte')).paddingTop).toBe(12);
  expect(flat(screen.getByTestId('budget-row-latte')).paddingBottom).toBe(12);
});

// [A2] (P0) the slim row is still slim (one bar on screen: the full row's), shows no pace line, and opens.
it('[A2] the slim row has no bar or pace line and still opens its budget', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 0, pending: 0 },
    groceries: { target: 100, posted: 30, pending: 0 },
  }, [COFFEE, GROCERIES]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');

  expect(screen.UNSAFE_queryAllByType(BudgetBar)).toHaveLength(1);
  expect(screen.queryByText('$50 under plan')).toBeNull();
  fireEvent.press(screen.getByTestId('budget-row-coffee'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
});

// [A3] (P0) the spread link is neither behind pace nor under plan: it keeps its accent colour and bold.
it('[A3] the "Spread it over pay cycles →" link stays accent and bold', async () => {
  seedBudgetsTab(server, { coffee: { target: 80, posted: 90.25, pending: 0 } });
  await renderLoadedBudgetsWithQueries();

  const spread = flat(await screen.findByText('Spread it over pay cycles →'));
  expect(spread.color).toBe(C.accentSoft);
  expect(spread.fontWeight).toBe('700');
});

// [A4] (P0) "under plan" on a nested row is muted too (grey, not bold).
it('[A4] a nested row\'s "under plan" is grey and not bold', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 30, pending: 0 },
    latte: { target: 100, posted: 10, pending: 0 },
  }, [COFFEE, LATTE]);
  await renderLoadedBudgetsWithQueries();

  const under = flat(await screen.findByText('$40 under plan'));
  expect(under.color).toBe(C.textDim);
  expect(under.fontWeight).toBe('400');
});
