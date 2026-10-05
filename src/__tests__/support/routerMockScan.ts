// WHIT-753 — the matching behind the shared-router guard (routerMockShared.logic.test.ts): find
// every expo-router mock factory in a file's comment-stripped code, and spot a factory that
// redefines one of the core hooks the shared stand-in owns.
import { matchingBrace } from './sourceScan';

// Built from parts so this file never contains the literals the guard hunts for.
const ROUTER_MOCK_CALL = new RegExp('jest\\.mock\\(\\s*[\'"]expo-' + 'router[\'"]', 'g');
const CORE_HOOK = new RegExp(
  '\\b(useFocus' + 'Effect|use' + 'Router|useLocal' + 'SearchParams|useIs' + 'Focused)\\s*[:(,}]',
);

export function routerMockFactories(code: string): string[] {
  return [...code.matchAll(ROUTER_MOCK_CALL)].map((match) => {
    const open = match.index + match[0].indexOf('(');
    return code.slice(open, matchingBrace(code, open, '(', ')') + 1);
  });
}

export const overridesCoreHook = (factory: string): boolean => CORE_HOOK.test(factory);
