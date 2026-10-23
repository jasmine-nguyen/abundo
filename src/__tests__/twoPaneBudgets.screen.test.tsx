// ABU-113 — the Budgets tab on a wide screen (the iPhone Duo's inner screen): tapping a budget
// shows its detail beside the list instead of opening a new page; deleting from that pane clears
// the pane without going back; folding to a narrow screen reopens the open budget full screen.
// Real screen + AppProvider over the fake server; only the window-width check is switched.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { renderWithApp, redrawWithApp, resetAppProbe } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { routerSpies, resetRouter } from './support/routerMock';
import { pressAlertButton, spyOnAlert } from './support/alertSpy';
import { seedBudgets } from './support/budgetsTab';
import { queryClient } from '../queryClient';
import { budgetsKey } from '../queryKeys';

let mockWide = true;
jest.mock('../hooks/useWideLayout', () =>
  require('./support/wideLayoutMock').wideLayoutMockModule(() => mockWide));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';

const server = installFakeServer();
useTestQueryClient();

const detailShown = () => screen.queryByTestId('budget-delete') !== null;
const emptyShown = () => screen.queryByText('Select a budget') !== null;

async function drawAndOpen() {
  const view = await renderWithApp(<Budgets />);
  await fireEvent.press(await screen.findByTestId('budget-row-coffee'));
  return view;
}

beforeEach(() => {
  mockWide = true;
  resetRouter();
  resetAuth();
  resetAppProbe();
  seedBudgets(server);
  server.seed('/budgets/coffee/transactions', []);
});

describe('wide screen', () => {
  const alerts = spyOnAlert();

  it('tapping a budget shows its detail beside the list, highlighted, with no back arrow and no new page', async () => {
    await renderWithApp(<Budgets />);
    await screen.findByTestId('budget-row-coffee');
    expect(emptyShown()).toBe(true);
    expect(detailShown()).toBe(false);

    await fireEvent.press(screen.getByTestId('budget-row-coffee'));

    await waitFor(() => expect(detailShown()).toBe(true));
    expect(emptyShown()).toBe(false);
    expect(screen.getByTestId('budget-row-coffee').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(screen.queryByLabelText('Back')).toBeNull();
    expect(routerSpies.push).not.toHaveBeenCalled();
  });

  it('deleting from the pane removes the budget and clears the pane, without going back', async () => {
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    await fireEvent.press(screen.getByTestId('budget-delete'));
    await refreshInAct(() => pressAlertButton(alerts, 'Delete'));

    await waitFor(() => expect(detailShown()).toBe(false));
    expect(server.requests()).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/budgets/coffee' }));
    expect(emptyShown()).toBe(true);
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  it('an open budget that disappears from the server falls back to the empty pane', async () => {
    await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    server.seed('/budgets', {});
    await refreshInAct(() => queryClient.invalidateQueries({ queryKey: budgetsKey }));

    await waitFor(() => expect(emptyShown()).toBe(true));
    expect(detailShown()).toBe(false);
  });

  it('folding to a narrow screen with a budget open reopens it full screen', async () => {
    const view = await drawAndOpen();
    await waitFor(() => expect(detailShown()).toBe(true));

    mockWide = false;
    await redrawWithApp(view, <Budgets />);

    expect(routerSpies.push.mock.calls.map(([href]) => href)).toEqual(['/budget/coffee']);
    expect(detailShown()).toBe(false);
  });
});

it('narrow screen: tapping a budget opens its detail page, as today', async () => {
  mockWide = false;
  await drawAndOpen();

  expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
  expect(detailShown()).toBe(false);
  expect(emptyShown()).toBe(false);
});
