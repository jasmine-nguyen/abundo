// WHIT-199 GAP — the shared ScrollChromeHeader wrapper contract the 5 migrated screens depend on
// but no existing test locks directly:
//   1. the header draws the Settings gear on the left itself (WHIT-841) and a screen's `right` action.
//   2. a screen's contentContainerStyle FLATTENS over the shared geometry — its extra style
//      merges IN (and wins) while the shared paddingTop/Horizontal survive.
// Fail-on-revert: stop drawing the gear → getByLabelText('Settings') throws.
// Renders with the global zero safe-area insets and the NavBars default context.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { contentStyle } from './support/scrollChromeHeader';
import {
  ScrollChromeHeader,
  HEADER_BODY_HEIGHT,
} from '../motion/ScrollChromeHeader';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

it('renders a screen-supplied `right` action with the gear on the left, no spacers', () => {
  const r = render(
    <ScrollChromeHeader title="Transactions" right={<Text>ACTION</Text>}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  expect(r.getByText('ACTION')).toBeTruthy();
  expect(r.getByText('Transactions')).toBeTruthy();
  expect(r.getByLabelText('Settings')).toBeTruthy();
});

it('flattens a screen contentContainerStyle over the shared insets (Transactions select-mode padding wins)', () => {
  const r = render(
    <ScrollChromeHeader title="Transactions" contentContainerStyle={{ paddingBottom: 321 }}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const cc = contentStyle(r);
  expect(cc.paddingBottom).toBe(321);   // the screen's style wins over the shared clearance
  expect(cc.flexGrow).toBe(1);          // the default fill survives the merge
  expect(cc.paddingTop).toBe(HEADER_BODY_HEIGHT); // shared top inset survives (zero safe-area inset)
  expect(cc.paddingHorizontal).toBe(18);
});
