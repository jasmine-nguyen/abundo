// WHIT-753 slice 2 — once the tab-bar, current-page, notification-tap and settings/rules tests
// switch to the shared router stand-in (support/routerMock.ts), only the sign-in gate and
// app-start tests keep their own expo-router fake, and the folder guard has no temporary skip list.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';
import {
  LOCAL_ROUTER_SPY,
  SHARED_FACTORY,
  codeOf,
  overridesCoreHook,
  routerMockFactories,
} from './support/routerMockScan';

const TESTS_DIR = __dirname;

// Built from parts so this file never contains the literal it hunts for.
const TEMPORARY_SKIP_LIST = 'NOT_YET_' + 'CONVERTED';

const keepsOwnRouterFake = (file: string): boolean => {
  const code = codeOf(TESTS_DIR, file);
  const factories = routerMockFactories(code);
  if (factories.length === 0) return false;
  if (factories.some((factory) => !SHARED_FACTORY.test(factory))) return true;
  if (factories.some(overridesCoreHook)) return true;
  return LOCAL_ROUTER_SPY.test(code);
};

describe('only the sign-in gate and app-start tests keep their own router fake', () => {
  it('every other test file uses the shared router stand-in, with no local spies', () => {
    const ownFakes = testFiles(TESTS_DIR)
      .filter((file) => file !== 'support/routerMock.ts')
      .filter(keepsOwnRouterFake)
      .sort();

    expect(ownFakes).toEqual(['authGate.screen.test.tsx', 'rootLayout.launch.screen.test.tsx']);
  });

  it('the folder guard no longer skips any file', () => {
    const guard = readFileSync(join(TESTS_DIR, 'routerMockShared.logic.test.ts'), 'utf8');
    expect(guard.includes(TEMPORARY_SKIP_LIST)).toBe(false);
  });
});
