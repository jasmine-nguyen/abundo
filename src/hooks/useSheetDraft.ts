import { Dispatch, SetStateAction, useEffect, useState } from 'react';
import { useAppContext } from '../context';

// WHIT-285: the "draft survives a Face ID lock" plumbing, in one place.
//
// A sheet's in-progress input (the rule pattern, the goal balance, the picker's open-form
// flag) must survive a lock — Overlays unmounts the whole layer while locked and remounts it
// on unlock. The provider keeps a ref-map of drafts that outlives the lock (src/context.tsx);
// each sheet stashed its field into it and read it back on remount. That was three parts hand-
// copied per sheet: a lazy-init read of readSheetDraft(key), a persist effect writing
// writeSheetDraft(key, value), and the unknown -> T cast. This owns all three.
//
// `init` receives the once-cast stored draft (undefined when none) so each sheet keeps its own
// fallback (draft?.x ?? editing?.x ?? default) — the hook can't know those defaults. The persist
// effect writes the COMMITTED value (not from the setter), so it never lags a keystroke, and it
// writes on mount too, exactly as the hand-copied effects did. readSheetDraft/writeSheetDraft are
// stable (useCallback([], ...)), so the effect only re-fires on a real value or key change.
//
// Clearing stays the provider's job (on sheet close / sign-out); the hook never clears.
export function useSheetDraft<T>(
  key: string,
  init: (draft: T | undefined) => T,
): [T, Dispatch<SetStateAction<T>>] {
  const { readSheetDraft, writeSheetDraft } = useAppContext();
  const [value, setValue] = useState<T>(() => init(readSheetDraft(key) as T | undefined));
  useEffect(() => {
    writeSheetDraft(key, value);
  }, [value, key, writeSheetDraft]);
  return [value, setValue];
}
