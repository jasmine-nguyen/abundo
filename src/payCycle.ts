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

// The stored length that means "monthly" (ABU-44): it steps by calendar month, not 30 days.
// Mirrors MONTHLY_PAY_CYCLE_LENGTH in shared/constants.py.
export const MONTHLY_CYCLE_LENGTH = 30;

// The k-th payday from last_pay_date (k may be negative), as a UTC-day timestamp. Mirrors the
// server's payday_at: monthly steps by calendar month from last_pay_date's own day, clamped to the
// month's last day (a 31st payday goes Feb 28, Mar 31, Apr 30); other lengths step fixed days.
export function paydayAtMs(payCycle: PayCycle, k: number): number {
  const pay = isoToUtcDayMs(payCycle.last_pay_date);
  if (payCycle.length !== MONTHLY_CYCLE_LENGTH) return pay + k * payCycle.length * MS_PER_DAY;
  const anchor = new Date(pay);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + k;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(anchor.getUTCDate(), daysInMonth));
}

// The largest k with paydayAtMs(k) <= dayMs: which pay cycle the day falls in (negative before the
// first payday). Mirrors the server's cycle_index.
export function cycleIndex(payCycle: PayCycle, dayMs: number): number {
  const pay = isoToUtcDayMs(payCycle.last_pay_date);
  if (payCycle.length !== MONTHLY_CYCLE_LENGTH) {
    return Math.floor(wholeDaysBetween(pay, dayMs) / payCycle.length);
  }
  const from = new Date(pay);
  const to = new Date(dayMs);
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  return paydayAtMs(payCycle, months) > dayMs ? months - 1 : months;
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
): { pay: number; todayMs: number; startMs: number; nextMs: number } {
  const pay = isoToUtcDayMs(payCycle.last_pay_date);
  const todayMs = dateToUtcDayMs(today ?? new Date());
  const k = Math.max(0, cycleIndex(payCycle, todayMs));
  return { pay, todayMs, startMs: paydayAtMs(payCycle, k), nextMs: paydayAtMs(payCycle, k + 1) };
}

// The persisted pay cycle -> the live "days until the next payday" + this cycle's real length (a
// monthly cycle is 28-31 days), mirroring the server's cycle_clock. Computed in UTC whole days
// (every UTC day is exactly 24h) so a Melbourne daylight-saving change can't shift the count by a
// day. daysLeft is clamped to [0, cycleLen]; on payday it reads `cycleLen` (a fresh cycle just
// began). Pure: the same (payCycle, today) always give the same result.
export function cycleClock(
  payCycle: PayCycle,
  today?: Date,
): { cycleLen: number; daysLeft: number } {
  const { todayMs, startMs, nextMs } = currentCycleAnchor(payCycle, today);
  // An unparseable last_pay_date makes the span NaN; the stored length keeps the screens' maths whole.
  const cycleLen = wholeDaysBetween(startMs, nextMs) || payCycle.length;
  const daysLeft = Math.max(0, Math.min(cycleLen, wholeDaysBetween(todayMs, nextMs)));
  return { cycleLen, daysLeft };
}

// The NEXT payday (ISO "YYYY-MM-DD"): the end of the current cycle on the shared currentCycleAnchor
// clock. Before the first payday, that first payday itself (however far ahead). Empty string for an
// unparseable date (pay is NaN → utcDayMsToISO returns ''), so the screen hides the line.
export function nextPayday(
  payCycle: PayCycle,
  today?: Date,
): string {
  const { pay, todayMs, nextMs } = currentCycleAnchor(payCycle, today);
  if (pay > todayMs) return payCycle.last_pay_date;
  return utcDayMsToISO(nextMs);
}

// The cycle clock the screens read: prefer the server's authoritative `days_left` and
// `cycle_days` (one clock, no UTC/Melbourne drift on the countdown — WHIT-341), falling back to
// the client cycleClock only for an older server / cold cache where a field is absent.
export function cycleClockView(
  payCycle: PayCycle,
): { cycleLen: number; daysLeft: number } {
  // Clamp to [0, cycleLen] like cycleClock does — the server path bypasses cycleClock's own
  // clamp, so a corrupt/older cache value can't drive elapsedFrac out of [0,1] (negative bars).
  const cycleLen = payCycle.cycle_days ?? cycleClock(payCycle).cycleLen;
  const daysLeft = payCycle.days_left ?? cycleClock(payCycle).daysLeft;
  return { cycleLen, daysLeft: Math.max(0, Math.min(cycleLen, daysLeft)) };
}

export function elapsedFrac(s: { cycleLen: number; daysLeft: number }) { return (s.cycleLen - s.daysLeft) / s.cycleLen; }

// Which day of the cycle today is, 1-based: payday (daysLeft = length) is day 1, the last day (daysLeft 0) is day length.
export function dayOfCycle(s: { cycleLen: number; daysLeft: number }) { return Math.min(s.cycleLen, s.cycleLen - s.daysLeft + 1); }
