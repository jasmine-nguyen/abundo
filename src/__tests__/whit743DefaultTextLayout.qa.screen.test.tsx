// WHIT-743 QA — with no per-file mock, screen tests must still draw the normal (side-by-side)
// Budgets layout. The test renderer reports fontScale 2, so this fails if jest.setup.js stops
// defaulting useLargeText to false and the older Budgets suites silently switch layout.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, within } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { showTwoRows } from './support/budgetsScreen';
import { styleOf, sharedHost } from './support/layout';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

// [A1]
it('by default the Budgets row and top card stay side by side', async () => {
  await showTwoRows(server);
  const row = within(screen.getByTestId('budget-row-coffee'));
  expect(styleOf(sharedHost(row.getByText('Cafes & Coffee'), row.getByText('$20'))).flexDirection).toBe('row');
  expect(styleOf(sharedHost(screen.getByText('7'), screen.getByText('$95'))).flexDirection).toBe('row');
});
