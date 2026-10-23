// ABU-113 — the real root layout over the real expo-router Stack on the Duo's wide inner screen:
// a page pushed onto the root stack sits in the readable column, while the tabs stay full width.
// Only the launch side effects and app-wide providers are stand-ins; the Stack and its
// screenLayout run for real.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { Slot } from 'expo-router';
import { renderRouter, screen } from 'expo-router/testing-library';
import type { TestInstance } from 'test-renderer';
import { styleOf } from './support/layout';
import { READABLE_MAX_WIDTH } from '../hooks/useWideLayout';

jest.mock('../hooks/useWideLayout', () => require('./support/wideLayoutMock').wideLayoutMockModule(() => true));
jest.mock('expo',() => require('./support/expoNativeMock').expoNativeMockModule());
jest.mock('expo-modules-core', () => require('./support/expoNativeMock').expoNativeMockModule(), { virtual: true });
jest.mock('../push', () => require('./support/rootLayoutMock').pushMock());
jest.mock('@expo-google-fonts/inter', () => require('./support/rootLayoutMock').interFontsMock(() => true));
jest.mock('@expo-google-fonts/inter-tight', () => require('./support/rootLayoutMock').interTightFontsMock());
jest.mock('expo-splash-screen', () => require('./support/rootLayoutMock').splashScreenMock());
jest.mock('expo-status-bar', () => require('./support/rootLayoutMock').statusBarMock());
jest.mock('../context', () => require('./support/rootLayoutMock').appProviderMock());
jest.mock('../AuthGate', () => ({ AuthGate: ({ children }: { children?: React.ReactNode }) => children }));
jest.mock('../chat/ChatContext', () => ({ ChatProvider: ({ children }: { children?: React.ReactNode }) => children }));
jest.mock('../chat/ChatSheet', () => ({ ChatSheet: () => null }));
jest.mock('../components/Overlays', () => require('./support/rootLayoutMock').overlaysMock());
jest.mock('../components/NotificationRouter', () => require('./support/rootLayoutMock').notificationRouterMock());

import RootLayout from '../../app/_layout';

const cappedAbove = (node: TestInstance) => {
  for (let host = node.parent; host; host = host.parent) {
    if (styleOf(host).maxWidth === READABLE_MAX_WIDTH) return true;
  }
  return false;
};

const renderApp = (initialUrl: string) =>
  renderRouter(
    {
      _layout: RootLayout,
      '(tabs)/_layout': () => <Slot />,
      '(tabs)/budgets':() => <Text testID="page">Budgets</Text>,
      'budget/edit': () => <Text testID="page">Edit budget</Text>,
    },
    { initialUrl },
  );

describe('root stack on a wide screen', () => {
  // [A1] a full-screen page gets the readable column through the real Stack's screenLayout
  it('/budget/edit sits in the readable column', async () => {
    await renderApp('/budget/edit');
    expect(cappedAbove(screen.getByTestId('page'))).toBe(true);
  });

  // [A2] the tabs lay out their own wide screens, so they are not capped
  it('the tabs stay full width', async () => {
    await renderApp('/budgets');
    expect(cappedAbove(screen.getByTestId('page'))).toBe(false);
  });
});
