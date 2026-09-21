// WHIT-341 GAP — the "one clock" parity claim, client side + the cold-cache fallback.
// Runs under TZ=Australia/Melbourne (see the test script), so `new Date(y,m,d)` is a
// Melbourne local-midnight day — exactly the calendar day the server's Melbourne clock
// reports. cycleClock reads that day's UTC-whole-day count, so the two must coincide.
import { describe, it, expect } from '@jest/globals';
import { cycleClock, cycleClockView, elapsedFrac } from '../context';

// A Melbourne local-calendar Date for Y-M-D (month 1-based).
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

// The SERVER algorithm, re-implemented independently (lambda_api/handler.get_paycycle_view
// over shared/spend.current_cycle_window): cycle_start = most-recent payday <= today, then
// days_left = (cycle_start + length) - today. Distinct arithmetic from cycleClock's modular
// form, so if cycleClock drifts, they disagree here (fail-on-revert for cycleClock).
function serverDaysLeft(lastPayDate: string, length: number, today: Date): number {
  const MS = 86400000;
  const [py, pm, pd] = lastPayDate.split('-').map(Number);
  const pay = Date.UTC(py, pm - 1, pd);
  const todayMs = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const elapsed = Math.round((todayMs - pay) / MS);
  const cyclesElapsed = Math.max(0, Math.floor(elapsed / length));
  let cycleStart = pay + cyclesElapsed * length * MS;
  if (cycleStart > todayMs) cycleStart = todayMs;
  const nextPayday = cycleStart + length * MS;
  return Math.round((nextPayday - todayMs) / MS);
}

describe('cycleClock vs server days_left parity (across Melbourne DST weeks)', () => {
  const cases: Array<[string, number]> = [
    ['2026-03-22', 14], ['2026-01-01', 7], ['2025-12-15', 30], ['2026-04-05', 14],
  ];
  // DST ends 2026-04-05, starts 2026-10-04 — sweep 14 days over each seam.
  const weekStarts: Array<[number, number]> = [[2026, 4], [2026, 10]];

  for (const [lastPay, length] of cases) {
    for (const [wy, wm] of weekStarts) {
      it(`agrees for pay=${lastPay} len=${length} across ${wy}-${wm}`, () => {
        for (let i = 1; i <= 14; i++) {
          const today = day(wy, wm, i);
          expect(cycleClock({ length, last_pay_date: lastPay }, today).daysLeft)
            .toBe(serverDaysLeft(lastPay, length, today));
        }
      });
    }
  }
});

// Cold cache / first paint: DEFAULT-shaped payCycle carries NO days_left. cycleClockView
// MUST fall back to a real cycleClock number — never NaN/undefined that would blank the hero.
describe('cycleClockView cold-cache fallback is a finite number, not NaN', () => {
  it('yields a finite daysLeft and a finite elapsedFrac with no days_left field', () => {
    const view = cycleClockView({ length: 14, last_pay_date: '2024-01-03' });
    expect(Number.isFinite(view.daysLeft)).toBe(true);
    expect(Number.isNaN(view.daysLeft)).toBe(false);
    expect(view.daysLeft).toBe(cycleClock({ length: 14, last_pay_date: '2024-01-03' }).daysLeft);
    expect(Number.isFinite(elapsedFrac(view))).toBe(true);
  });
});
