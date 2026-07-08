// WHIT-199 GAP — the shared ScrollChromeHeader wrapper contract the 5 migrated screens depend on
// but no existing test locks directly:
//   1. a screen's `right`/`left` action renders; with neither, both default 40px spacers exist so
//      the title stays centred (Transactions search / Budgets add rely on this — the in-content
//      "Add a budget" test does NOT cover the header button).
//   2. contentContainerStyle FLATTENS over the shared geometry — a screen's extra style (Budgets'
//      {flexGrow:1}) merges IN while the shared paddingTop/Bottom/Horizontal survive.
// Fail-on-revert: drop the `right ?? <slot>` default → slot counts flip; stop merging the screen
// style (or drop contentPadding) → the flatten asserts flip. SENTINEL clearance (999, not 120) so
// "shared inset survives" is a real guard, not a literal.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { View, ScrollView, Text, StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

jest.mock('../motion/useNavBarsHeader', () => ({
  HEADER_BODY_HEIGHT: 58,
  TAB_BAR_CLEARANCE: 999,
  floatingHeaderStyle: {},
  useNavBarsHeader: () => ({
    onScroll: jest.fn(),
    scrollEventThrottle: 16,
    headerStyle: {},
    headerHeight: 58,
    headerPaddingTop: 6,
    contentPadding: { paddingTop: 58, paddingBottom: 999 },
  }),
}));

import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';

type Rendered = ReturnType<typeof render>;

// The header's default spacers are the only 40px-wide Views in the tree.
function slotCount(root: Rendered) {
  return root
    .UNSAFE_getAllByType(View)
    .filter((v) => (StyleSheet.flatten(v.props.style) as { width?: number } | undefined)?.width === 40)
    .length;
}
function contentStyle(root: Rendered) {
  const sv = root.UNSAFE_getAllByType(ScrollView)[0];
  return StyleSheet.flatten(sv.props.contentContainerStyle) as {
    flexGrow?: number; paddingTop?: number; paddingBottom?: number; paddingHorizontal?: number;
  };
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
  expect(cc.paddingBottom).toBe(999);  // shared clearance survives the merge
  expect(cc.paddingTop).toBe(58);      // shared top inset survives
  expect(cc.paddingHorizontal).toBe(18);
});

it('without a screen style, no flexGrow leaks onto the content (loaded scroll path)', () => {
  const r = render(
    <ScrollChromeHeader title="Budgets"><Text>body</Text></ScrollChromeHeader>,
  );
  expect(contentStyle(r).flexGrow).toBeUndefined();
});
