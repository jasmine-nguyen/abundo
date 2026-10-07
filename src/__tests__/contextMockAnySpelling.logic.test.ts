// WHIT-801 — no test file hand-builds its ../context stand-in, under any spelling. Every
// jest.mock / jest.doMock of ../context must either automock (no factory) or delegate to a
// shared builder under ./support/ (support/contextMock realContextWith / emptyContextMockModule,
// or a suite builder that wraps it).
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripComments, testFiles } from './support/sourceScan';

const CONTEXT_MOCK = /jest\.(?:do)?[mM]ock\(\s*['"](?:\.\.\/)+context['"]/g;
const AUTOMOCK = /^\s*\)/;
const SHARED_FACTORY = /^\s*,\s*\(\)\s*=>\s*\(?\s*require\(\s*['"]\.\/support\//;

const handBuiltContextMocks = (source: string): number => {
  const code = stripComments(source);
  return [...code.matchAll(CONTEXT_MOCK)].filter((match) => {
    const rest = code.slice(match.index + match[0].length);
    return !AUTOMOCK.test(rest) && !SHARED_FACTORY.test(rest);
  }).length;
};

const ALLOWED = new Set([
  // Swaps AppProvider for a passthrough so launch doesn't fetch; it doesn't fake useAppContext.
  'rootLayout.launch.screen.test.tsx',
  // Its self-test samples are string literals the scan would read as real mocks.
  'contextMockAnySpelling.logic.test.ts',
]);

describe('every test takes its context stand-in from the shared builder', () => {
  it('no test file hand-builds the ../context fake', () => {
    const offenders = testFiles(__dirname)
      .filter((file) => !file.startsWith('support/') && !ALLOWED.has(file))
      .filter((file) => handBuiltContextMocks(readFileSync(join(__dirname, file), 'utf8')) > 0);
    expect(offenders).toEqual([]);
  });

  it('flags every hand-built spelling and lets shared or commented ones through', () => {
    // Built from pieces so the older WHIT-777 guard's exact-text scan doesn't read this file.
    const empty = ['()', '=>', '({})'].join(' ');
    const handBuilt = [
      `jest.mock('../context', () => ({ useAppContext: ${empty} }));`,
      "jest.mock('../context', () => ({ useAppContext: jest.fn(() => ({})) }));",
      "jest.mock('../context', () => ({ useAppContext: () => ({} as AppContext) }));",
      "jest.mock('../context', () => ({\n  ...(jest.requireActual('../context') as object),\n  useAppContext: () => mockState,\n}));",
      "jest.mock('../context', () => {\n  const actual = jest.requireActual('../context') as typeof import('../context');\n  return { ...actual, useAppContext: () => mockState };\n});",
      "jest.mock('../context', () => ({ useAppContext: mockUseAppContext }));",
      `jest.doMock('../context', () => ({ useAppContext: ${empty} }));`,
      "jest.mock('../context', function () { return {}; });",
    ];
    const shared = [
      "jest.mock('../context', () => require('./support/contextMock').emptyContextMockModule());",
      "jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ showToast: mockShowToast })));",
      "jest.mock('../context', () =>\n  require('./support/contextMock').realContextWith(() => mockState),\n);",
      "jest.mock('../context');",
      "// jest.mock('../context', () => ({}))",
      `/* jest.mock('../context', () => ({ useAppContext: ${empty} })) */`,
    ];
    expect(handBuilt.filter((source) => handBuiltContextMocks(source) !== 1)).toEqual([]);
    expect(shared.filter((source) => handBuiltContextMocks(source) !== 0)).toEqual([]);
  });
});
