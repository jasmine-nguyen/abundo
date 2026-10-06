// WHIT-736 QA — the renamed bottom clearance still pads the BOTTOM of every tab list, and the
// right-lane value isn't swapped in. Literal 192 (120 tab bar + 72 Ask button) pins "no change on screen".
import { it, expect } from '@jest/globals';
import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';

// [A1]
it('tab lists keep 192pt of bottom padding (tab bar + Ask button) after the rename', () => {
  const r = render(<ScrollChromeHeader title="Budgets"><Text>body</Text></ScrollChromeHeader>);
  const content = StyleSheet.flatten(r.UNSAFE_getAllByType(ScrollView)[0].props.contentContainerStyle) as {
    paddingBottom?: number;
  };
  expect(content.paddingBottom).toBe(192);
});
