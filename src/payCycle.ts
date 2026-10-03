// WHIT-630: the pay-cycle clock, moved out of context.tsx so queries.ts and the screens can read
// it without importing the store.
import { isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween, utcDayMsToISO, MS_PER_DAY } from './dateutil';

// The pay-cycle length -> its human name. Pure + exported so the provider and the
// tests share one source of truth (rather than each reimplementing the mapping).
export function cycleName(length: number): 'Weekly' | 'Fortnightly' | 'Monthly' {
  return length === 7 ? 'Weekly' : length === 14 ? 'Fortnightly' : 'Monthly';
}

// The current pay-cycle anchor, computed ONCE on the shared UTC-whole-day clock (WHIT-575). Both
// cycleClock (daysLeft) and cycleStart (the "Started {date}" line) read this, so the hero's countdown
// and start date can't drift apart. Returns the raw pieces; each caller applies its own edge policy
// (cycleClock clamps to full length before the first payday; cycleStart hides the line for a
// future/unparseable date). A NaN pay (unparseable last_pay_date) propagates through the pieces
// exactly as dateutil's primitives define — the callers guard it.
function currentCycleAnchor(
  payCycle: { length: number; last_pay_date: string },
  today?: Date,
): { pay: number; todayMs: number; elapsedDays: number; cyclesElapsed: number; startMs: number } {
  const length = payCycle.length;
  const pay = isoToUtcDayMs(payCycle.last_pay_date);
  const todayMs = dateToUtcDayMs(today ?? new Date());
  const elapsedDays = wholeDaysBetween(pay, todayMs);        // integer-exact whole days
  const cyclesElapsed = Math.max(0, Math.floor(elapsedDays / length));
  const startMs = pay + cyclesElapsed * length * MS_PER_DAY;
  return { pay, todayMs, elapsedDays, cyclesElapsed, startMs };
}

// The persisted pay cycle -> the live "days until the next payday" + cycle length,
// mirroring the server's current_cycle_window. Computed in UTC whole days (every
// UTC day is exactly 24h) so a Melbourne daylight-saving change can't shift the
// count by a day. daysLeft is clamped to [0, length]; on payday it reads `length`
// (a fresh cycle just began). Pure: the same (payCycle, today) always give the
// same result.
export function cycleClock(
  payCycle: { length: number; last_pay_date: string },
  today?: Date,
): { cycleLen: number; daysLeft: number } {
  const length = payCycle.length;
  const { elapsedDays, cyclesElapsed } = currentCycleAnchor(payCycle, today);
  const daysIntoCycle = elapsedDays - cyclesElapsed * length;
  const daysLeft = Math.max(0, Math.min(length, length - daysIntoCycle));
  return { cycleLen: length, daysLeft };
}

// The current cycle's START date (ISO "YYYY-MM-DD"): the most recent payday on or before today, on
// the shared currentCycleAnchor clock — so it never drifts from the days-left countdown, and never
// across a Melbourne daylight-saving change. Empty string when there's no started cycle to show: the
// first payday is still in the future (showing "Started today" would be false), or the date is
// unparseable (pay is NaN → utcDayMsToISO returns '').
export function cycleStart(
  payCycle: { length: number; last_pay_date: string },
  today?: Date,
): string {
  const { pay, todayMs, startMs } = currentCycleAnchor(payCycle, today);
  if (pay > todayMs) return '';
  return utcDayMsToISO(startMs);
}

// The cycle clock the screens read: prefer the server's authoritative `days_left` (one clock,
// no UTC/Melbourne drift on the countdown — WHIT-341), falling back to the client cycleClock
// only for an older server / cold cache where the field is absent.
export function cycleClockView(
  payCycle: { length: number; last_pay_date: string; days_left?: number },
): { cycleLen: number; daysLeft: number } {
  // Clamp to [0, length] like cycleClock does — the server path bypasses cycleClock's own
  // clamp, so a corrupt/older cache value can't drive elapsedFrac out of [0,1] (negative bars).
  const daysLeft = payCycle.days_left ?? cycleClock(payCycle).daysLeft;
  return { cycleLen: payCycle.length, daysLeft: Math.max(0, Math.min(payCycle.length, daysLeft)) };
}

// The next payday's ISO date: today plus the cycle's days left, on the UTC whole-day clock.
export function nextPaydayISO(daysLeft: number, today?: Date): string {
  return utcDayMsToISO(dateToUtcDayMs(today ?? new Date()) + daysLeft * MS_PER_DAY);
}

export function elapsedFrac(s: { cycleLen: number; daysLeft: number }) { return (s.cycleLen - s.daysLeft) / s.cycleLen; }
