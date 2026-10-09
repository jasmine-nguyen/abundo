// WHIT-839 — jest.setup.js already gives every screen test a zero-inset safe area. A test that needs
// other insets (a notch) builds its fake from the shared safeAreaMockModule() helper. Fail-on-revert:
// put an inline safe-area mock back into any test file and this goes red, naming the file.
import { describe, it, expect } from '@jest/globals';
import { TESTS_DIR, testFiles } from './support/sourceScan';
import { codeOf } from './support/routerMockScan';

// Built from parts so this file never contains the literals the guard hunts for.
const MOCK_CALL = new RegExp('jest\\.mock\\(\\s*[\'"]react-native-safe-' + 'area-context[\'"]', 'g');
const SHARED_CALL = new RegExp(
  MOCK_CALL.source + "\\s*,\\s*\\(\\)\\s*=>\\s*require\\('\\./support/safeArea" + "Mock'\\)\\.safeAreaMockModule\\(",
  'g',
);

const count = (code: string, pattern: RegExp): number => [...code.matchAll(pattern)].length;

const mockingFiles = testFiles(TESTS_DIR).filter((file) => count(codeOf(file), MOCK_CALL) > 0);

describe('safe-area fakes share one stand-in', () => {
  it('the scan finds the notch tests that fake the safe area through the shared helper', () => {
    expect(mockingFiles.length).toBeGreaterThanOrEqual(3);
    expect(mockingFiles.filter((file) => count(codeOf(file), SHARED_CALL) > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('no test file writes its own safe-area fake', () => {
    const offenders = mockingFiles.filter((file) => count(codeOf(file), SHARED_CALL) !== count(codeOf(file), MOCK_CALL));
    expect(offenders).toEqual([]);
  });
});
