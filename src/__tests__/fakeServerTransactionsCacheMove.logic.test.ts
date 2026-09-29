// WHIT-650 slice 2: the transaction edit, uncategorised count, search and saved-copy suites
// run the real request code (src/api.ts) against the fake server, instead of the bare
// `jest.mock('../api')` auto-mock, and keep at least as many checks as before the move.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

// `expect(` count per file before the move (af8ae1a).
const MOVED_SUITES: Record<string, number> = {
  'transactionCache.provider.screen.test.tsx': 13,
  'transactionCacheQa.provider.screen.test.tsx': 53,
  'transactionEdit.provider.screen.test.tsx': 22,
  'transactionsCategorize.provider.screen.test.tsx': 87,
  'transactionsSearchCache.provider.screen.test.tsx': 9,
  'uncategorizedCountInvalidation.provider.screen.test.tsx': 4,
  'uncategorizedCountInvalidationAll.provider.screen.test.tsx': 2,
  'uncategorizedCountRulesGuard.provider.screen.test.tsx': 5,
  'uncategorizedFeedEditPaths.provider.screen.test.tsx': 3,
  'uncategorizedFeedResolveAndPatch.provider.screen.test.tsx': 6,
  'storeReaderWrites.provider.screen.test.tsx': 25,
  'teardownColdCache.provider.screen.test.tsx': 21,
};

const API_AUTO_MOCK = /jest\.mock\(\s*['"]\.\.\/api['"]\s*\)/;
const API_NAMESPACE_IMPORT = /import\s+\*\s+as\s+\w+\s+from\s+['"]\.\.\/api['"]/;

function source(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

describe('transaction edit, uncategorised count, search and saved-copy suites run on the fake server', () => {
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
});
