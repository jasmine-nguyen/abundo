// WHIT-740 QA — the skill folder AGENTS.md names must really hold the skill, so the pointer
// never dangles if the synced skill moves.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from './support/sourceScan';

const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');

describe('AGENTS.md simulator-check pointer', () => {
  // [A1]
  it('names a skill folder that holds SKILL.md', () => {
    const skillDirs = [...agents.matchAll(/`(\.claude\/skills\/[^`]+?)\/?`/g)].map((m) => m[1]);
    expect(skillDirs).toContain('.claude/skills/simulator-check');
    for (const dir of skillDirs) {
      expect(existsSync(join(ROOT, dir, 'SKILL.md'))).toBe(true);
    }
  });
});
