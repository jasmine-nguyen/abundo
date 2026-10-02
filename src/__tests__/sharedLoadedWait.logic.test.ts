// WHIT-697 — the "wait until one query has loaded" step lives once, as loaded() in
// support/renderWithQueries; no suite keeps a written-out copy of it.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const testsDir = path.join(__dirname);
const allowed = new Set([path.join('support', 'renderWithQueries.tsx'), path.basename(__filename)]);

const needles = [
  ['wait', 'For('].join(''),
  ['queryClient', '.getQueryState('].join(''),
  [".toBe('success'", ')'].join(''),
];

function findOffenders(): string[] {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const relative = path.relative(testsDir, full);
      if (allowed.has(relative)) continue;
      fs.readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (needles.every((needle) => line.includes(needle))) offenders.push(`${relative}:${index + 1}`);
        });
    }
  };
  walk(testsDir);
  return offenders;
}

describe('shared "one query has loaded" wait', () => {
  it('no suite keeps its own written-out copy of the wait — they all use loaded()', () => {
    expect(findOffenders()).toEqual([]);
  });
});
