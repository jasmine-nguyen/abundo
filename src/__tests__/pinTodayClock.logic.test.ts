// WHIT-693 — one shared "pin today, keep real timers" helper for screen tests.
//
// - pinToday(now) from support/clock freezes today's date, but timers stay real, so the fake
//   server's replies and waitFor still settle.
// - The keep-these-timers-real list lives only in support/clock.ts, so copies can't drift.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { pinToday } from './support/clock';

const SRC_DIR = path.join(__dirname, '..');
const THIS_FILE = path.basename(__filename);
// Built from pieces so this file never matches its own search.
const TIMER_LIST_OPTION = 'doNot' + 'Fake';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (entry.name === THIS_FILE) return [];
    return [full];
  });
}

afterEach(() => {
  jest.useRealTimers();
});

describe('pinToday', () => {
  it('pins today to the given date while real timers still fire', async () => {
    pinToday(new Date('2026-09-18T10:00:00+10:00'));

    expect(new Date().toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(Date.now()).toBe(Date.parse('2026-09-18T00:00:00.000Z'));

    const fired = await new Promise<boolean>((resolve) => {
      const fallback = setTimeout(() => resolve(false), 2000);
      setTimeout(() => {
        clearTimeout(fallback);
        resolve(true);
      }, 5);
    });
    expect(fired).toBe(true);
  });

  it('is the only place in src that lists which timers stay real', () => {
    const owners = sourceFiles(SRC_DIR)
      .filter((file) => fs.readFileSync(file, 'utf8').includes(TIMER_LIST_OPTION))
      .map((file) => path.relative(SRC_DIR, file).split(path.sep).join('/'));

    expect(owners).toEqual(['__tests__/support/clock.ts']);
  });
});
