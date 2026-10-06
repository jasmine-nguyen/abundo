// WHIT-761 — ScrollChromeHeader owns the whole scroll-hide header on its own: the spacing
// constants, the scroll → nav-bars wiring, the header slide, and the content padding.
// Rendered inside the real NavBarsProvider (reduce-motion on, so the bars jump instantly)
// with the global zero safe-area insets → headerHeight = 0 + 58.
import { it, expect } from '@jest/globals';
import React from 'react';
import { Animated, ScrollView, StyleSheet, Text } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { NavBarsProvider } from '../motion/NavBarsContext';
import {
  ScrollChromeHeader,
  HEADER_BODY_HEIGHT,
  TAB_BAR_CLEARANCE,
  ASK_BUTTON_BOTTOM_CLEARANCE,
  floatingHeaderStyle,
} from '../motion/ScrollChromeHeader';

type Rendered = ReturnType<typeof render>;

function renderHeader() {
  return render(
    <NavBarsProvider reduceMotion>
      <ScrollChromeHeader title="Budgets">
        <Text>body</Text>
      </ScrollChromeHeader>
    </NavBarsProvider>,
  );
}

function scrollView(r: Rendered) {
  return r.UNSAFE_getAllByType(ScrollView)[0];
}

function scrollTo(r: Rendered, y: number) {
  const event = { nativeEvent: { contentOffset: { y } } } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
  act(() => scrollView(r).props.onScroll(event));
}

function headerMotion(r: Rendered) {
  const style = StyleSheet.flatten(r.UNSAFE_getAllByType(Animated.View)[0].props.style) as {
    opacity: { __getValue(): number };
    transform: { translateY: { __getValue(): number } }[];
  };
  return { translateY: style.transform[0].translateY.__getValue(), opacity: style.opacity.__getValue() };
}

it('exports the spacing constants and the floating header style from ScrollChromeHeader', () => {
  expect(HEADER_BODY_HEIGHT).toBe(58);
  expect(TAB_BAR_CLEARANCE).toBe(120);
  expect(ASK_BUTTON_BOTTOM_CLEARANCE).toBe(72);
  expect(floatingHeaderStyle).toEqual(expect.objectContaining({ position: 'absolute', zIndex: 10 }));
});

it('scrolling down slides the header up by its full height, scrolling back up shows it again', () => {
  const r = renderHeader();
  expect(scrollView(r).props.scrollEventThrottle).toBe(16);
  expect(headerMotion(r)).toEqual({ translateY: 0, opacity: 1 });

  scrollTo(r, 200);
  expect(headerMotion(r)).toEqual({ translateY: -58, opacity: 0 });

  scrollTo(r, 400);
  expect(headerMotion(r)).toEqual({ translateY: -58, opacity: 0 });

  scrollTo(r, 100);
  expect(headerMotion(r)).toEqual({ translateY: 0, opacity: 1 });
});

it('pads the content below the header and clear of the tab bar and Ask button', () => {
  const r = renderHeader();
  const content = StyleSheet.flatten(scrollView(r).props.contentContainerStyle) as {
    paddingTop?: number; paddingBottom?: number;
  };
  expect(content.paddingTop).toBe(58);
  expect(content.paddingBottom).toBe(192);
});
