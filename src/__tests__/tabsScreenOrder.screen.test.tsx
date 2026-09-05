// Tab ORDER guard: the bottom bar renders `state.routes` in navigator order, so the order of
// the <Tabs.Screen> declarations IS the visual tab order. This captures those declarations and
// locks the sequence — Accounts sits 3rd, right after Transactions (where it moved out of the
// Transactions segmented control). A reorder that drops or moves the Accounts tab fails here.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => false }));

let capturedNames: (string | undefined)[] = [];
jest.mock('expo-router', () => {
  const React2 = require('react');
  const Tabs = ({ children }: { children: React.ReactNode }) => {
    capturedNames = React2.Children.toArray(children).map((c: unknown) => (c as { props: { name?: string } }).props?.name);
    return React2.createElement(React2.Fragment, null, children);
  };
  Tabs.Screen = () => null;
  // TabsLayout mounts <NavBarsRouteReset/>, which reads usePathname.
  return { Tabs, usePathname: () => '/budgets' };
});

import TabsLayout from '../../app/(tabs)/_layout';

beforeEach(() => { capturedNames = []; });

it('declares the tabs in order with Accounts 3rd, right after Transactions', () => {
  render(<TabsLayout />);
  expect(capturedNames).toEqual(['budgets', 'transactions', 'accounts', 'insights', 'goals']);
});
