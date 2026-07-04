// Home-loan paydown plan — the Sprint 0–4 milestones for WHIT-8 (Home Loan
// Milestone screen). Single source of truth, transcribed from the Notion "IP1
// Equity Milestones" database (the app can't read Notion at runtime). Update
// these here if the plan in Notion changes.
//
// Usable equity is not stored per-row here; it's derived from PROPERTY_VALUE and
// HOME_LOAN_LVR so the screen and the plan can't drift. Every Notion row's
// "Target Usable Equity" equals PROPERTY_VALUE * HOME_LOAN_LVR - targetBalance
// (e.g. 770000 * 0.8 - 544000 = 72000 at Sprint 0), which is what pins the two
// constants below.

// The property's value used for the usable-equity (borrowing-power) calc. Not
// available from the balance feed — it's a valuation, so it lives here.
export const PROPERTY_VALUE = 770000;

// Loan-to-value ratio the lender allows against the property (80%). Usable
// equity toward the next deposit = PROPERTY_VALUE * HOME_LOAN_LVR - balance.
export const HOME_LOAN_LVR = 0.8;

export interface Milestone {
  sprint: number;
  label: string;
  targetBalance: number;   // outstanding loan balance to reach by targetDate
  targetDate: string;      // ISO "YYYY-MM-DD"
}

// Ordered by targetDate ascending (equivalently targetBalance descending — the
// loan is being paid DOWN, so each later milestone is a lower balance). The
// invariant below enforces both, because milestoneView's schedule curve and
// next-milestone selection both rely on this ordering.
export const MILESTONES: Milestone[] = [
  { sprint: 0, label: 'Offset Split',   targetBalance: 544000, targetDate: '2026-06-18' },
  { sprint: 1, label: 'Month 9',        targetBalance: 420000, targetDate: '2027-03-18' },
  { sprint: 2, label: 'Halfway',        targetBalance: 295000, targetDate: '2027-12-18' },
  { sprint: 3, label: 'Three-quarter',  targetBalance: 170000, targetDate: '2028-09-18' },
  { sprint: 4, label: 'Target',         targetBalance: 55000,  targetDate: '2029-06-18' },
];

// Fail loud at module load if the milestones aren't strictly ordered: strictly
// increasing dates (so the schedule curve never divides by a zero time delta)
// AND strictly decreasing balances (so "first target below the current balance"
// is the next milestone). A typo in the table above trips this immediately
// rather than silently producing NaN progress or the wrong "next" milestone.
for (let i = 1; i < MILESTONES.length; i++) {
  const prev = MILESTONES[i - 1];
  const cur = MILESTONES[i];
  if (!(milestoneTime(cur) > milestoneTime(prev))) {
    throw new Error(`MILESTONES must have strictly increasing targetDate (index ${i})`);
  }
  if (!(cur.targetBalance < prev.targetBalance)) {
    throw new Error(`MILESTONES must have strictly decreasing targetBalance (index ${i})`);
  }
}

// Parse an ISO "YYYY-MM-DD" milestone/today date to a UTC-midnight timestamp.
// UTC so a device timezone / daylight-saving shift can't move a day boundary
// (same approach as cycleClock in context.tsx).
export function milestoneTime(m: { targetDate: string } | string): number {
  const iso = typeof m === 'string' ? m : m.targetDate;
  const [y, mo, d] = iso.split('-').map(Number);
  return Date.UTC(y, mo - 1, d);
}

// Usable equity toward the next deposit: what you could borrow against the
// property (value * LVR) minus what you still owe. Clamped at 0 and rounded to a
// whole dollar. Shared by goalView and milestoneView so the formula lives once.
export function usableEquity(homeValue: number, balance: number, lvr: number = HOME_LOAN_LVR): number {
  return Math.max(0, Math.round(homeValue * lvr - balance));
}
