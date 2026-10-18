import { useCallback, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

// Tells a page whether its content has scrolled under the title bar, so the Header can draw
// its bottom edge (`divider`). Spread `scrollProps` onto the page's ScrollView / SectionList.
export function useScrollEdge() {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => setScrolled(e.nativeEvent.contentOffset.y > 0),
    [],
  );
  return { scrolled, scrollProps: { onScroll, scrollEventThrottle: 16 } };
}
