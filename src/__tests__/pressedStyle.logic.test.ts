// WHIT-717 — one shared pressed (dim + shrink) style. The PRESSED token in src/theme.ts must sit
// inside DESIGN.md's Buttons → Pressed range, and no shipped file may define its own pressed
// opacity style again (they drifted to seven different values before).
import { it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { PRESSED } from '../theme';
import { shippedSourceFiles, repoPath, stripComments } from './support/sourceScan';

it('the shared pressed style dims and shrinks within the DESIGN.md range', () => {
  expect(PRESSED).toBeDefined();
  const { opacity, transform } = PRESSED as { opacity: number; transform: { scale?: number }[] };
  expect(opacity).toBeGreaterThanOrEqual(0.6);
  expect(opacity).toBeLessThanOrEqual(0.85);
  const scale = transform.find((step) => step.scale !== undefined)?.scale;
  expect(scale).toBeGreaterThanOrEqual(0.92);
  expect(scale).toBeLessThanOrEqual(0.96);
});

it('no screen or component defines its own pressed opacity style', () => {
  const localPressed = /[Pp]ressed\s*:\s*\{\s*opacity/;
  const offenders = shippedSourceFiles()
    .filter((abs) => localPressed.test(stripComments(readFileSync(abs, 'utf8'))))
    .map(repoPath);
  expect(offenders).toEqual([]);
});
