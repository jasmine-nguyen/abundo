// WHIT-717 QA — the tab bar items and the round Ask button take the one shared PRESSED look when
// tapped, and nothing at rest. pressStates covers TransactionRow and the WHIT-712 test covers the
// budget row; these two (formerly 0.55/0.92 and 0.85/0.96) had no press test.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';

jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { TabBar } from '../../app/(tabs)/_layout';
import { ChatProvider } from '../chat/ChatContext';
import { PRESSED } from '../theme';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: ['budgets', 'transactions'].map((name) => ({ key: name, name })) },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

type Node = { props: { style?: unknown }; parent: Node | null };
type Look = { opacity?: number; transform?: unknown };

function styleFnAbove(node: Node): (x: { pressed: boolean }) => unknown {
  let current: Node | null = node;
  while (current && typeof current.props.style !== 'function') current = current.parent;
  return current!.props.style as (x: { pressed: boolean }) => unknown;
}
function look(node: Node, pressed: boolean): Look {
  return StyleSheet.flatten(styleFnAbove(node)({ pressed }) as never) as Look;
}

it('[A1] a tab bar item dims and shrinks with the shared PRESSED look, solid at rest', async () => {
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /></ChatProvider>);
  const tab = screen.getByText('Transactions') as unknown as Node;
  expect(look(tab, false).opacity).toBeUndefined();
  expect(look(tab, false).transform).toBeUndefined();
  expect(look(tab, true)).toMatchObject({ opacity: PRESSED.opacity, transform: PRESSED.transform });
});

it('[A2] the round Ask button takes the shared PRESSED look on press', async () => {
  await renderWithQueries(<ChatProvider><TabBar {...barProps} /></ChatProvider>);
  const button = screen.getByLabelText('Ask about your spending') as unknown as Node;
  expect(look(button, false).opacity).toBeUndefined();
  expect(look(button, true)).toMatchObject({ opacity: PRESSED.opacity, transform: PRESSED.transform });
});
