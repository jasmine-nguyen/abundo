// WHIT-753 QA — the core-hook check (support/routerMockScan.ts overridesCoreHook) promises to
// flag a factory that redefines a core hook "in any form". Assigning onto the shared object slips
// past it today, so a test could bring the no-op focus back and the folder guard stays green:
//   () => { const m = require(...).routerMockModule(); m.useFocusEffect = () => {}; return m; }
import { describe, it, expect } from '@jest/globals';
import { overridesCoreHook, routerMockFactories } from './support/routerMockScan';

// Built from parts so this file never contains the literals the guard hunts for.
const MOCK = "jest.mock('expo-" + "router', ";
const SHARED = "require('./support/routerMock').routerMock" + 'Module()';
const assignMock = (hook: string) => `${MOCK}() => { const m = ${SHARED}; m.${hook} = () => {}; return m; });`;

describe('WHIT-753 QA core-hook override by assignment', () => {
  // [A5]
  it.each([
    'useFocus' + 'Effect',
    'use' + 'Router',
    'useLocal' + 'SearchParams',
    'useIs' + 'Focused',
  ])('flags a factory that assigns %s onto the shared fake', (hook) => {
    const [factory] = routerMockFactories(assignMock(hook));
    expect(overridesCoreHook(factory)).toBe(true);
  });

  // [A6]
  it('still allows assigning an extra the shared fake does not own', () => {
    const [factory] = routerMockFactories(assignMock('useRootNavigationState'));
    expect(overridesCoreHook(factory)).toBe(false);
  });
});
