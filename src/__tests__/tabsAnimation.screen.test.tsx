// WHIT-184 GAP — the tab-switch transition must be a cross-fade normally and OFF under
// reduce-motion. The value is trapped in the (tabs)/_layout screenOptions, so we mock
// expo-router's Tabs to capture screenOptions and flip the mocked useReduceMotion. This is
// the ONLY automated guard that the reduce-motion flag actually reaches the native tab
// animation prop (the applyVisibility test covers the scroll tween; this covers the tab cut).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';

let mockReduceMotion = false;
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => mockReduceMotion }));

let captured: { animation?: string; headerShown?: boolean } | undefined;
jest.mock('expo-router', () => {
  const React2 = require('react');
  const Tabs = ({ screenOptions, children }: { screenOptions: unknown; children: React.ReactNode }) => {
    captured = screenOptions as { animation?: string };
    return React2.createElement(React2.Fragment, null, children);
  };
  Tabs.Screen = () => null;
  // TabsLayout now mounts <NavBarsRouteReset/>, which reads usePathname.
  return { Tabs, usePathname: () => '/budgets' };
});

import TabsLayout from '../../app/(tabs)/_layout';

beforeEach(() => { captured = undefined; });

it('uses a fade tab-switch animation when reduce-motion is OFF', () => {
  mockReduceMotion = false;
  render(<TabsLayout />);
  expect(captured?.animation).toBe('fade');
});

it('disables the tab-switch animation when reduce-motion is ON', () => {
  mockReduceMotion = true;
  render(<TabsLayout />);
  expect(captured?.animation).toBe('none');
});
