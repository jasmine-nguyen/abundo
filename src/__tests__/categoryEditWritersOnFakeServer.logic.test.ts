// WHIT-692 slice 2: the big category edit suite draws app/category/edit inside the real AppProvider
// (support/renderWithApp), so the real create, update and delete writers run against the fake
// server. Failures and sign-out mid-save are staged on the server, and each test reads the requests
// sent and the toast the user sees — never a hand-made context, writer, toast or session stub.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripComments } from './support/sourceScan';

const SUITE = 'categoryEditSummaryToast.screen.test.tsx';
const code = stripComments(readFileSync(join(__dirname, SUITE), 'utf8'));

const STUBS = [
  /jest\.mock\(\s*['"](\.\.\/)+(src\/)?context['"]/,
  /useAppContext:\s*\(\)\s*=>/,
  /\bmock(SaveCategory|CreateInline|DeleteCategory|ShowToast|SetSheet|Epoch)\b/,
];

describe('Category edit suite runs the real save and delete code', () => {
  it('draws the screen inside the real app and stubs no writer, toast or session', () => {
    expect(/renderWithApp\(/.test(code)).toBe(true);
    expect(STUBS.filter((stub) => stub.test(code)).map(String)).toEqual([]);
  });

  it('stages failures on the server and checks the requests sent and the toast shown', () => {
    const needed = [
      /server\.sent\(\s*['"]PATCH['"]\s*,\s*['"]\/categories\//,
      /server\.sent\(\s*['"]POST['"]\s*,\s*['"]\/categories['"]/,
      /server\.sent\(\s*['"]DELETE['"]\s*,\s*['"]\/categories\//,
      /server\.once\(/,
      /server\.hold\(/,
      /setAuthStatus\(\s*['"]anon['"]\s*\)/,
      /shownToasts\(\)/,
      /resetAppProbe\(\)/,
    ];
    expect(needed.filter((pattern) => !pattern.test(code)).map(String)).toEqual([]);
  });
});
