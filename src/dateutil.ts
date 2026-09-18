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

// An ISO "YYYY-MM-DD" -> a "20 Jun" label (no year), in local time. Same round-trip as
// formatDayMonthYear; drop the year for a compact within-cycle label. Empty string on an
// empty/unparseable ISO, so a caller never renders "NaN undefined".
export function formatDayMonth(iso: string): string {
  const d = parseISODate(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// --- UTC whole-day math (WHIT-253) -----------------------------------------
// DISTINCT from the LOCAL helpers above: these count days on a fixed UTC clock,
// where every day is exactly 24h, so a daylight-saving change can't shift a day
// boundary. Shared by cycleClock, paydaysUntil, the milestone schedule, and
// milestoneTime so the parse + round behaviour lives in one place. No NaN guard
// inside — callers decide what an unparseable date means (paydaysUntil returns
// 0; cycleClock lets NaN propagate).
export const MS_PER_DAY = 86400000;

// An ISO "YYYY-MM-DD" -> the UTC-midnight timestamp of that day. NaN on an
// unparseable date (Date.UTC(NaN, ...) is NaN).
export function isoToUtcDayMs(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

// The inverse of isoToUtcDayMs: a UTC-midnight timestamp -> its ISO "YYYY-MM-DD". Reads UTC
// components (the ms IS a UTC-day boundary) so the calendar day never drifts. '' on NaN, so a
// caller fed an unparseable date renders nothing rather than "NaN-NaN-NaN".
export function utcDayMsToISO(ms: number): string {
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}-${day}`;
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
