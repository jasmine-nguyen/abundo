// Card 609 — the floating "Ask" pill: the tab bar renders it (so it is on all five tabs and no
// pushed screen), 16pt above the bar, labelled for screen readers, and tapping it opens the chat.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('../queries', () => ({
  useRecentTransactionsScreenData: () => ({ transactions: [], category: () => undefined }),
  useKeepTransactionsFeedWarm: () => {},
  useUncategorizedCount: () => undefined,
}));
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
jest.mock('../api', () => ({ startAiChat: jest.fn(), getAiChatJob: jest.fn() }));

import { TabBar } from '../../app/(tabs)/_layout';
import { ChatProvider, useChat } from '../chat/ChatContext';

let chatOpen = false;
function Probe() {
  chatOpen = useChat().open;
  return null;
}

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: ['budgets', 'transactions', 'accounts', 'insights', 'goals'].map((name) => ({ key: name, name })) },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

it('the tab bar renders the Ask pill above itself, and tapping it opens the chat', () => {
  render(<ChatProvider><TabBar {...barProps} /><Probe /></ChatProvider>);

  const pill = screen.getByLabelText('Ask about your spending');
  expect(screen.getByText('Ask')).toBeTruthy();
  // 16pt above the bar's (initial) 90pt height, pinned to the right.
  const style = Object.assign({}, ...[pill.props.style].flat(3).filter(Boolean));
  expect(style).toMatchObject({ position: 'absolute', right: 18, bottom: 106 });

  expect(chatOpen).toBe(false);
  fireEvent.press(pill);
  expect(chatOpen).toBe(true);
});

// WHIT-615 — the pill's gradient must use the shared viewBox fill (a `%`-sized inline Svg stuck at
// a ~50pt circle on iOS), clipped inside the 1px ring, while the pill itself stays unclipped so
// its shadow still shows.
it('the Ask pill fills with the shared gradient and keeps its shadow', () => {
  render(<ChatProvider><TabBar {...barProps} /></ChatProvider>);

  const pill = screen.getByLabelText('Ask about your spending');
  const svg = pill.findAll((node) => node.props.viewBox === '0 0 1 1')[0];
  expect(svg).toBeTruthy();
  const clip = StyleSheet.flatten(svg.parent?.props.style);
  expect(clip).toMatchObject({ overflow: 'hidden', borderRadius: 24 });

  const pillStyle = Object.assign({}, ...[pill.props.style].flat(3).filter(Boolean));
  expect(pillStyle.shadowOpacity).toBe(0.6);
  expect(pillStyle.overflow).toBeUndefined();
});
