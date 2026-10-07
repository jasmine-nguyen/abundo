// WHIT-729 — when scrolling hides the header, the area behind the status bar (clock, Dynamic
// Island, battery) must keep a solid C.bg backing. The shared ScrollChromeHeader renders a fixed
// strip exactly insets.top tall that is NOT inside the animated (sliding) header, so it never
// hides. Uses the real ScrollChromeHeader geometry with a sentinel inset of 47.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { View, Text, Animated } from 'react-native';
import { render } from '@testing-library/react-native';
import { C } from '../theme';
import { styleOf } from './support/layout';

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }) }));

import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';

type Node = { type: unknown; parent: Node | null; props: { style?: unknown } };

function insideAnimatedView(node: Node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === Animated.View) return true;
  return false;
}

it('renders a fixed status-bar strip (insets.top tall, C.bg) outside the sliding header', () => {
  const r = render(
    <ScrollChromeHeader title="Budgets"><Text>body</Text></ScrollChromeHeader>,
  );
  const strips = (r.UNSAFE_getAllByType(View) as unknown as Node[]).filter((v) => {
    const s = styleOf(v) as { height?: number; backgroundColor?: string } | undefined;
    return s?.height === 47 && s?.backgroundColor === C.bg;
  });
  expect(strips.length).toBeGreaterThan(0);
  expect(strips.some((s) => !insideAnimatedView(s))).toBe(true);
});
