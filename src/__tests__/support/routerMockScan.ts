// WHIT-753 — the matching behind the shared-router guard (routerMockShared.logic.test.ts): find
// every expo-router mock factory in a file's comment-stripped code, and spot a factory that
// redefines one of the core hooks the shared stand-in owns.
import { readFileSync } from 'fs';
import { join } from 'path';
import { TESTS_DIR, matchingBrace, stripComments } from './sourceScan';

// Built from parts so this file never contains the literals the guard hunts for.
const ROUTER_MOCK_CALL = new RegExp('jest\\.mock\\(\\s*[\'"]expo-' + 'router[\'"]', 'g');
const CORE_HOOK = new RegExp(
  '\\b(useFocus' + 'Effect|use' + 'Router|useLocal' + 'SearchParams|useIs' + 'Focused)\\s*[:(,}=]',
);
export const SHARED_FACTORY = new RegExp("require\\('\\./support/routerMock'\\)\\.routerMock" + 'Module\\(');
export const LOCAL_ROUTER_SPY = new RegExp(
  '^\\s*(const|let|var)\\s+mock' + '(Push|Back|Replace|Params|DismissAll)\\b',
  'm',
);

// A test file's code with comments stripped, so commented-out mocks don't count.
export const codeOf = (file: string, dir: string = TESTS_DIR): string =>
  stripComments(readFileSync(join(dir, file), 'utf8'));

export function routerMockFactories(code: string): string[] {
  return [...code.matchAll(ROUTER_MOCK_CALL)].map((match) => {
    const open = match.index + match[0].indexOf('(');
    return code.slice(open, matchingBrace(code, open, '(', ')') + 1);
  });
}

export const overridesCoreHook = (factory: string): boolean => CORE_HOOK.test(factory);
