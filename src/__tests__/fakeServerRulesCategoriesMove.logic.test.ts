// WHIT-650 slice 1: the rules, categories and batch-saving suites run the real request code
// (src/api.ts) against the fake server, instead of the bare `jest.mock('../api')` auto-mock,
// and keep at least as many checks as before the move.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

// `expect(` count per file before the move (main @ f549f5b).
const MOVED_SUITES: Record<string, number> = {
  'rulesWrite.provider.screen.test.tsx': 26,
  'rulesWriteIdSwap.provider.screen.test.tsx': 2,
  'ruleWriters.provider.screen.test.tsx': 13,
  'ruleWriterRecursionGuard.provider.screen.test.tsx': 12,
  'ruleSpreadErrorsGaps.provider.screen.test.tsx': 8,
  'deleteCategoryOptimistic.provider.screen.test.tsx': 24,
  'deleteCategoryOptimisticQa.provider.screen.test.tsx': 43,
  'deleteReinsertEdges.provider.screen.test.tsx': 12,
  'persistCategoryBatch.logic.test.ts': 16,
  'persistCategoryBatch.provider.screen.test.tsx': 15,
  'categoryDrillInvalidation.provider.screen.test.tsx': 3,
};

const API_AUTO_MOCK = /jest\.mock\(\s*['"]\.\.\/api['"]\s*\)/;
const API_NAMESPACE_IMPORT = /import\s+\*\s+as\s+\w+\s+from\s+['"]\.\.\/api['"]/;

function source(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

describe('rules, categories and batch-saving suites run on the fake server', () => {
  it.each(Object.keys(MOVED_SUITES))('%s uses the fake server, not the api auto-mock', (file) => {
    const src = source(file);

    expect({
      autoMocksApi: API_AUTO_MOCK.test(src),
      importsApiNamespace: API_NAMESPACE_IMPORT.test(src),
      usesMockApi: /\bmockApi\b/.test(src),
      installsFakeServer: /installFakeServer\(\)/.test(src),
    }).toEqual({ autoMocksApi: false, importsApiNamespace: false, usesMockApi: false, installsFakeServer: true });
  });

  it.each(Object.entries(MOVED_SUITES))('%s keeps at least %i checks', (file, before) => {
    const after = source(file).split('expect(').length - 1;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('the patterns catch the auto-mock they are meant to catch', () => {
    expect(`jest.mock('../api');`).toMatch(API_AUTO_MOCK);
    expect(`import * as api from '../api';`).toMatch(API_NAMESPACE_IMPORT);
    expect(`jest.mock('../api', () => ({ fetchX: jest.fn() }));`).not.toMatch(API_AUTO_MOCK);
  });
});
