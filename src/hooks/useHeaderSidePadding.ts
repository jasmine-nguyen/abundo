import { useSafeAreaInsets } from 'react-native-safe-area-context';

const HEADER_SIDE_PADDING = 20;

// Keeps a header's buttons clear of the rounded corners and side notches when the screen turns sideways (ABU-118).
export function useHeaderSidePadding() {
  const insets = useSafeAreaInsets();
  return { paddingLeft: HEADER_SIDE_PADDING + insets.left, paddingRight: HEADER_SIDE_PADDING + insets.right };
}
