// WHIT-199 GAP — the shared ScrollChromeHeader wrapper contract the 5 migrated screens depend on
// but no existing test locks directly:
//   1. the header draws the Settings gear on the left itself (WHIT-841); a screen's `right` action
//      renders, and with none a 40px spacer balances the gear so the title stays centred.
//   2. the content fills the viewport by default (flexGrow 1, so a short list is still pullable)
//      and a screen's contentContainerStyle FLATTENS over the shared geometry — its extra style
//      merges IN (and wins) while the shared paddingTop/Horizontal survive.
// Fail-on-revert: stop drawing the gear → getByLabelText('Settings') throws; drop the
// `right ?? <slot>` default → slot counts flip; drop the default flexGrow → the default asserts flip.
// Renders with the global zero safe-area insets and the NavBars default context.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { View, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { contentStyle } from './support/scrollChromeHeader';
import {
  ScrollChromeHeader,
  HEADER_BODY_HEIGHT,
  TAB_BAR_CLEARANCE,
  ASK_BUTTON_BOTTOM_CLEARANCE,
} from '../motion/ScrollChromeHeader';
import { styleOf } from './support/layout';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

type Rendered = ReturnType<typeof render>;

// The header's default spacers are the only unlabelled 40px-wide Views in the tree (the gear
// button is also 40px wide, but carries its 'Settings' label).
function slotCount(root: Rendered) {
  return root
    .UNSAFE_getAllByType(View)
    .filter((v) => styleOf(v).width === 40 && !v.props.accessibilityLabel)
    .length;
}

it('renders a screen-supplied `right` action with the gear on the left, no spacers', () => {
  const r = render(
    <ScrollChromeHeader title="Transactions" right={<Text>ACTION</Text>}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  expect(r.getByText('ACTION')).toBeTruthy();
  expect(r.getByText('Transactions')).toBeTruthy();
  expect(r.getByLabelText('Settings')).toBeTruthy();
  expect(slotCount(r)).toBe(0); // gear on the left, action on the right → no spacers
});

it('with no right action, the gear on the left and one 40px spacer on the right keep the title centred', () => {
  const r = render(
    <ScrollChromeHeader title="Insights"><Text>body</Text></ScrollChromeHeader>,
  );
  expect(r.getByText('Insights')).toBeTruthy();
  expect(r.getByLabelText('Settings')).toBeTruthy();
  expect(slotCount(r)).toBe(1);
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

it('content style has flexGrow: 1 by default so a short list is still pullable', () => {
  const r = render(
    <ScrollChromeHeader title="Budgets"><Text>body</Text></ScrollChromeHeader>,
  );
  const cc = contentStyle(r);
  expect(cc.flexGrow).toBe(1);
  expect(cc.paddingBottom).toBe(TAB_BAR_CLEARANCE + ASK_BUTTON_BOTTOM_CLEARANCE);
});
