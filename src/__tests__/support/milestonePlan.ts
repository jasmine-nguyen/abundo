// WHIT-776 — the 3-row saved milestone plan the milestone suites share. Usage:
//
//   import { SAVED_MILESTONES } from './support/milestonePlan';
//   seedGoal(server, { milestones: SAVED_MILESTONES });
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import type { MilestoneRecord } from '../../api';

export const SAVED_MILESTONES: MilestoneRecord[] = [
  { id: 'a', label: 'Start', targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];
