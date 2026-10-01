// WHIT-670 slice 3 — the 5 category picker and confirm pop-up suites draw <Overlays/> over the fake
// server and load the tapped charge and the categories through the real screen data code
// (src/queries.ts), instead of the hand-written screenQueryMocks shapes. The filing writers
// (chooseCategory, applyCategory, createCategoryInline, fileCharges…) stay on the context mock.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

// Minimum expect( counts live in the noAutoMockApi baselines.
const PICKER_CONFIRM_SUITES = [
  'pickerSheetTree.screen.test.tsx',
  'multiSelectSheet.screen.test.tsx',
  'incomeCategory.screen.test.tsx',
  'confirmSheetMountStability.screen.test.tsx',
  'confirmSheetRefile.screen.test.tsx',
];

// These open the pop-up on one tapped charge, so the charge must come from the fake server.
const TAPPED_CHARGE_SUITES = [
  'pickerSheetTree.screen.test.tsx',
  'incomeCategory.screen.test.tsx',
  'confirmSheetRefile.screen.test.tsx',
];

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;
const AUTH_MOCK = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)\s*\)/;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('picker and confirm pop-up suites run on the fake server', () => {
  it('all 5 picker/confirm suites load categories from the fake server through the real query hooks', () => {
    const problems = PICKER_CONFIRM_SUITES.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: mocks ../queries`);
      if (text.includes('screenQueryMocks')) found.push(`${file}: uses screenQueryMocks`);
      if (!/installFakeServer\(\)/.test(text)) found.push(`${file}: no installFakeServer()`);
      if (!/useTestQueryClient\(\)/.test(text)) found.push(`${file}: no useTestQueryClient()`);
      if (!/from ['"]\.\/support\/renderWithQueries['"]/.test(text)) found.push(`${file}: does not draw through renderWithQueries`);
      if (!AUTH_MOCK.test(text)) found.push(`${file}: does not mock ../auth via authMock`);
      if (!/resetAuth\(\)/.test(text)) found.push(`${file}: no resetAuth()`);
      if (!/server\.seed\(\s*['"]\/categories['"]/.test(text)) found.push(`${file}: never seeds /categories`);
      return found;
    });

    expect(problems).toEqual([]);
  });

  it('the picker and confirm suites that tap one charge load it from the fake server (recent list and feed)', () => {
    const problems = TAPPED_CHARGE_SUITES.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (!/['"]\/transactions['"]/.test(text)) found.push(`${file}: never seeds /transactions`);
      if (!/['"]\/transactions\/feed['"]/.test(text)) found.push(`${file}: never seeds /transactions/feed`);
      return found;
    });

    expect(problems).toEqual([]);
  });

  it('the picker tree expects the id-based colour the real category mapper gives, not a colour the server sent', () => {
    const tree = source('pickerSheetTree.screen.test.tsx');

    expect(tree).not.toContain("'#12ab34'");
    expect(tree).toMatch(/borderLeftColor\)\.toBe\(colorForCategory\(['"]dining['"]\)\)/);
  });

  it('all 5 are listed in the fake-server baselines', () => {
    const baselines = source('noAutoMockApi.logic.test.ts');

    expect(PICKER_CONFIRM_SUITES.filter((file) => !baselines.includes(`'${file}':`))).toEqual([]);
  });

  it('the shared guard lists the 5 picker/confirm pop-up suites', () => {
    const guard = source('whit641WholeAppSuitesRealQueries.logic.test.ts');
    const popupList = guard.match(/const POPUP_SUITES = \[([\s\S]*?)\];/);

    expect(popupList).not.toBeNull();
    const listed = [...(popupList?.[1] ?? '').matchAll(/'([^']+\.test\.tsx)'/g)].map((m) => m[1]);
    expect(PICKER_CONFIRM_SUITES.filter((file) => !listed.includes(file))).toEqual([]);
  });
});
