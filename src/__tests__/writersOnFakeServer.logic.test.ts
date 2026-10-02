// WHIT-692: the screen suites that tap save or delete draw inside the real AppProvider
// (support/renderWithApp), so the real writers run against the fake server. None may bring back a
// hand-made useAppContext stub or a stubbed writer, toast, sheet or session epoch.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const WRITER_FILES = [
  'RulesScreen.screen.test.tsx',
  'accountsRulesBudgetsFakeServerGaps.screen.test.tsx',
  'categoryEditColdSeed.screen.test.tsx',
  'categoryScreensEdges.screen.test.tsx',
  'categoryFields.screen.test.tsx',
];

const STUBS = [
  /useAppContext:\s*\(\)\s*=>/,
  /\bmock(SaveCategory|CreateInline|DeleteCategory|DeleteRule|ShowToast|SetSheet|Epoch)\b/,
  /\bfns\.(deleteRule|setSheet)\b/,
];

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('Save and delete taps run the real writers', () => {
  it('every listed suite draws through renderWithApp', () => {
    expect(WRITER_FILES.filter((file) => !/renderWithApp\(/.test(read(file)))).toEqual([]);
  });

  it('no listed suite stubs the app context or a writer', () => {
    const stubbed = WRITER_FILES.filter((file) => STUBS.some((stub) => stub.test(read(file))));
    expect(stubbed).toEqual([]);
  });
});
