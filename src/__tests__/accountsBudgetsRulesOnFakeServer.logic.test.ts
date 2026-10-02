// WHIT-688 slice 2: the Accounts, Budgets, Rules and date-picker suites run the real screen data
// code over the fake server, and the six files are off the shrink-only allow-list.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { QUERIES_MOCK } from './noQueriesMock.logic.test';

const SLICE_FILES = [
  'accountDetail.screen.test.tsx',
  'accountsTab.screen.test.tsx',
  'westpacAccountsTab.screen.test.tsx',
  'budgetsWrapperStates.screen.test.tsx',
  'RulesScreen.screen.test.tsx',
  'nativeDateCallSites.screen.test.tsx',
];

// Folded into accountsTab (Westpac) or deleted as layout/animation with its one real check moved
// into budgetsQuery (budgets wrapper states).
const REMOVED_FILES = ['westpacAccountsTab.screen.test.tsx', 'budgetsWrapperStates.screen.test.tsx'];

const FAKE_SERVER_SUITES = [
  'accountDetail.screen.test.tsx',
  'accountsTab.screen.test.tsx',
  'RulesScreen.screen.test.tsx',
  'nativeDateCallSites.screen.test.tsx',
];

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function allowList(): string[] {
  const body = read('noQueriesMock.logic.test.ts').match(/const ALLOWED = new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!body) throw new Error('ALLOWED not found in noQueriesMock.logic.test.ts');
  return [...body[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('Accounts, Budgets, Rules and date-picker tests run the real screen data code', () => {
  it('the six files are off the allow-list, the folded and layout-only files are gone, and none fakes the screen data code', () => {
    const allowed = allowList();
    expect(SLICE_FILES.filter((file) => allowed.includes(file))).toEqual([]);
    expect(REMOVED_FILES.filter((file) => existsSync(join(__dirname, file)))).toEqual([]);
    expect(SLICE_FILES.filter((file) => existsSync(join(__dirname, file)) && QUERIES_MOCK.test(read(file)))).toEqual(
      [],
    );
  });

  it('the account detail, Accounts tab, Rules and date-picker suites draw over the fake server', () => {
    const notOnFakeServer = FAKE_SERVER_SUITES.filter((file) => {
      if (!existsSync(join(__dirname, file))) return true;
      const source = read(file);
      return QUERIES_MOCK.test(source) || !/installFakeServer\(\)/.test(source) || !/renderWithQueries/.test(source);
    });
    expect(notOnFakeServer).toEqual([]);
  });
});
