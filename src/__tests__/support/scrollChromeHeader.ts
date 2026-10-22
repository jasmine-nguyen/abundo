// Shared helpers for tests that render the real ScrollChromeHeader: drive its ScrollView's
// onScroll, read its flattened content padding, and read the header's slide/fade/padding.
import { act, type RenderResult } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { hostsOfType, styleOf } from './layout';

type Rendered = RenderResult;

const scroller = (r: Rendered) => hostsOfType('RCTScrollView', r.container)[0];

export async function scrollTo(r: Rendered, y: number) {
  // A SectionList's scroll handler also reads the viewport and content heights.
  const event = {
    nativeEvent: {
      contentOffset: { y },
      layoutMeasurement: { height: 800, width: 400 },
      contentSize: { height: 4000, width: 400 },
    },
  } as unknown as NativeSyntheticEvent<NativeScrollEvent>;
  await act(() => scroller(r).props.onScroll(event));
}

export function contentStyle(r: Rendered) {
  return StyleSheet.flatten(scroller(r).props.contentContainerStyle) as {
    flexGrow?: number; paddingTop?: number; paddingBottom?: number; paddingHorizontal?: number;
  };
}

// An animated style value is a live Animated node on the element; read its current number.
const current = (value: number | { __getValue(): number }) => (typeof value === 'number' ? value : value.__getValue());

export function headerMotion(r: Rendered) {
  const style = styleOf(r.getByTestId('screen-header')) as {
    paddingTop: number;
    opacity: number | { __getValue(): number };
    transform: { translateY: number | { __getValue(): number } }[];
  };
  return {
    translateY: current(style.transform[0].translateY),
    opacity: current(style.opacity),
    paddingTop: style.paddingTop,
  };
}
