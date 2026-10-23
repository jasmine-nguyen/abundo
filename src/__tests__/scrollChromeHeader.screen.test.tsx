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
import { pullControl } from './support/pull';
import { render, fireEvent, within } from '@testing-library/react-native';
import { contentStyle } from './support/scrollChromeHeader';
import { styleOf } from './support/layout';
import {
  ScrollChromeHeader,
  HEADER_BODY_HEIGHT,
} from '../motion/ScrollChromeHeader';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

it('renders a screen-supplied `right` action with the gear on the left, no spacers', async () => {
  const r = await render(
    <ScrollChromeHeader title="Transactions" right={<Text>ACTION</Text>}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  expect(r.getByText('ACTION')).toBeTruthy();
  expect(r.getByText('Transactions')).toBeTruthy();
  expect(r.getByLabelText('Settings')).toBeTruthy();
});

it('flattens a screen contentContainerStyle over the shared insets (Transactions select-mode padding wins)', async () => {
  const r = await render(
    <ScrollChromeHeader title="Transactions" contentContainerStyle={{ paddingBottom: 321 }}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const cc = contentStyle(r);
  expect(cc.paddingBottom).toBe(321);   // the screen's style wins over the shared clearance
  expect(cc.flexGrow).toBe(1);          // the default fill survives the merge
  expect(cc.paddingTop).toBe(HEADER_BODY_HEIGHT); // shared top inset survives (zero safe-area inset)
  expect({ left: cc.paddingLeft, right: cc.paddingRight }).toEqual({ left: 18, right: 18 });
});

// WHIT-863: a line under the title (the freshness line) draws inside the header, and the list's top
// gap and pull spinner follow the header's measured height. No line, or a line that renders
// nothing → the fixed inset + HEADER_BODY_HEIGHT.
const Nothing = () => null;

it.each([
  ['a subtitle', <Text key="line">Updated 9:40am</Text>, 90, 90],
  ['no subtitle', undefined, 90, HEADER_BODY_HEIGHT],
  ['a subtitle that renders nothing', <Nothing key="nothing" />, HEADER_BODY_HEIGHT, HEADER_BODY_HEIGHT],
])('with %s, the list top gap and pull spinner follow the measured header height (WHIT-863)', async (_label, subtitle, measured, expected) => {
  const r = await render(
    <ScrollChromeHeader title="Transactions" subtitle={subtitle} onRefresh={() => {}}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const header = r.getByTestId('screen-header');
  if (subtitle?.key === 'line') {
    expect(within(header).getByText('Updated 9:40am')).toBeTruthy();
  }
  await fireEvent(header, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: measured } } });
  expect(contentStyle(r).paddingTop).toBe(expected);
  expect(pullControl().props.progressViewOffset).toBe(expected);
});

// ABU-118: turned sideways (the unfolded Duo), the gear and the + sit clear of the rounded corners
// and the status bar — the header pads by the left/right/top safe-area insets on top of its 20.
// ABU-119: the page content under it pads its sides the same way, on top of its 18.
// Different left and right insets so a swap is caught.
it('pads the header and the page content by the side safe-area insets (ABU-118, ABU-119)', async () => {
  const safeArea = require('react-native-safe-area-context');
  jest.spyOn(safeArea, 'useSafeAreaInsets').mockReturnValue({ top: 24, left: 44, right: 59, bottom: 0 });
  const r = await render(
    <ScrollChromeHeader title="Budgets" right={<Text>ADD</Text>}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const header = styleOf(r.getByTestId('screen-header'));
  expect({ left: header.paddingLeft, right: header.paddingRight, top: header.paddingTop })
    .toEqual({ left: 64, right: 79, top: 30 });
  const cc = contentStyle(r);
  expect({ left: cc.paddingLeft, right: cc.paddingRight }).toEqual({ left: 62, right: 77 });
  jest.restoreAllMocks();
});
