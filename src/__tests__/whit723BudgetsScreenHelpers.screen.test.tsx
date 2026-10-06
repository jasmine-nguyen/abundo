// WHIT-723: the shared Budgets "seed + render + wait" steps. showBudgets seeds the fake server
// (coffee + groceries, 4 days left unless told otherwise) and hands back a loaded screen;
// renderLoadedBudgets draws the tab and waits until the coffee row is on screen.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { makeClient } from './support/queryClient';
import { COFFEE } from './support/categories';
import { seedBudgets, showBudgets, renderLoadedBudgets } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => resetRouter());

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
