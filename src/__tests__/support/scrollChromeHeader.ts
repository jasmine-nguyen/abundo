// Shared helpers for tests that render the real ScrollChromeHeader: drive its ScrollView's
// onScroll, read its flattened content padding, and read the header's slide/fade/padding.
import { act, render } from '@testing-library/react-native';
import { Animated, ScrollView, StyleSheet } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { styleOf } from './layout';

type Rendered = ReturnType<typeof render>;

export function scrollTo(r: Rendered, y: number) {
  // A SectionList's scroll handler also reads the viewport and content heights.
  const event = {
    nativeEvent: {
      contentOffset: { y },
      layoutMeasurement: { height: 800, width: 400 },
      contentSize: { height: 4000, width: 400 },
    },
  } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
  act(() => r.UNSAFE_getAllByType(ScrollView)[0].props.onScroll(event));
}

export function contentStyle(r: Rendered) {
  const sv = r.UNSAFE_getAllByType(ScrollView)[0];
  return StyleSheet.flatten(sv.props.contentContainerStyle) as {
    flexGrow?: number; paddingTop?: number; paddingBottom?: number; paddingHorizontal?: number;
  };
}

export function headerMotion(r: Rendered) {
  const style = styleOf(r.UNSAFE_getAllByType(Animated.View)[0]) as {
    paddingTop: number;
    opacity: { __getValue(): number };
    transform: { translateY: { __getValue(): number } }[];
  };
  return {
    translateY: style.transform[0].translateY.__getValue(),
    opacity: style.opacity.__getValue(),
    paddingTop: style.paddingTop,
  };
}
