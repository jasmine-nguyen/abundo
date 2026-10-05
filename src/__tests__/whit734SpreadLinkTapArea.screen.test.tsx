// WHIT-734 — the "Spread it over pay cycles →" link on a budget row needs a tap area at least
// 44pt tall (Apple's minimum) without changing the row layout, and must not reach sideways over
// the note on its left. Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { pinToday } from './support/clock';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { COFFEE } from './support/categories';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: jest.fn(), openPicker: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { resetAuth } from './support/authMock';

const server = installFakeServer();
useTestQueryClient();

const MIN_TAP_HEIGHT = 44;
const LINK_LINE_HEIGHT = 14; // conservative 12pt Inter line

type Slop = { top?: number; bottom?: number; left?: number; right?: number };
const asSlop = (hitSlop: number | Slop | undefined): Required<Slop> => {
  if (typeof hitSlop === 'number') return { top: hitSlop, bottom: hitSlop, left: hitSlop, right: hitSlop };
  return { top: hitSlop?.top ?? 0, bottom: hitSlop?.bottom ?? 0, left: hitSlop?.left ?? 0, right: hitSlop?.right ?? 0 };
};

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(new Date('2026-10-03T10:00:00+10:00'));
});
afterEach(() => {
  jest.useRealTimers();
});

it('the spread link tap area is at least 44pt tall and stays narrow sideways', async () => {
  seedBudgetsTab(server, { coffee: { target: 80, posted: 90.25, pending: 0 } }, [COFFEE], 6, '2026-09-25');
  await renderLoadedBudgetsWithQueries();
  const slop = asSlop(screen.getByTestId('budget-row-spread-coffee').props.hitSlop);
  expect(slop.top + slop.bottom + LINK_LINE_HEIGHT).toBeGreaterThanOrEqual(MIN_TAP_HEIGHT);
  expect(slop.left).toBeLessThanOrEqual(8);
  expect(slop.right).toBeLessThanOrEqual(8);
});
