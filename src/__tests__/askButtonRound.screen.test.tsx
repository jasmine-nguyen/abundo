// WHIT-704 — the floating Ask button is a 48×48 circle with the icon only: no "Ask" label, same
// spot on the tab bar (so on all five tabs), same screen-reader label, and tapping it opens the chat.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';

jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { TabBar } from '../../app/(tabs)/_layout';
import { ChatProvider, useChat } from '../chat/ChatContext';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

let chatOpen = false;
function Probe() {
  chatOpen = useChat().open;
  return null;
}

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: ['budgets', 'transactions', 'accounts', 'insights', 'goals'].map((name) => ({ key: name, name })) },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

it('the tab bar shows a round 48pt icon-only Ask button in the same spot, and tapping it opens the chat', async () => {
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /><Probe /></ChatProvider>);

  const button = screen.getByLabelText('Ask about your spending');
  expect(screen.queryByText('Ask')).toBeNull();

  const style = Object.assign({}, ...[button.props.style].flat(3).filter(Boolean));
  // 16pt above the bar's (initial) 90pt height, pinned to the right; a 48pt circle.
  expect(style).toMatchObject({
    position: 'absolute', right: 18, bottom: 106,
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
  });

  expect(chatOpen).toBe(false);
  fireEvent.press(button);
  expect(chatOpen).toBe(true);
});
