// WHIT-846: whether the user has reached a category pick's confirm step at least once, remembered
// on the phone. `seen` is undefined until the saved value loads.
import { useCallback, useState } from 'react';
import { useSavedNote } from './useSavedNote';

export function useFirstFilingSeen() {
  const { loaded, note, save } = useSavedNote('abundo.firstFilingSeen');
  // `note` is a ref, so a save alone wouldn't redraw — this mirrors it.
  const [marked, setMarked] = useState(false);
  const markSeen = useCallback(() => { save('1'); setMarked(true); }, [save]);
  let seen: boolean | undefined;
  if (marked) seen = true;
  else if (loaded) seen = note.current === '1';
  return { seen, markSeen };
}
