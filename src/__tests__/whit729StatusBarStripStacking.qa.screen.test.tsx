// WHIT-729 QA — the status-bar strip must paint OVER both the sliding header and the scrolling
// content, and must never swallow taps. It is the first child, so without a zIndex above the
// header's it would draw underneath the header body and the ScrollView → content shows under the clock.
import { it, expect, jest } from '@jest/globals';
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { C } from '../theme';
import { styleOf } from './support/layout';

jest.mock('react-native-safe-area-context', () => require('./support/safeAreaMock').safeAreaMockModule({ top: 47, bottom: 34 }));

import { ScrollChromeHeader, floatingHeaderStyle } from '../motion/ScrollChromeHeader';

type Flat = { height?: number; backgroundColor?: string; zIndex?: number; position?: string; top?: number };

function strip() {
  const r = render(<ScrollChromeHeader title="Budgets">{null}</ScrollChromeHeader>);
  const found = r.UNSAFE_getAllByType(View).find((v) => {
    const s = styleOf(v);
    return s.height === 47 && s.backgroundColor === C.bg;
  });
  if (!found) throw new Error('status-bar strip not rendered');
  return found;
}

// [A1]
it('strip is pinned to the top and stacks above the sliding header', () => {
  const s = styleOf(strip());
  const header = StyleSheet.flatten(floatingHeaderStyle) as Flat;
  expect(s.position).toBe('absolute');
  expect(s.top).toBe(0);
  expect(s.zIndex).toBeGreaterThan(header.zIndex ?? 0);
});

// [A2]
it('strip never takes touches (header buttons and content under it stay tappable)', () => {
  expect(strip().props.pointerEvents).toBe('none');
});
