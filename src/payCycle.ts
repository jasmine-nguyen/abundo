// WHIT-630: the pay-cycle clock, moved out of context.tsx so queries.ts and the screens can read
// it without importing the store.
import { isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween, utcDayMsToISO, MS_PER_DAY } from './dateutil';
import type { PayCycle } from './api';

// The pay-cycle length -> its human name. Pure + exported so the provider and the
// tests share one source of truth (rather than each reimplementing the mapping).
export function cycleName(length: number): 'Weekly' | 'Fortnightly' | 'Monthly' {
  return length === 7 ? 'Weekly' : length === 14 ? 'Fortnightly' : 'Monthly';
}

const PAYDAYS_PER_YEAR = { Weekly: 52, Fortnightly: 26, Monthly: 12 } as const;

export function paydaysPerYear(length: number): number {
  return PAYDAYS_PER_YEAR[cycleName(length)];
}

// The current pay-cycle anchor, computed ONCE on the shared UTC-whole-day clock (WHIT-575).
// cycleClock (daysLeft) and nextPayday (the hero's "Next payday {date}" line, WHIT-706) both read
// this, so the countdown and the date can't drift apart. Returns the raw pieces; each caller
// applies its own edge policy (cycleClock clamps to full length before the first payday;
// nextPayday returns a future first payday as is). A NaN pay (unparseable last_pay_date)
// propagates through the pieces exactly as dateutil's primitives define — the callers guard it.
function currentCycleAnchor(
  payCycle: PayCycle,
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
  payCycle: PayCycle,
  today?: Date,
): { cycleLen: number; daysLeft: number } {
  const length = payCycle.length;
  const { elapsedDays, cyclesElapsed } = currentCycleAnchor(payCycle, today);
  const daysIntoCycle = elapsedDays - cyclesElapsed * length;
  const daysLeft = Math.max(0, Math.min(length, length - daysIntoCycle));
  return { cycleLen: length, daysLeft };
}

// The NEXT payday (ISO "YYYY-MM-DD"): the end of the current cycle on the shared currentCycleAnchor
// clock. Before the first payday, that first payday itself (however far ahead). Empty string for an
// unparseable date (pay is NaN → utcDayMsToISO returns ''), so the screen hides the line.
export function nextPayday(
  payCycle: PayCycle,
  today?: Date,
): string {
  const { pay, todayMs, startMs } = currentCycleAnchor(payCycle, today);
  if (pay > todayMs) return payCycle.last_pay_date;
  return utcDayMsToISO(startMs + payCycle.length * MS_PER_DAY);
}

// The cycle clock the screens read: prefer the server's authoritative `days_left` (one clock,
// no UTC/Melbourne drift on the countdown — WHIT-341), falling back to the client cycleClock
// only for an older server / cold cache where the field is absent.
export function cycleClockView(
  payCycle: PayCycle,
): { cycleLen: number; daysLeft: number } {
  // Clamp to [0, length] like cycleClock does — the server path bypasses cycleClock's own
  // clamp, so a corrupt/older cache value can't drive elapsedFrac out of [0,1] (negative bars).
  const daysLeft = payCycle.days_left ?? cycleClock(payCycle).daysLeft;
  return { cycleLen: payCycle.length, daysLeft: Math.max(0, Math.min(payCycle.length, daysLeft)) };
}

export function elapsedFrac(s: { cycleLen: number; daysLeft: number }) { return (s.cycleLen - s.daysLeft) / s.cycleLen; }
