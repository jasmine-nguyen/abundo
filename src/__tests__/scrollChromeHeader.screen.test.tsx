// WHIT-199 GAP — the shared ScrollChromeHeader wrapper contract the 5 migrated screens depend on
// but no existing test locks directly:
//   1. a screen's `right`/`left` action renders; with neither, both default 40px spacers exist so
//      the title stays centred (Transactions search / Budgets add rely on this — the Budgets
//      screen tests cover pressing its header button, not this slot contract).
//   2. contentContainerStyle FLATTENS over the shared geometry — a screen's extra style (Budgets'
//      {flexGrow:1}) merges IN while the shared paddingTop/Bottom/Horizontal survive.
// Fail-on-revert: drop the `right ?? <slot>` default → slot counts flip; stop merging the screen
// style (or drop the shared padding) → the flatten asserts flip. The screen style sets no
// paddingBottom of its own, so the shared clearance surviving is a real guard.
// Renders with the global zero safe-area insets and the NavBars default context.
import { it, expect } from '@jest/globals';
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

type Rendered = ReturnType<typeof render>;

// The header's default spacers are the only 40px-wide Views in the tree.
function slotCount(root: Rendered) {
  return root
    .UNSAFE_getAllByType(View)
    .filter((v) => (styleOf(v) as { width?: number } | undefined)?.width === 40)
    .length;
}

it('renders a screen-supplied `right` action, leaving only the left default spacer', () => {
  const r = render(
    <ScrollChromeHeader title="Transactions" right={<Text>ACTION</Text>}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  expect(r.getByText('ACTION')).toBeTruthy();
  expect(r.getByText('Transactions')).toBeTruthy();
  expect(slotCount(r)).toBe(1); // right filled → only the left spacer remains
});

it('with no left/right, both 40px spacers render so the title stays centred', () => {
  const r = render(
    <ScrollChromeHeader title="Insights"><Text>body</Text></ScrollChromeHeader>,
  );
  expect(r.getByText('Insights')).toBeTruthy();
  expect(slotCount(r)).toBe(2);
});

it('flattens a screen contentContainerStyle over the shared insets (Budgets flexGrow centering)', () => {
  const r = render(
    <ScrollChromeHeader title="Budgets" contentContainerStyle={{ flexGrow: 1 }}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const cc = contentStyle(r);
  expect(cc.flexGrow).toBe(1);         // the screen's centering style merged in
  expect(cc.paddingBottom).toBe(TAB_BAR_CLEARANCE + ASK_BUTTON_BOTTOM_CLEARANCE); // shared clearance survives the merge
  expect(cc.paddingTop).toBe(HEADER_BODY_HEIGHT); // shared top inset survives (zero safe-area inset)
  expect(cc.paddingHorizontal).toBe(18);
});

it('without a screen style, no flexGrow leaks onto the content (loaded scroll path)', () => {
  const r = render(
    <ScrollChromeHeader title="Budgets"><Text>body</Text></ScrollChromeHeader>,
  );
  expect(contentStyle(r).flexGrow).toBeUndefined();
});
