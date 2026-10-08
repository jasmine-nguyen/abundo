// WHIT-820 — a repayment push opens Home loan. Is the latest repayment new to this phone, and what
// does the "Just landed" card say? Pure; the phone's note is `${date}@${amount}` (no server id).
import type { Repayment } from './api';
import type { MilestoneView } from './context';
import { fmt } from './theme';
import { dateToUtcDayMs, isoToUtcDayMs, wholeDaysBetween } from './dateutil';

export const REPAYMENT_SEEN_KEY = 'abundo.lastSeenRepayment';
// With no note yet (first visit after the update), only a repayment this recent celebrates.
const FIRST_SEEN_WINDOW_DAYS = 7;

export function repaymentNote(repayment: Repayment): string | null {
  if (repayment.amount == null || repayment.date == null) return null;
  return `${repayment.date}@${repayment.amount}`;
}

// Save the note when nothing is saved yet, or this repayment differs and isn't older than the saved
// one — so an older repayment never overwrites a newer note.
export function shouldSaveRepaymentNote(seen: string | null, repayment: Repayment): boolean {
  const note = repaymentNote(repayment);
  if (note == null) return false;
  if (seen == null) return true;
  return note !== seen && repayment.date! >= seen.split('@')[0]; // ISO dates compare correctly as text
}

export function isRepaymentNew(seen: string | null, repayment: Repayment, today: Date): boolean {
  if (!shouldSaveRepaymentNote(seen, repayment)) return false;
  if (seen != null) return true;
  return wholeDaysBetween(isoToUtcDayMs(repayment.date!), dateToUtcDayMs(today)) <= FIRST_SEEN_WINDOW_DAYS;
}

export function repaymentLandedView(repayment: Repayment, m: MilestoneView) {
  const amount = repayment.amount!;
  const split = repayment.principal != null && repayment.interest != null;
  const headline = repayment.principal != null
    ? `${fmt(repayment.principal)} off your loan`
    : `${fmt(amount)} toward your home loan`;
  const detail = split ? `${fmt(amount)} repayment · ${fmt(repayment.interest!)} interest` : null;
  return { headline, detail, milestoneLine: milestoneLine(m) };
}

function milestoneLine(m: MilestoneView): string | null {
  if (!m.hasPlan || !m.hasBalance) return null;
  if (!m.nextMilestone) return 'Every milestone reached 🎉';
  return `Next: ${m.nextMilestone.label} · ${m.amountToNextLabel} to go`;
}
