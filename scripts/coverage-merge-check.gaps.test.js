/**
 * WHIT-243 — ADDITIONAL adversarial gaps for the sharded-coverage merge gate
 * (scripts/coverage-merge-check.js). Complements coverage-merge-check.test.js
 * (which locks the union merge, malformed-skip, and the FLOOR values); this file
 * adds the boundary + branch/function-union + shape-safety cases that file misses.
 * Runs in the `logic` (node) project via the `scripts/**\/*.test.js` testMatch.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findCoverageFiles,
  mergeCoverage,
  evaluateFloor,
} = require('./coverage-merge-check.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'covgap-'));
}

// A richer istanbul fixture than the sibling file's statements-only helper: lets each
// shard set STATEMENT, BRANCH and FUNCTION hit counts so we can prove the merge unions
// all three metrics across shards (the sibling test only exercises statements).
function coverageJson(filePath, { s = [], b = [], f = [] } = {}) {
  const statementMap = {};
  const sHits = {};
  s.forEach((hit, i) => {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 9 } };
    sHits[i] = hit;
  });
  const branchMap = {};
  const bHits = {};
  b.forEach((paths, i) => {
    branchMap[i] = {
      type: 'if',
      line: i + 1,
      loc: { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 9 } },
      locations: paths.map(() => ({ start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 9 } })),
    };
    bHits[i] = paths.slice();
  });
  const fnMap = {};
  const fHits = {};
  f.forEach((hit, i) => {
    fnMap[i] = {
      name: `fn${i}`,
      decl: { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 9 } },
      loc: { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 9 } },
      line: i + 1,
    };
    fHits[i] = hit;
  });
  return {
    [filePath]: { path: filePath, statementMap, s: sHits, branchMap, b: bHits, fnMap, f: fHits },
  };
}

function writeShard(dir, name, json) {
  const sub = path.join(dir, name);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'coverage-final.json'), JSON.stringify(json));
}

// A summary shaped exactly like istanbul's global CoverageSummary, so evaluateFloor
// sees the real fields it reads. Override any metric to probe a boundary.
const summaryOf = (over = {}) => ({
  statements: { covered: 30, total: 100, pct: 30 },
  branches: { covered: 42, total: 100, pct: 42 },
  functions: { covered: 22, total: 100, pct: 22 },
  lines: { covered: 30, total: 100, pct: 30 },
  ...over,
});


describe('evaluateFloor — floor boundary semantics (< vs <=)', () => {
  // [A7] exactly-at-floor must PASS, not breach. The whole default summaryOf sits
  // ON each floor (30/42/22/30); a `<=` bug would flag all four as below.
  test('a metric exactly at its floor passes (pct === floor is not a breach)', () => {
    expect(evaluateFloor(summaryOf()).breaches).toEqual([]);
  });

  // [A8] a hair below the floor breaches — the smallest real regression the gate exists
  // to catch. 29.99 < 30 (statements/lines) and 41.99 < 42 (branches).
  test('a fractional dip below the floor breaches', () => {
    const dip = summaryOf({
      statements: { covered: 2999, total: 10000, pct: 29.99 },
      lines: { covered: 2999, total: 10000, pct: 29.99 },
      branches: { covered: 4199, total: 10000, pct: 41.99 },
    });
    expect(evaluateFloor(dip).breaches.map((r) => r.metric).sort())
      .toEqual(['branches', 'lines', 'statements']);
  });

  // [A9] one metric exactly at floor, a sibling just below → only the below one breaches
  // (each metric judged independently, no bleed).
  test('exactly-at-floor and just-below coexist without cross-contaminating', () => {
    const mix = summaryOf({
      functions: { covered: 2199, total: 10000, pct: 21.99 }, // below 22
    });
    expect(evaluateFloor(mix).breaches.map((r) => r.metric)).toEqual(['functions']);
  });
});


describe('evaluateFloor — mixed zero-denominator', () => {
  // [A10] a single zero-total metric is skipped even while a sibling breaches: the
  // zero-guard is per-metric, not all-or-nothing (the sibling test only zeroes ALL four).
  test('a lone zero-total metric never breaches while a real metric still does', () => {
    const mixed = summaryOf({
      functions: { covered: 0, total: 0, pct: 0 },        // no functions collected → skip
      statements: { covered: 10, total: 100, pct: 10 },   // real breach
    });
    const breaches = evaluateFloor(mixed).breaches.map((r) => r.metric);
    expect(breaches).toContain('statements');
    expect(breaches).not.toContain('functions');
  });
});


describe('mergeCoverage — unions branches and functions, not just statements', () => {
  // [A11] Complementary branch/function coverage across two shards for the SAME file must
  // OR together (branch path hit in either shard = covered), same as statements. The
  // sibling test proves this only for statements — a merge that dropped b/f would slip past it.
  test('a branch path or function hit in EITHER shard counts as covered', () => {
    const dir = tmpDir();
    // file has 1 two-way branch and 1 function. Shard A hits path0 + the fn; shard B hits path1.
    writeShard(dir, 'shardA', coverageJson('/src/y.ts', { s: [1], b: [[1, 0]], f: [1] }));
    writeShard(dir, 'shardB', coverageJson('/src/y.ts', { s: [1], b: [[0, 1]], f: [0] }));

    const { summary } = mergeCoverage(findCoverageFiles(dir));

    expect(summary.branches.total).toBe(2);
    expect(summary.branches.covered).toBe(2); // both paths, unioned
    expect(summary.functions.total).toBe(1);
    expect(summary.functions.covered).toBe(1); // fn hit in shard A survives shard B's 0
  });
});


describe('mergeCoverage — v8 map drift across shards does not crash', () => {
  // [A12] Same file, DIFFERENT statementMap sizes across shards (v8 can remap a file
  // slightly differently per shard). Merge must take the union and NOT throw / crash the gate.
  test('drifting statement maps for one file merge to the union without throwing', () => {
    const dir = tmpDir();
    writeShard(dir, 'shardA', coverageJson('/src/z.ts', { s: [1, 0] }));      // 2 statements
    writeShard(dir, 'shardB', coverageJson('/src/z.ts', { s: [0, 1, 1] }));   // 3 statements

    const { mergedCount, summary } = mergeCoverage(findCoverageFiles(dir));

    expect(mergedCount).toBe(2);
    expect(summary.statements.total).toBe(3); // union of the two maps
    expect(summary.statements.covered).toBe(3);
  });
});


describe('findCoverageFiles — shape safety', () => {
  // [A13] A path literally named coverage-final.json that is a DIRECTORY (a corrupt/racey
  // artifact extraction) must NOT be returned as a file — it is walked, not read, so the
  // gate never tries to JSON.parse a directory and crash.
  test('a directory named coverage-final.json is not returned as a coverage file', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'weird', 'coverage-final.json'), { recursive: true });
    writeShard(dir, 'real', coverageJson('/src/a.ts', { s: [1] }));

    const found = findCoverageFiles(dir);

    expect(found).toHaveLength(1);
    expect(found[0]).toBe(path.join(dir, 'real', 'coverage-final.json'));
  });
});
