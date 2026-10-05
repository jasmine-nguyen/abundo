// WHIT-740 — AGENTS.md points agents at the simulator-check skill, word for word as the build
// tool's AGENTS-template.md does, straight after the checks block (and outside its fence).
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from './support/sourceScan';

const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');

const POINTER = [
  'iOS app? Agents check screens in the Simulator with the `simulator-check` skill',
  '(`.claude/skills/simulator-check/`, needs AXe: `brew install cameroncooke/axe/axe`).',
  "The build's QA only drives the Simulator when Metro is running from the build's",
  'own checkout; otherwise screen checks stay manual.',
].join('\n');

const CHECKS_BLOCK = [
  '```checks',
  'npm run typecheck',
  'npm test',
  '.venv/bin/python -m pytest -q',
  '```',
].join('\n');

describe('AGENTS.md points agents at the simulator-check skill', () => {
  it('has the pointer paragraph straight after the checks block, before Known landmines', () => {
    expect(agents).toContain(`${CHECKS_BLOCK}\n\n${POINTER}\n\n## Known landmines`);
  });

  it('matches the paragraph in the build tool template', () => {
    const template = readFileSync(join(ROOT, 'AGENTS-template.md'), 'utf8');
    expect(template).toContain(POINTER);
    expect(agents.split(POINTER)).toHaveLength(2);
  });
});
