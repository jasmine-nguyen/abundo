// WHIT-415 / WHIT-406 — the ONE place a Jest run learns what the server actually seeds.
//
// Why this file exists: the chart palette is resolved from a `colorSlot` the SERVER hands out
// (shared/repository_category.py SEED_CATEGORIES), but every client test so far mirrored that
// table by HAND. Nothing tied the two together, so when WHIT-415 moved coffee 4->9 and utilities
// 10->2, the client suites stayed green against stale copies. Jest's `logic` project runs on a
// plain node env, so it can just READ the .py — no mirror, no drift.
//
// Deliberately NOT named *.logic.test.ts: jest.config.js testMatch only collects test files, so
// this is a fixture (same role as factory.ts), importable from both projects.
import fs from 'fs';
import path from 'path';

const SEED_SOURCE = path.resolve(__dirname, '../../shared/repository_category.py');

/** The raw text of the server module, so a test can assert on it directly if it needs to. */
export const SEED_SOURCE_TEXT = fs.readFileSync(SEED_SOURCE, 'utf8');

function seedBlock(src: string): string {
  const start = src.indexOf('SEED_CATEGORIES = {');
  if (start === -1) throw new Error(`SEED_CATEGORIES not found in ${SEED_SOURCE}`);
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`SEED_CATEGORIES block never closes in ${SEED_SOURCE}`);
  return src.slice(start, end);
}

/**
 * {category id -> the colorSlot the server seeds it with}, parsed out of the Python.
 * Throws rather than returning a partial map: a silently-empty result would make every
 * assertion built on it vacuous, which is the exact failure mode this file exists to stop.
 */
export function readServerSeedSlots(): Record<string, number> {
  const slots: Record<string, number> = {};
  const row = /^\s*"([a-z]+)":\s*\{[^}]*"colorSlot":\s*(-?\d+)\s*\}/gm;
  for (const [, id, slot] of seedBlock(SEED_SOURCE_TEXT).matchAll(row)) {
    slots[id] = Number(slot);
  }
  if (Object.keys(slots).length === 0) {
    throw new Error(`parsed 0 seed slots from ${SEED_SOURCE} — the seed format changed`);
  }
  return slots;
}

/** The server's `_COLOR_SLOT_COUNT` — how many slots it will ever hand out. */
export function readServerSlotCount(): number {
  const match = /^_COLOR_SLOT_COUNT = (\d+)$/m.exec(SEED_SOURCE_TEXT);
  if (!match) throw new Error(`_COLOR_SLOT_COUNT not found in ${SEED_SOURCE}`);
  return Number(match[1]);
}

/** Ids sitting on NEIGHBOURING ramp entries, grouped, warm end first. Runs of 1 are dropped. */
export function neighbouringRuns(ramp: Record<string, number>): string[][] {
  type Entry = [id: string, position: number];
  const ordered: Entry[] = Object.entries(ramp).sort((a, b) => a[1] - b[1]);
  const runs: Entry[][] = [];
  let current: Entry[] = [ordered[0]];
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i][1] === ordered[i - 1][1] + 1) current.push(ordered[i]);
    else { runs.push(current); current = [ordered[i]]; }
  }
  runs.push(current);
  return runs.filter((run) => run.length > 1).map((run) => run.map(([id]) => id));
}
