// WHIT-730 follow-up QA [A5] — the list gap is built from the button the tab bar really draws, so
// if the button moves or grows without the constants, this breaks.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';

jest.mock('../motion/NavBarsContext', () => ({
  useNavBars: () => ({ visibility: { interpolate: ({ outputRange }: { outputRange: number[] }) => outputRange[1] } }),
}));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { TabBar } from '../../app/(tabs)/_layout';
import { ChatProvider } from '../chat/ChatContext';
import { ASK_BUTTON_RIGHT_CLEARANCE } from '../chat/AskButton';
import { SCREEN_PADDING } from '../motion/ScrollChromeHeader';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: ['budgets', 'transactions', 'accounts', 'insights', 'goals'].map((name) => ({ key: name, name })) },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

// [A5] (P0) a row's right edge (screen padding + gap, from the screen's right edge) is past the
// drawn button's left edge (its right offset + its width), with the 12pt card gap to spare.
it('[A5] list rows stop 12pt short of the drawn Ask button', async () => {
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /></ChatProvider>);
  const button = StyleSheet.flatten(screen.getByLabelText('Ask about your spending').props.style);
  expect(SCREEN_PADDING + ASK_BUTTON_RIGHT_CLEARANCE).toBe(button.right + button.width + 12);
});
