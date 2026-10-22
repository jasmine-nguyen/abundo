// ABU-115: tapping a tab must switch tabs through the real expo-router Tabs layout. The tab bar
// gets whatever props expo-router really passes (no fake navigation), so a prop-shape change
// in expo-router breaks this test instead of crashing the app.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { renderRouter, fireEvent, screen } from 'expo-router/testing-library';
import { installFakeServer } from './support/fakeServer';
import { WithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo', () => require('./support/expoNativeMock').expoNativeMockModule());
jest.mock('expo-modules-core', () => require('./support/expoNativeMock').expoNativeMockModule(), { virtual: true });

import TabsLayout from '../../app/(tabs)/_layout';

installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

const renderTabs = () =>
  renderRouter(
    {
      '(tabs)/_layout': TabsLayout,
      '(tabs)/budgets': () => <Text>Budgets screen</Text>,
      '(tabs)/transactions': () => <Text>Transactions screen</Text>,
      '(tabs)/accounts': () => <Text>Accounts screen</Text>,
      '(tabs)/insights': () => <Text>Insights screen</Text>,
      '(tabs)/goals': () => <Text>Goals screen</Text>,
    },
    { initialUrl: '/budgets', wrapper: WithQueries },
  );

describe('tapping a tab in the real Tabs layout', () => {
  it('switches to the tapped tab', async () => {
    const { getPathname } = await renderTabs();
    expect(getPathname()).toBe('/budgets');

    await fireEvent.press(screen.getByText('Transactions'));

    expect(getPathname()).toBe('/transactions');
    expect(screen.getByText('Transactions screen')).toBeTruthy();
  });

  it('tapping the current tab keeps the same page', async () => {
    const { getPathname } = await renderTabs();

    await fireEvent.press(screen.getByText('Budgets'));

    expect(getPathname()).toBe('/budgets');
  });
});
