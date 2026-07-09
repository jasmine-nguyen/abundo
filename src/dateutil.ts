// Shared local-date helpers for ISO "YYYY-MM-DD" values (WHIT-126 follow-up).
// Everything parses/formats via LOCAL date components (not UTC), so a day the user
// picked never drifts across a midnight timezone boundary. Kept in one place so the
// loan form and the pay-cycle picker can't grow independently-drifting copies.

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
