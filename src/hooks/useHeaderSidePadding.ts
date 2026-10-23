import { useSafeAreaInsets } from 'react-native-safe-area-context';

const HEADER_SIDE_PADDING = 20;
const PAGE_SIDE_PADDING = 18;

function useSafeSidePadding(base: number) {
  const insets = useSafeAreaInsets();
  return { paddingLeft: base + insets.left, paddingRight: base + insets.right };
}

// Keeps a header's buttons clear of the rounded corners and side notches when the screen turns sideways (ABU-118).
export function useHeaderSidePadding() {
  return useSafeSidePadding(HEADER_SIDE_PADDING);
}

// Same for a page's content under the header (ABU-119).
export function usePageSidePadding() {
  return useSafeSidePadding(PAGE_SIDE_PADDING);
}
