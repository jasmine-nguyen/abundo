// Blank-tab regression guard: the tab navigator MUST keep inactive screens attached
// (detachInactiveScreens={false}). With the cross-fade tab animation on, the default
// detach-inactive behaviour races the fade and can leave the newly-focused scene attached
// but stuck at opacity 0 — the whole Transactions page shows blank while the tab bar stays
// fine, clearing only after a few more tab switches (react-navigation issue #12755). This
// asserts the prop reaches <Tabs>, so a revert that drops it (and re-opens the blank) fails
// here. Sits alongside tabsAnimation.screen.test.tsx, which guards the animation prop; that
// value is deliberately left ON — the fix keeps the fade, it just stops the detach race.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';

let mockReduceMotion = false;
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => mockReduceMotion }));

let captured: { detachInactiveScreens?: boolean; animation?: string } | undefined;
jest.mock('expo-router', () => {
  const React2 = require('react');
  const Tabs = ({ screenOptions, detachInactiveScreens, children }: {
    screenOptions: { animation?: string };
    detachInactiveScreens?: boolean;
    children: React.ReactNode;
  }) => {
    captured = { detachInactiveScreens, animation: screenOptions?.animation };
    return React2.createElement(React2.Fragment, null, children);
  };
  Tabs.Screen = () => null;
  // TabsLayout mounts <NavBarsRouteReset/>, which reads usePathname.
  return { Tabs, usePathname: () => '/budgets' };
});

import TabsLayout from '../../app/(tabs)/_layout';

beforeEach(() => { captured = undefined; });

it('keeps inactive tab screens attached so the fade never leaves a blank scene', () => {
  mockReduceMotion = false;
  render(<TabsLayout />);
  expect(captured?.detachInactiveScreens).toBe(false);
});

it('keeps inactive screens attached even under reduce-motion (no animation)', () => {
  mockReduceMotion = true;
  render(<TabsLayout />);
  expect(captured?.detachInactiveScreens).toBe(false);
});
