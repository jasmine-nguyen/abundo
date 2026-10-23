import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_BAR_CLEARANCE } from '../motion/ScrollChromeHeader';

// ABU-111: a detail page's bottom scroll padding. In the wide-screen pane the tab bar floats over
// it, so clear it like the tab's own list; as its own page, clear the home indicator.
export function useDetailBottomPadding(embedded: boolean, narrowExtra = 30) {
  const insets = useSafeAreaInsets();
  if (embedded) return TAB_BAR_CLEARANCE;
  return insets.bottom + narrowExtra;
}
