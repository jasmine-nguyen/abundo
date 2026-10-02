// WHIT-698 QA: the shared offender scan the shared-wait guards hand their line rule to.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findOffenders } from './support/sourceScan';

let root: string;
const hit = (line: string) => line.includes('HIT');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'whit698-offenders-'));
  mkdirSync(join(root, 'support', 'deep'), { recursive: true });
  writeFileSync(join(root, 'a.test.ts'), 'clean\nHIT\nclean\n');
  writeFileSync(join(root, 'support', 'deep', 'b.tsx'), 'HIT here\nclean\n');
  writeFileSync(join(root, 'skip.test.ts'), 'HIT\n');
  writeFileSync(join(root, 'notes.md'), 'HIT\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findOffenders (WHIT-698)', () => {
  it('lists every matching line as file:line, recursing, 1-based, .ts/.tsx only, skipping allow-listed files', () => {
    expect([...findOffenders(hit, new Set(['skip.test.ts']), root)].sort()).toEqual([
      'a.test.ts:2',
      'support/deep/b.tsx:1',
    ]);
  });

  it('allow-list keys are root-relative and forward-slashed', () => {
    expect([...findOffenders(hit, new Set(['skip.test.ts', 'support/deep/b.tsx']), root)].sort()).toEqual([
      'a.test.ts:2',
    ]);
  });

  it('scans the real test tree by default, keyed the same way', () => {
    const offenders = findOffenders((line) => line.startsWith('// WHIT-698 QA:'), new Set());
    expect(offenders).toContain('findOffenders.logic.test.ts:1');
  });
});
