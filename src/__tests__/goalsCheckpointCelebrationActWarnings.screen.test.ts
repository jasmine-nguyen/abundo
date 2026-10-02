// WHIT-694 — the Goals checkpoint-celebration screen tests run quietly: all 6 pass and the confetti
// animation prints no "not wrapped in act" warnings. Runs that test file in its own jest process and
// reads what it prints, since the warnings only show up in the console output.
import { describe, it, expect } from '@jest/globals';
import path from 'path';

const { spawnSync } = require('child_process') as typeof import('child_process');

const ROOT = path.resolve(__dirname, '../..');
const CELEBRATION_TESTS = path.join(__dirname, 'goalsCheckpointCelebration.screen.test.tsx');
const ACT_WARNING = ['not wrapped', 'in act'].join(' ');

describe('Goals checkpoint celebration screen tests (WHIT-694)', () => {
  it('pass without printing any act warnings', () => {
    const run = spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules/jest/bin/jest.js'),
        '--selectProjects', 'screen',
        '--runTestsByPath', CELEBRATION_TESTS,
        '--runInBand', '--colors=false',
      ],
      { cwd: ROOT, env: { ...process.env, TZ: 'Australia/Melbourne', CI: 'true' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${run.stdout}\n${run.stderr}`;

    expect(run.status).toBe(0);
    expect(output).toMatch(/Tests:\s+6 passed, 6 total/);
    expect(output.split(ACT_WARNING).length - 1).toBe(0);
  }, 180000);
});
