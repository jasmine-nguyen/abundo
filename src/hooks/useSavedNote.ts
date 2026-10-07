// A note saved on the phone (AsyncStorage), loaded once on mount. `loaded` turns true when the read
// finishes (a failed read counts as "no note"); `note` holds the raw string so each caller parses
// its own and can keep a working copy without a redraw. `save` writes it back, ignoring failures.
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export function useSavedNote(key: string) {
  const note = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(key).catch(() => null).then((raw) => {
      if (cancelled) return;
      note.current = raw;
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [key]);

  const save = useCallback((value: string) => {
    note.current = value;
    AsyncStorage.setItem(key, value).catch(() => {});
  }, [key]);

  return { loaded, note, save };
}
