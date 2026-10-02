// WHIT-698 QA: findOffenders reports every matching line in a file, not just the first.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findOffenders } from './support/sourceScan';

let root: string;
const hit = (line: string) => line.includes('HIT');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'whit698-qa-'));
  writeFileSync(join(root, 'many.test.tsx'), 'HIT\nclean\nHIT again\nclean\nlast HIT');
  writeFileSync(join(root, 'clean.test.ts'), 'clean\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findOffenders — QA (WHIT-698)', () => {
  // [A1] several matches in one file, last line with no trailing newline
  it('lists every matching line in a file in line order, including an unterminated last line', () => {
    expect(findOffenders(hit, new Set(), root)).toEqual(['many.test.tsx:1', 'many.test.tsx:3', 'many.test.tsx:5']);
  });

  // [A2] nothing matches → empty list, so a clean tree passes the guards
  it('returns an empty list when no line matches', () => {
    expect(findOffenders(() => false, new Set(), root)).toEqual([]);
  });
});
