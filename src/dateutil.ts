// Shared date helpers for ISO "YYYY-MM-DD" values (WHIT-126 follow-up).
// The helpers up top parse/format via LOCAL date components (not UTC), so a day the
// user picked never drifts across a midnight timezone boundary. A separate UTC
// whole-day section at the bottom (WHIT-253) counts days on a fixed UTC clock for the
// pay-cycle / milestone math. Kept in one place so callers can't grow independently-
// drifting copies.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// An ISO "YYYY-MM-DD" -> local midnight of that day (never a UTC-parsed instant).
export function parseISODate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

// A Date -> its local "YYYY-MM-DD" (zero-padded month/day).
export function toISODate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

// An ISO "YYYY-MM-DD" -> a "20 Jun 2026" label, in local time.
export function formatDayMonthYear(iso: string): string {
  const d = parseISODate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// --- UTC whole-day math (WHIT-253) -----------------------------------------
// DISTINCT from the LOCAL helpers above: these count days on a fixed UTC clock,
// where every day is exactly 24h, so a daylight-saving change can't shift a day
// boundary. Shared by cycleClock, paydaysUntil, the milestone schedule, and
// milestoneTime so the parse + round behaviour lives in one place. No NaN guard
// inside — callers decide what an unparseable date means (paydaysUntil returns
// 0; cycleClock lets NaN propagate).
const MS_PER_DAY = 86400000;

// An ISO "YYYY-MM-DD" -> the UTC-midnight timestamp of that day. NaN on an
// unparseable date (Date.UTC(NaN, ...) is NaN).
export function isoToUtcDayMs(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

// A Date -> the UTC-midnight timestamp of its LOCAL calendar day (the device's
// day). Reads local components on purpose (getFullYear/getMonth/getDate, not
// their getUTC* forms) so "today" is the day the user sees on their device.
export function dateToUtcDayMs(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

// Whole days between two UTC-day timestamps, integer-exact. NaN if either is NaN.
export function wholeDaysBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}
