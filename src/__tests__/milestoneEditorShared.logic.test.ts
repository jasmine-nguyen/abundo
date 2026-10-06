// WHIT-776 — the milestone suites share one saved plan (support/milestonePlan SAVED_MILESTONES) and
// one ../context stand-in for the editor (support/milestoneEditor milestoneEditorContextMockModule)
// instead of each keeping its own hand-copied copy.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

const SELF = 'milestoneEditorShared.logic.test.ts';
const SHARED_FILES = ['support/milestonePlan.ts', 'support/milestoneEditor.ts', SELF];

const INLINE_STUB = /useAppContext:\s*\(\)\s*=>\s*\(\{\s*saveMilestones:/;
const PLAN_ROW = /label:\s*'(Midway|Middle)',\s*targetBalance:\s*200000|label:\s*'Payoff',\s*targetBalance:\s*100000/;

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');
const scanned = () => testFiles(__dirname).filter((file) => !SHARED_FILES.includes(file));

describe('milestone suites share one saved plan and one editor context stand-in', () => {
  it('no test file keeps its own copy of the milestone plan', () => {
    expect(scanned().filter((file) => PLAN_ROW.test(read(file)))).toEqual([]);
  });

  it('no test file keeps its own copy of the saveMilestones/showToast context stub', () => {
    expect(scanned().filter((file) => INLINE_STUB.test(read(file)))).toEqual([]);
  });
});
