// Card 609 — the floating round Ask button: the tab bar renders it (so it is on all five tabs and no
// pushed screen), 16pt above the bar, labelled for screen readers, and tapping it opens the chat.
// WHIT-687 — the tab bar's screen data comes from the real query hooks over the fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';

// By default the bars are scrolled away: each slide sits at its hidden end (outputRange[0]).
// A test sets mockBarsShown to read the shown end (outputRange[1]) instead.
let mockBarsShown = false;
jest.mock('../motion/NavBarsContext', () => ({
  useNavBars: () => ({ visibility: { interpolate: ({ outputRange }: { outputRange: number[] }) => outputRange[mockBarsShown ? 1 : 0] } }),
}));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { TabBar } from '../../app/(tabs)/_layout';
import { ChatProvider, useChat } from '../chat/ChatContext';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  mockBarsShown = false;
});

let chatOpen = false;
function Probe() {
  chatOpen = useChat().open;
  return null;
}

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: ['budgets', 'transactions', 'accounts', 'insights', 'goals'].map((name) => ({ key: name, name })) },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

it('the tab bar renders the round Ask button above itself, and tapping it opens the chat', async () => {
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /><Probe /></ChatProvider>);

  const button = screen.getByLabelText('Ask about your spending');
  expect(screen.queryByText('Ask')).toBeNull();
  // 16pt above the bar's (initial) 90pt height, pinned to the right; a 48pt circle.
  const style = Object.assign({}, ...[button.props.style].flat(3).filter(Boolean));
  expect(style).toMatchObject({ position: 'absolute', right: 18, bottom: 106, width: 48, height: 48, borderRadius: 24 });

  expect(chatOpen).toBe(false);
  fireEvent.press(button);
  expect(chatOpen).toBe(true);
});

it('WHIT-730: the Ask button slides off-screen with the bar, and tab labels cap their text size', async () => {
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /></ChatProvider>);

  // Hidden: 90pt bar + 16pt gap + 64 → fully below the screen edge.
  const slide = Object.assign({}, ...[screen.getByTestId('ask-button-slide').props.style].flat(3).filter(Boolean));
  expect(slide.transform).toEqual([{ translateY: 170 }]);

  const label = screen.getByText('Transactions');
  expect(label.props).toMatchObject({ maxFontSizeMultiplier: 1.2, adjustsFontSizeToFit: true, numberOfLines: 1 });
});

it('[A20] WHIT-730: with the bars shown the Ask button sits in place, and its full-screen wrapper lets taps through', async () => {
  mockBarsShown = true;
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /><Probe /></ChatProvider>);

  const slideView = screen.getByTestId('ask-button-slide');
  const slide = Object.assign({}, ...[slideView.props.style].flat(3).filter(Boolean));
  expect(slide.transform).toEqual([{ translateY: 0 }]);
  // The wrapper covers the screen, so it must pass taps to the list and tabs beneath it.
  expect(slideView.props.pointerEvents).toBe('box-none');

  fireEvent.press(screen.getByLabelText('Ask about your spending'));
  expect(chatOpen).toBe(true);
});
