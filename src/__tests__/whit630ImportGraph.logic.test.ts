// WHIT-630 QA: the loop must stay gone through INDIRECT imports too (a leaf that later imports a
// module that imports context.tsx brings it back), and the cache keys must be one shared set.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import * as queryKeys from '../queryKeys';

const SRC = path.join(__dirname, '..');
const CONTEXT = path.join(SRC, 'context.tsx');
const QUERIES = path.join(SRC, 'queries.ts');

const stripLineComments = (source: string) => source.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const ext of ['', '.ts', '.tsx']) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Every relative module a file imports or re-exports from — type-only imports included, since
// they are what started the loop (api.ts's type import of context.tsx).
function directImports(file: string): string[] {
  const source = stripLineComments(fs.readFileSync(file, 'utf8'));
  const pattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm;
  const found: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved) found.push(resolved);
  }
  return found;
}

// The chain of files from `start` to `target`, or null when `target` is unreachable.
function pathTo(start: string, target: string): string[] | null {
  const seen = new Set<string>([start]);
  const queue: string[][] = [[start]];
  while (queue.length) {
    const chain = queue.shift()!;
    for (const next of directImports(chain[chain.length - 1])) {
      if (next === target) return [...chain, next].map((f) => path.relative(SRC, f));
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}

const src = (file: string) => path.join(SRC, file);

describe('no indirect route back to context.tsx', () => {
  // [A6]
  it.each(['queries.ts', 'api.ts', 'transactionCache.ts', 'types.ts', 'model.ts', 'payCycle.ts', 'budgetMath.ts', 'queryKeys.ts'])(
    '(P0) %s never reaches context.tsx, directly or through another file',
    (file) => {
      expect(pathTo(src(file), CONTEXT)).toBeNull();
    },
  );

  // [A7]
  it('(P0) api.ts never reaches queries.ts', () => {
    expect(pathTo(src('api.ts'), QUERIES)).toBeNull();
  });
});

describe('leaf files stay leaves', () => {
  // [A8]
  it.each(['types.ts', 'queryKeys.ts'])('(P1) %s imports nothing', (file) => {
    expect(directImports(src(file))).toEqual([]);
  });

  // WHIT-762: plus api.ts for the PayCycle type (api.ts never reaches context.tsx — [A6] above).
  it('(P1) payCycle.ts depends on the date helpers and the PayCycle type only', () => {
    expect(directImports(src('payCycle.ts')).map((f) => path.relative(SRC, f))).toEqual(['dateutil.ts', 'api.ts']);
  });
});

describe('cache keys', () => {
  // [A9] Catches a hand-typed key under ANY name, not just the names queryKeys.ts knows today.
  const inlineKeyArray = /queryKey:\s*\[|(?:get|set|remove|invalidate|refetch|cancel|reset)Quer(?:y|ies)(?:Data)?(?:<[^>]*>)?\(\s*\[/;
  it.each(['context.tsx', 'transactionCache.ts'])('(P0) %s passes no inline array as a cache key', (file) => {
    const code = stripLineComments(fs.readFileSync(src(file), 'utf8'));
    expect(code.match(new RegExp(inlineKeyArray.source, 'g')) ?? []).toEqual([]);
  });

  const entries = Object.entries(queryKeys) as [string, readonly unknown[]][];

  // [A10]
  it('(P1) every exported key is a single-name array, and no two keys share a name', () => {
    for (const [, key] of entries) {
      expect(Array.isArray(key)).toBe(true);
      expect(key).toHaveLength(1);
      expect(typeof key[0]).toBe('string');
    }
    const names = entries.map(([, key]) => key[0]);
    expect(new Set(names).size).toBe(names.length);
  });
});
