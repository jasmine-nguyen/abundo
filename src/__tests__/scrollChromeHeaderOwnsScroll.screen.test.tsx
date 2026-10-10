// WHIT-761 / WHIT-729 — ScrollChromeHeader owns the scroll → nav-bars wiring, the header slide and
// the status-bar strip. Rendered inside the real NavBarsProvider (reduce-motion on, so the bars jump
// instantly) with a REAL notch inset (top 47), so headerHeight = 47 + 58 = 105 and "inset + 58"
// can't pass as "58".
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { C } from '../theme';
import { styleOf } from './support/layout';
import { contentStyle, headerMotion, scrollTo } from './support/scrollChromeHeader';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => require('./support/safeAreaMock').safeAreaMockModule({ top: 47, bottom: 34 }));

import { NavBarsProvider } from '../motion/NavBarsContext';
import { ScrollChromeHeader, floatingHeaderStyle } from '../motion/ScrollChromeHeader';

function renderHeader() {
  return render(
    <NavBarsProvider reduceMotion>
      <ScrollChromeHeader title="Budgets">
        <Text>body</Text>
      </ScrollChromeHeader>
    </NavBarsProvider>,
  );
}

it('scrolling down slides the header up by its full height, scrolling back up shows it again', () => {
  const r = renderHeader();
  expect(headerMotion(r)).toMatchObject({ translateY: 0, opacity: 1 });

  scrollTo(r, 200);
  expect(headerMotion(r)).toMatchObject({ translateY: -105, opacity: 0 }); // notch included

  scrollTo(r, 400);
  expect(headerMotion(r)).toMatchObject({ translateY: -105, opacity: 0 });

  scrollTo(r, 100);
  expect(headerMotion(r)).toMatchObject({ translateY: 0, opacity: 1 });
});

it('insets the list top by the full header height (notch + body)', () => {
  expect(contentStyle(renderHeader()).paddingTop).toBe(105);
});

// WHIT-729: when scrolling hides the header, the area behind the status bar (clock, Dynamic Island,
// battery) keeps a solid C.bg backing: a strip exactly insets.top tall, NOT inside the sliding
// header, painted above it (it is the first child, so without the zIndex the header body and the
// list would draw over it), and never swallowing taps.
it('renders a fixed status-bar strip (insets.top tall, C.bg) outside the sliding header', () => {
  type Node = { type: unknown; parent: Node | null; props: { style?: unknown; pointerEvents?: string } };
  const strips = (renderHeader().UNSAFE_getAllByType(View) as unknown as Node[]).filter((v) => {
    const s = styleOf(v);
    return s.height === 47 && s.backgroundColor === C.bg;
  });
  const insideAnimatedView = (node: Node) => {
    for (let p = node.parent; p; p = p.parent) if (p.type === Animated.View) return true;
    return false;
  };
  const strip = strips.find((s) => !insideAnimatedView(s));
  expect(strip).toBeTruthy();

  const s = styleOf(strip!);
  const header = StyleSheet.flatten(floatingHeaderStyle) as { zIndex?: number };
  expect(s.position).toBe('absolute');
  expect(s.top).toBe(0);
  expect(s.zIndex).toBeGreaterThan(header.zIndex ?? 0);
  expect(strip!.props.pointerEvents).toBe('none');
});
