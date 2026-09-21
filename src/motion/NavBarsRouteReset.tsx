// WHIT-200 — the single owner of the "reset bars to shown" lifecycle. Rendered once,
// inside the NavBarsProvider AND inside the root navigator (from the tabs layout), it
// re-shows the bars on ANY route change — a tab switch OR pushing/popping a detail screen
// (e.g. Budgets → a budget detail → back). This replaces the old split reset (a per-screen
// focus effect + a tab-index effect on the tab bar), neither of which covered the detail
// push/pop case.
//
// It lives in its OWN file (not NavBarsContext) so the context module stays navigation-
// free — bare screens/tests can consume the context without pulling in expo-router.
import { useEffect } from 'react';
import { usePathname } from 'expo-router';
import { useNavBars } from './NavBarsContext';

export function NavBarsRouteReset(): null {
  const { setNavBars } = useNavBars();
  const pathname = usePathname();
  useEffect(() => { setNavBars('shown'); }, [pathname, setNavBars]);
  return null;
}
