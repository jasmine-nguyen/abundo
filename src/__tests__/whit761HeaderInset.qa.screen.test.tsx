// WHIT-761 QA — the inlined header geometry with a REAL notch inset (top 47). The other
// header tests run at top 0, where "insets.top + 58" and "58" can't be told apart.
// headerHeight = 47 + 58 = 105.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { Animated, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { render, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));

import { NavBarsProvider } from '../motion/NavBarsContext';
import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';

type Rendered = ReturnType<typeof render>;

const refreshControl = jest.fn((offset: number) => (
  <RefreshControl refreshing={false} onRefresh={() => undefined} progressViewOffset={offset} />
));

function renderHeader() {
  return render(
    <NavBarsProvider reduceMotion>
      <ScrollChromeHeader title="Budgets" refreshControl={refreshControl}>
        <Text>body</Text>
      </ScrollChromeHeader>
    </NavBarsProvider>,
  );
}

function headerStyle(r: Rendered) {
  return StyleSheet.flatten(r.UNSAFE_getAllByType(Animated.View)[0].props.style) as {
    paddingTop: number;
    transform: { translateY: { __getValue(): number } }[];
  };
}

// [A5]
it('insets the list top by the full header height (notch + body)', () => {
  const r = renderHeader();
  const content = StyleSheet.flatten(r.UNSAFE_getAllByType(ScrollView)[0].props.contentContainerStyle) as {
    paddingTop?: number; paddingBottom?: number;
  };
  expect(content.paddingTop).toBe(105);
  expect(content.paddingBottom).toBe(192);
});

// [A6]
it('pads the header below the notch (inset + 6)', () => {
  expect(headerStyle(renderHeader()).paddingTop).toBe(53);
});

// [A7]
it('a hidden header slides up by the full height including the notch', () => {
  const r = renderHeader();
  const event = { nativeEvent: { contentOffset: { y: 300 } } } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
  act(() => r.UNSAFE_getAllByType(ScrollView)[0].props.onScroll(event));
  expect(headerStyle(r).transform[0].translateY.__getValue()).toBe(-105);
});

// [A8]
it('the pull-to-refresh spinner is offset by the full header height (WHIT-211)', () => {
  refreshControl.mockClear();
  renderHeader();
  expect(refreshControl).toHaveBeenLastCalledWith(105);
});
