// WHIT-753 QA — holes in the whole-folder router guard (routerMockShared.logic.test.ts). Its
// matching reads only the FIRST expo-router mock in a file and only `key:` overrides, so these
// slip past it today:
//   - a second, inline mock below the shared one. Jest keeps the later factory, so the screen runs
//     on the inline copy (e.g. a no-op useFocusEffect) while the guard stays green;
//   - a core hook overridden with method shorthand, `{ ...routerMockModule(), useFocusEffect() {} }`.
// The fix moves the guard's matching into support/routerMockScan.ts so it can be tested here:
//   routerMockFactories(code) → every expo-router mock factory in the (comment-stripped) code;
//   overridesCoreHook(factory) → true if the factory redefines useFocusEffect / useRouter /
//   useLocalSearchParams / useIsFocused in any form (key, method, shorthand or assignment).
import { describe, it, expect } from '@jest/globals';
import { overridesCoreHook, routerMockFactories } from './support/routerMockScan';

// Built from parts so this file never contains the literals the guard hunts for.
const MOCK = "jest.mock('expo-" + "router', ";
const SHARED = "require('./support/routerMock').routerMock" + 'Module()';
const sharedMock = `${MOCK}() => ${SHARED});`;
const spreadMock = (extra: string) => `${MOCK}() => ({ ...${SHARED}, ${extra} }));`;
const assignMock = (hook: string) => `${MOCK}() => { const m = ${SHARED}; m.${hook} = () => {}; return m; });`;
const inlineNoOpFocus = `${MOCK}() => ({ useFocus` + 'Effect: () => {} }));';

describe('WHIT-753 QA router guard matching', () => {
  // [A8]
  it('finds every expo-router mock in a file, not just the first', () => {
    const code = [sharedMock, "jest.mock('../auth', () => ({}));", inlineNoOpFocus].join('\n');
    const factories = routerMockFactories(code);
    expect(factories).toHaveLength(2);
    expect(factories[1]).toContain('useFocus' + 'Effect');
  });

  // [A9]
  it('finds a mock written with double quotes', () => {
    expect(routerMockFactories(sharedMock.replace(/'expo-router'/, '"expo-router"'))).toHaveLength(1);
  });

  // [A10]
  it('finds nothing in a file that does not mock expo-router', () => {
    expect(routerMockFactories("jest.mock('../auth', () => ({}));")).toEqual([]);
  });

  // [A11]
  it('flags a core hook overridden with key, method or shorthand syntax', () => {
    expect(overridesCoreHook(spreadMock('useFocus' + 'Effect: () => {}'))).toBe(true);
    expect(overridesCoreHook(spreadMock('useFocus' + 'Effect() {}'))).toBe(true);
    expect(overridesCoreHook(spreadMock('use' + 'Router'))).toBe(true);
    expect(overridesCoreHook(spreadMock('useIs' + 'Focused: () => false'))).toBe(true);
    expect(overridesCoreHook(spreadMock('useLocal' + 'SearchParams() { return {}; }'))).toBe(true);
  });

  // [A12]
  it('allows the shared form and the extras the spread may add', () => {
    expect(overridesCoreHook(sharedMock)).toBe(false);
    expect(overridesCoreHook(spreadMock('Tabs'))).toBe(false);
    expect(overridesCoreHook(spreadMock('useRootNavigationState: () => mockNavState'))).toBe(false);
  });

  // [A13]
  it.each(['useFocus' + 'Effect', 'use' + 'Router', 'useLocal' + 'SearchParams', 'useIs' + 'Focused'])(
    'flags a factory that assigns %s onto the shared fake',
    (hook) => {
      const [factory] = routerMockFactories(assignMock(hook));
      expect(overridesCoreHook(factory)).toBe(true);
    },
  );

  // [A14]
  it('still allows assigning an extra the shared fake does not own', () => {
    const [factory] = routerMockFactories(assignMock('useRootNavigationState'));
    expect(overridesCoreHook(factory)).toBe(false);
  });
});
