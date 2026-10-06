// Shared helpers for tests that render the real ScrollChromeHeader: drive its ScrollView's
// onScroll and read its flattened content padding.
import { act, render } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type Rendered = ReturnType<typeof render>;

export function scrollTo(r: Rendered, y: number) {
  const event = { nativeEvent: { contentOffset: { y } } } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
  act(() => r.UNSAFE_getAllByType(ScrollView)[0].props.onScroll(event));
}

export function contentStyle(r: Rendered) {
  const sv = r.UNSAFE_getAllByType(ScrollView)[0];
  return StyleSheet.flatten(sv.props.contentContainerStyle) as {
    flexGrow?: number; paddingTop?: number; paddingBottom?: number; paddingHorizontal?: number;
  };
}
