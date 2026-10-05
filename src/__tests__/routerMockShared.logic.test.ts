// WHIT-753 — every test under src/__tests__ that fakes expo-router uses the shared stand-in
// (support/routerMock.ts). Fail-on-revert: put an inline router mock, a core-hook override, or a
// local push/back/replace/params spy back into any non-allow-listed file and this goes red,
// naming the file.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { matchingBrace, stripComments, testFiles } from './support/sourceScan';

const TESTS_DIR = __dirname;

// The auth-gate/redirect variants: they need Redirect / useSegments / useRootNavigationState.
const ALLOWED_INLINE = new Set([
  'authGate.screen.test.tsx',
  'rootLayout.launch.screen.test.tsx',
]);

// Slice 2 of WHIT-753 converts these; emptied and deleted then.
const NOT_YET_CONVERTED = new Set([
  'askButton.screen.test.tsx',
  'askButtonRound.screen.test.tsx',
  'askButtonRoundFill.screen.test.tsx',
  'tabBarDot.screen.test.tsx',
  'tabBarDot.edges.screen.test.tsx',
  'whit717TabBarPressed.qa.screen.test.tsx',
  'uncategorizedCountWiring.screen.test.tsx',
  'whit686UncategorizedCountFailed.screen.test.tsx',
  'tabsDetachInactiveScreens.screen.test.tsx',
  'tabsScreenOrder.screen.test.tsx',
  'tabsAnimation.screen.test.tsx',
  'navBarsContext.screen.test.tsx',
  'notificationRouter.screen.test.tsx',
  'RulesScreen.screen.test.tsx',
  'settingsScreen.screen.test.tsx',
]);

// Built from parts so this file never contains the literals it hunts for.
const ROUTER_MOCK_CALL = new RegExp('jest\\.mock\\(\\s*[\'"]expo-' + 'router[\'"]');
const SHARED_FACTORY = new RegExp("require\\('\\./support/routerMock'\\)\\.routerMock" + 'Module\\(');
const CORE_KEY_OVERRIDE = new RegExp(
  '\\b(useFocus' + 'Effect|use' + 'Router|useLocal' + 'SearchParams|useIs' + 'Focused)\\s*:',
);
const LOCAL_ROUTER_SPY = new RegExp(
  '^\\s*(const|let|var)\\s+mock' + '(Push|Back|Replace|Params|DismissAll)\\b',
  'm',
);

function routerMockFactory(code: string): string | null {
  const match = ROUTER_MOCK_CALL.exec(code);
  if (!match) return null;
  const open = match.index + match[0].indexOf('(');
  const close = matchingBrace(code, open, '(', ')');
  return code.slice(open, close + 1);
}

const codeOf = (file: string): string => stripComments(readFileSync(join(TESTS_DIR, file), 'utf8'));

const mockingFiles = testFiles(TESTS_DIR)
  .filter((file) => file !== 'support/routerMock.ts')
  .filter((file) => routerMockFactory(codeOf(file)) !== null);

const mustShare = mockingFiles.filter((file) => !ALLOWED_INLINE.has(file) && !NOT_YET_CONVERTED.has(file));

describe('every screen test shares one router stand-in', () => {
  it('the scan finds the test files that fake expo-router', () => {
    expect(mockingFiles.length).toBeGreaterThan(50);
  });

  it('every file that fakes expo-router builds its fake from routerMockModule()', () => {
    const offenders = mustShare.filter((file) => !SHARED_FACTORY.test(routerMockFactory(codeOf(file)) ?? ''));
    expect(offenders).toEqual([]);
  });

  it('no shared fake overrides the core hooks (useFocusEffect, useRouter, params, focus)', () => {
    const offenders = mustShare.filter((file) => CORE_KEY_OVERRIDE.test(routerMockFactory(codeOf(file)) ?? ''));
    expect(offenders).toEqual([]);
  });

  it('no file that fakes expo-router keeps its own push/back/replace/params spy', () => {
    const offenders = mustShare.filter((file) => LOCAL_ROUTER_SPY.test(codeOf(file)));
    expect(offenders).toEqual([]);
  });

  it('each allow-listed file still exists and still fakes expo-router inline', () => {
    const stale = [...ALLOWED_INLINE].filter((file) => !mockingFiles.includes(file));
    expect(stale).toEqual([]);
  });
});
