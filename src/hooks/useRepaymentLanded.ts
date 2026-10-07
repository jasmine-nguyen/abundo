// WHIT-820 — compares the latest repayment with the note this phone saved, once the note has
// loaded and the screen's data is `ready` (an empty first draw must never overwrite the note).
// A new repayment → `justLanded` for the rest of the visit plus a celebration key; the note is
// saved straight away, so the next visit shows the plain row. An older repayment never
// overwrites a newer note.
import { useEffect, useState } from 'react';
import type { Repayment } from '../api';
import { isRepaymentNew, repaymentNote, shouldSaveRepaymentNote, REPAYMENT_SEEN_KEY } from '../repaymentLanded';
import { useSavedNote } from './useSavedNote';

export function useRepaymentLanded(repayment: Repayment, ready: boolean) {
  const { loaded, note, save } = useSavedNote(REPAYMENT_SEEN_KEY);
  const [celebrationKey, setCelebrationKey] = useState(0);

  useEffect(() => {
    if (!loaded || !ready) return;
    const saved = note.current;
    if (!shouldSaveRepaymentNote(saved, repayment)) return;
    if (isRepaymentNew(saved, repayment, new Date())) setCelebrationKey((k) => k + 1);
    save(repaymentNote(repayment)!);
  }, [repayment, loaded, ready]);

  return { justLanded: celebrationKey > 0, celebrationKey };
}
