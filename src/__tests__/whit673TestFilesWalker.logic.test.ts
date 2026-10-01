// WHIT-673 QA: the shared test-tree walker the noAutoMockApi and noQueriesMock guards scan with.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'whit673-walker-'));
  mkdirSync(join(root, 'support', 'deep'), { recursive: true });
  writeFileSync(join(root, 'a.screen.test.tsx'), '');
  writeFileSync(join(root, 'b.logic.test.ts'), '');
  writeFileSync(join(root, 'notes.md'), '');
  writeFileSync(join(root, 'snap.tsx.snap'), '');
  writeFileSync(join(root, 'support', 'helper.ts'), '');
  writeFileSync(join(root, 'support', 'deep', 'nested.tsx'), '');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('testFiles walker (WHIT-673)', () => {
  // [A1] recurses into sub-folders, keeps only .ts/.tsx, keys are forward-slashed and root-relative
  it('lists every .ts/.tsx file under the root, including sub-folders, and nothing else', () => {
    expect([...testFiles(root)].sort()).toEqual([
      'a.screen.test.tsx',
      'b.logic.test.ts',
      'support/deep/nested.tsx',
      'support/helper.ts',
    ]);
  });

  // [A2] a sub-folder walk still keys against the root, never `../x` (critic tweak)
  it('keys a sub-folder walk against the root, not the sub-folder', () => {
    expect([...testFiles(root, join(root, 'support'))].sort()).toEqual(['support/deep/nested.tsx', 'support/helper.ts']);
  });

  // [A3] the real guards see the real tree: the deleted layout-only suites are gone from the scan,
  // and a known allow-listed file is present under the exact key ALLOWED uses
  it('the real test tree scan uses the same keys the allow-list uses', () => {
    const files = testFiles(join(__dirname));
    expect(files).toContain('goalsHub.screen.test.tsx');
    expect(files).toContain('support/transactionsScreenData.ts');
    expect(files).not.toContain('motionScroll.screen.test.tsx');
  });
});
