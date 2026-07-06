// WHIT-184 (code-critic fix) — the shared chrome visibility is one value driving the
// header AND the floating tab bar, but only the two wired screens reset it on focus. So
// the TabBar itself resets chrome to shown on every tab change; without that, hiding the
// bar on Transactions then switching to an unwired tab (insights/goals/settings) strands
// the bar off-screen. Fail-on-revert: drop the useEffect(setChrome('shown'), [state.index])
// in _layout.tsx and both assertions below flip.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => false }));

const mockSetChrome = jest.fn();
jest.mock('../motion/ChromeContext', () => {
  const { Animated } = require('react-native');
  const React2 = require('react');
  return {
    useChrome: () => ({ visibility: new Animated.Value(1), setChrome: mockSetChrome }),
    ChromeProvider: ({ children }: { children: React.ReactNode }) => React2.createElement(React2.Fragment, null, children),
  };
});

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ transactions: [], category: () => undefined }) };
});

// Capture the tabBar render prop so we can drive it with a controllable navigator state.
let tabBarRender: ((props: unknown) => React.ReactElement) | undefined;
jest.mock('expo-router', () => {
  const Tabs = ({ tabBar }: { tabBar: (p: unknown) => React.ReactElement }) => { tabBarRender = tabBar; return null; };
  Tabs.Screen = () => null;
  return { Tabs };
});

import TabsLayout from '../../app/(tabs)/_layout';

const navigation = { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() };
const stateWith = (index: number) => ({ index, routes: [{ key: 'b', name: 'budgets' }, { key: 't', name: 'transactions' }] });

beforeEach(() => { mockSetChrome.mockClear(); tabBarRender = undefined; });

it('the tab bar resets chrome to shown on mount and on every tab change', () => {
  render(<TabsLayout />);
  expect(tabBarRender).toBeDefined();

  const view = render(tabBarRender!({ state: stateWith(0), navigation }));
  expect(mockSetChrome).toHaveBeenCalledWith('shown'); // mount

  mockSetChrome.mockClear();
  view.rerender(tabBarRender!({ state: stateWith(1), navigation }));
  expect(mockSetChrome).toHaveBeenCalledWith('shown'); // tab change (state.index 0 → 1)
});
