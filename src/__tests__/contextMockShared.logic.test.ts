// WHIT-777 — screen suites share one ../context stand-in builder (support/contextMock
// realContextWith / emptyContextMockModule) instead of each hand-copying the empty one.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

const SELF = 'contextMockShared.logic.test.ts';
const SHARED_FILES = ['support/contextMock.ts', SELF];

const INLINE_EMPTY = /useAppContext:\s*\(\)\s*=>\s*\(\{\s*\}\)/;

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');

describe('screen suites share one empty context stand-in', () => {
  it('no test file keeps its own empty context stand-in', () => {
    const offenders = testFiles(__dirname).filter(
      (file) => !SHARED_FILES.includes(file) && INLINE_EMPTY.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });
});
