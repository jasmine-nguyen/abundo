// WHIT-682 — the minimum expect( count for each suite moved onto the fake server lives in one place:
// the noAutoMockApi baselines. Each card's guard only lists its files and checks they are in those
// baselines and in POPUP_SUITES, without repeating the numbers or the size of POPUP_SUITES.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const BASELINES_OWNER = 'noAutoMockApi.logic.test.ts';
const THIS_FILE = 'whit682MinimumCountsOneHome.logic.test.ts';

const CARD_GUARDS = [
  'whit670AddRulePopupsRealQueries.logic.test.ts',
  'whit670ApplyRulesPopupsRealQueries.logic.test.ts',
  'whit670PickerConfirmPopupsRealQueries.logic.test.ts',
  'whit671PopupSuitesRealQueries.logic.test.ts',
];

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

// A suite file name keyed to a number, e.g. a record entry for a test file with its floor.
const MINIMUM_ENTRY = new RegExp(`'[\\w.-]+\\.test\\.tsx?'` + ':\\s*\\d+');
const POPUP_COUNT = new RegExp('expect\\(listed\\)\\.toHaveLength\\(\\d+\\)');

describe('each moved suite keeps its minimum check count in one list', () => {
  it('only the noAutoMockApi baselines record a minimum count per suite, and no guard pins how many POPUP_SUITES there are', () => {
    const testFiles = readdirSync(__dirname).filter(
      (file) => /\.test\.tsx?$/.test(file) && file !== BASELINES_OWNER && file !== THIS_FILE,
    );

    const problems = testFiles.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (MINIMUM_ENTRY.test(text)) found.push(`${file}: repeats a per-suite minimum count`);
      if (POPUP_COUNT.test(text)) found.push(`${file}: hard-codes the POPUP_SUITES count`);
      return found;
    });

    expect(problems).toEqual([]);
    expect(source(BASELINES_OWNER)).toMatch(MINIMUM_ENTRY);
  });

  it('every card guard checks its files are in both the noAutoMockApi baselines and POPUP_SUITES', () => {
    const problems = CARD_GUARDS.flatMap((guard) => {
      const text = source(guard);
      const found: string[] = [];
      if (!text.includes(`source('${BASELINES_OWNER}')`)) found.push(`${guard}: never reads the noAutoMockApi baselines`);
      if (!text.includes(`source('whit641WholeAppSuitesRealQueries.logic.test.ts')`)) found.push(`${guard}: never reads POPUP_SUITES`);
      return found;
    });

    expect(problems).toEqual([]);
  });
});
