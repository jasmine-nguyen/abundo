import { useCallback, useEffect, useState } from 'react';
import { useIsFocused, useRouter } from 'expo-router';
import { useWideLayout } from './useWideLayout';

// ABU-110: opens a list item's detail — beside the list on a wide screen, as its own page otherwise.
// Folding to a narrow screen with an item open reopens it full screen (only if this tab is in view).
// Pass a stable `hrefFor` (module-level), so `open` stays stable for memoised rows.
export function useOpenDetail<T>(hrefFor: (item: T) => string) {
  const wide = useWideLayout();
  const focused = useIsFocused();
  const router = useRouter();
  const [selected, setSelected] = useState<T>();

  useEffect(() => {
    if (wide || selected === undefined) return;
    setSelected(undefined);
    if (focused) router.push(hrefFor(selected));
  }, [wide, selected, focused, hrefFor, router]);

  const open = useCallback((item: T) => {
    if (!wide) return router.push(hrefFor(item));
    setSelected(item);
  }, [wide, hrefFor, router]);

  const close = useCallback(() => setSelected(undefined), []);

  return { selected, open, close };
}
