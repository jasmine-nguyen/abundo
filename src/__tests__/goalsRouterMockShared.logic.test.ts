// WHIT-751 — the Goals and settings-gear screen tests use the shared router stand-in
// (support/routerMock.ts) instead of each hand-writing its own expo-router mock. Fail-on-revert:
// put an inline router mock, or a local push/back/params spy, back into any listed file and this
// goes red, naming the file.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { matchingBrace, stripComments } from './support/sourceScan';

const TESTS_DIR = __dirname;

const CONVERTED_FILES = [
  'goalsHub.screen.test.tsx',
  'goalsHubEdges.screen.test.tsx',
  'goalsHubOverpaid.screen.test.tsx',
  'goalsHubOwing.screen.test.tsx',
  'goalsHubPayoffFloor.screen.test.tsx',
  'goalsHubPureHero.screen.test.tsx',
  'goalsHubReads.qa.screen.test.tsx',
  'settingsGear.screen.test.tsx',
  'settingsGearSelection.screen.test.tsx',
  'goalEdit.screen.test.tsx',
  'goalEditFakeServerEdges.screen.test.tsx',
  'goalErrorStates.a11y.screen.test.tsx',
  'goals.paydown.screen.test.tsx',
  'goalsKit.qa.screen.test.tsx',
  'goalsKit.screen.test.tsx',
  'goalTooAggressive.screen.test.tsx',
];

// Built from parts so this file never contains the literals it hunts for.
const ROUTER_MOCK_CALL = new RegExp("jest\\.mock\\(\\s*'expo-" + "router'");
const LOCAL_ROUTER_SPY = new RegExp(
  '^\\s*(const|let|var)\\s+mock' + '(Push|Back|Replace|Params|DismissAll)\\b',
  'm',
);

function routerMockFactory(source: string): string | null {
  const code = stripComments(source);
  const match = ROUTER_MOCK_CALL.exec(code);
  if (!match) return null;
  const open = match.index + match[0].indexOf('(');
  const close = matchingBrace(code, open, '(', ')');
  return code.slice(open, close + 1);
}

describe('Goals screen tests share one router stand-in', () => {
  it.each(CONVERTED_FILES)('%s mocks expo-router with the shared routerMockModule', (file) => {
    const factory = routerMockFactory(readFileSync(join(TESTS_DIR, file), 'utf8'));
    expect(factory).not.toBeNull();
    expect(factory).toMatch(/require\('\.\/support\/routerMock'\)\.routerMockModule\(/);
  });

  it('no converted file keeps its own push/back/replace/params spy', () => {
    const offenders = CONVERTED_FILES.filter((file) =>
      LOCAL_ROUTER_SPY.test(stripComments(readFileSync(join(TESTS_DIR, file), 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });
});
