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

import { isoToUtcDayMs } from './dateutil';

// Reference property value + LVR. As of the Loan facts card these are NO LONGER
// the live source — the app reads the user-entered `homeValue`/`lvr` from context
// (`s.loanFacts`) and shows a "set this up" state until saved. These constants
// remain only as documented reference defaults (and the value the form suggests /
// tests build on). `usableEquity()` takes homeValue + lvr as params, so the live
// values flow straight through it.
export const PROPERTY_VALUE = 770000;
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
// Labels kept in lockstep with the server twin (shared/milestones.py); the payoff-push
// drift-pin test pins these exact rows, so update BOTH if the plan changes.
export const MILESTONES: Milestone[] = [
  { sprint: 0, label: 'Kickoff',        targetBalance: 544000, targetDate: '2026-06-18' },
  { sprint: 1, label: 'Quarter way',    targetBalance: 420000, targetDate: '2027-03-18' },
  { sprint: 2, label: 'Halfway',        targetBalance: 295000, targetDate: '2027-12-18' },
  { sprint: 3, label: 'Three-quarters', targetBalance: 170000, targetDate: '2028-09-18' },
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

// Server limits mirrored from lambda_api/handler.py set_milestones — kept here so the editor's
// guard blocks a bad plan with a friendly message before any round-trip, instead of a 400 + toast.
export const MILESTONE_MAX_COUNT = 50;
export const MILESTONE_LABEL_MAX_LEN = 100;
export const MILESTONE_BALANCE_MAX = 1_000_000_000;

// A real ISO "YYYY-MM-DD" date — rejects an impossible calendar date (2026-02-30), mirroring the
// server's date.fromisoformat. The native picker only yields valid dates, so this mainly guards
// the shared guard's own tests.
function isValidIsoDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

type MilestoneRow = { label: string; targetBalance: number; targetDate: string };

// Validate a milestone plan the way the server does (lambda_api/handler.py set_milestones): a
// non-empty list of at most 50 rows, each with a non-empty label (≤100 chars), a finite target
// balance in [0, 1e9] and a real ISO date, and every step a strictly lower balance AND a later
// date than the one above it. Returns a plain-language message, or null when the plan is valid.
// The one source of truth shared by the editor screen and its tests.
export function milestonesOrderingError(rows: MilestoneRow[]): string | null {
  if (rows.length === 0) return 'Add at least one milestone.';
  if (rows.length > MILESTONE_MAX_COUNT) return `You can have at most ${MILESTONE_MAX_COUNT} milestones.`;

  for (const row of rows) {
    const label = row.label.trim();
    if (label === '') return 'Give every milestone a name.';
    if (label.length > MILESTONE_LABEL_MAX_LEN) return `A milestone name can be at most ${MILESTONE_LABEL_MAX_LEN} characters.`;
    if (!Number.isFinite(row.targetBalance) || row.targetBalance < 0 || row.targetBalance > MILESTONE_BALANCE_MAX) {
      return 'Enter a target balance (0 or more) for every milestone.';
    }
    if (!isValidIsoDate(row.targetDate)) return 'Pick a target date for every milestone.';
  }

  for (let i = 1; i < rows.length; i++) {
    if (isOutOfOrder(rows[i - 1], rows[i])) {
      return 'Each step must be a lower balance and a later date than the one above it.';
    }
  }
  return null;
}

// Which rows sit out of order relative to the row above them — powers the editor's live inline
// warning. Row 0 is never flagged (nothing above it). Pure; mirrors the ordering half of the guard.
export function milestoneOutOfOrderRows(rows: MilestoneRow[]): boolean[] {
  return rows.map((row, i) => i > 0 && isOutOfOrder(rows[i - 1], row));
}

// A step breaks the plan's order unless it drops the balance AND pushes the date later.
function isOutOfOrder(prev: MilestoneRow, cur: MilestoneRow): boolean {
  return !(cur.targetBalance < prev.targetBalance && cur.targetDate > prev.targetDate);
}

// Parse an ISO "YYYY-MM-DD" milestone/today date to a UTC-midnight timestamp.
// UTC so a device timezone / daylight-saving shift can't move a day boundary.
// Uses the shared dateutil helper so the parse lives in one place (WHIT-253).
export function milestoneTime(m: { targetDate: string } | string): number {
  const iso = typeof m === 'string' ? m : m.targetDate;
  return isoToUtcDayMs(iso);
}

// Usable equity toward the next deposit: what you could borrow against the
// property (value * LVR) minus what you still owe. Clamped at 0 and rounded to a
// whole dollar. Shared by goalView and milestoneView so the formula lives once.
export function usableEquity(homeValue: number, balance: number, lvr: number = HOME_LOAN_LVR): number {
  return Math.max(0, Math.round(homeValue * lvr - balance));
}
