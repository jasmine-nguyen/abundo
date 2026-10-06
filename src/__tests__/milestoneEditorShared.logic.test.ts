// WHIT-776 — the milestone suites share one saved plan (support/milestonePlan SAVED_MILESTONES) and
// one ../context stand-in for the editor (support/milestoneEditor milestoneEditorContextMockModule)
// instead of each keeping its own hand-copied copy.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

const PLAN_FILE = 'support/milestonePlan.ts';
const EDITOR_FILE = 'support/milestoneEditor.ts';
const SELF = 'milestoneEditorShared.logic.test.ts';

// Built from pieces so this file never matches itself.
const SAVE_KEY = ['save', 'Milestones'].join('');
const INLINE_STUB = new RegExp(`useAppContext:\\s*\\(\\)\\s*=>\\s*\\(\\{\\s*${SAVE_KEY}:`);
const PLAN_ROW = new RegExp(
  `label:\\s*'(${['Mid', 'way'].join('')}|${['Mid', 'dle'].join('')})',\\s*targetBalance:\\s*200000` +
    `|label:\\s*'${['Pay', 'off'].join('')}',\\s*targetBalance:\\s*100000`,
);
const SHARED_PLAN = 'SAVED_MILESTONES';
const SHARED_STUB = 'milestoneEditorContextMockModule(';

const PLAN_SUITES = [
  'milestone.screen.test.tsx',
  'milestone.logic.test.ts',
  'mortgage.screen.test.tsx',
  'goalsKit.screen.test.tsx',
  'goalsKit.qa.screen.test.tsx',
  'goalScreenData.edges.screen.test.tsx',
  'saveMilestones.provider.screen.test.tsx',
  'saveMilestonesSignOut.provider.screen.test.tsx',
];
const EDITOR_SUITES = ['milestone.screen.test.tsx', 'goalsKit.qa.screen.test.tsx'];

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');
const scanned = () => testFiles(__dirname).filter((file) => ![PLAN_FILE, EDITOR_FILE, SELF].includes(file));

describe('milestone suites share one saved plan and one editor context stand-in', () => {
  it('the shared plan is the 3-row Start / Midway / Payoff plan', () => {
    const { SAVED_MILESTONES } = require('./support/milestonePlan');
    const [start, midway, payoff] = ['Start', 'Midway', 'Payoff'];
    expect(SAVED_MILESTONES).toEqual([
      { id: 'a', label: start, targetBalance: 300000, targetDate: '2026-01-01' },
      { id: 'b', label: midway, targetBalance: 200000, targetDate: '2027-01-01' },
      { id: 'c', label: payoff, targetBalance: 100000, targetDate: '2028-01-01' },
    ]);
  });

  it('no test file keeps its own copy of the milestone plan', () => {
    expect(scanned().filter((file) => PLAN_ROW.test(read(file)))).toEqual([]);
  });

  it('no test file keeps its own copy of the saveMilestones/showToast context stub', () => {
    expect(scanned().filter((file) => INLINE_STUB.test(read(file)))).toEqual([]);
  });

  it('every milestone suite uses the shared plan', () => {
    expect(PLAN_SUITES.filter((file) => !read(file).includes(SHARED_PLAN))).toEqual([]);
  });

  it('every editor suite mocks ../context with the shared stand-in', () => {
    expect(EDITOR_SUITES.filter((file) => !read(file).includes(SHARED_STUB))).toEqual([]);
  });
});
