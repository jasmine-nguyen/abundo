/**
 * Tests for the sharded-coverage merge gate (scripts/coverage-merge-check.js) — WHIT-243.
 *
 * This script IS the coverage floor now (jest.config.js no longer carries
 * coverageThreshold), so its merge math and edge-guards are worth locking: the union
 * merge must not clobber a statement covered in one shard but not another, malformed
 * shard output must be skipped rather than crash the gate, and a zero-denominator metric
 * must never count as "below floor". Runs in the `logic` (node) project.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCoverageSummary } = require('istanbul-lib-coverage');

const {
  FLOOR,
  findCoverageFiles,
  mergeCoverage,
  evaluateFloor,
} = require('./coverage-merge-check.js');

const SCRIPT = path.join(__dirname, 'coverage-merge-check.js');

// Run the CLI and return { status, stdout, stderr } without throwing on a non-zero exit.
function runCli(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'covtest-'));
}

// Build a minimal istanbul-shaped coverage-final.json for one source file, where
// `statementHits[i]` is the hit count of statement i (0 = uncovered).
function coverageJson(filePath, statementHits) {
  const statementMap = {};
  const s = {};
  statementHits.forEach((hit, i) => {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 9 } };
    s[i] = hit;
  });
  return { [filePath]: { path: filePath, statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} } };
}

function writeShard(dir, name, json) {
  const sub = path.join(dir, name);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'coverage-final.json'), JSON.stringify(json));
  return path.join(sub, 'coverage-final.json');
}


describe('findCoverageFiles', () => {
  test('finds coverage-final.json recursively and ignores other files', () => {
    const dir = tmpDir();
    writeShard(dir, 'cov-logic', coverageJson('/src/a.ts', [1]));
    writeShard(dir, 'cov-screen-1', coverageJson('/src/b.ts', [1]));
    // decoys that must NOT be picked up
    fs.writeFileSync(path.join(dir, 'coverage-summary.json'), '{}');
    fs.mkdirSync(path.join(dir, 'empty-sub'), { recursive: true });

    const found = findCoverageFiles(dir);

    expect(found).toHaveLength(2);
    expect(found.every((f) => f.endsWith('coverage-final.json'))).toBe(true);
  });

  test('returns [] for a missing directory without throwing', () => {
    expect(findCoverageFiles(path.join(os.tmpdir(), 'nope-does-not-exist-xyz'))).toEqual([]);
  });
});


describe('mergeCoverage', () => {
  test('unions hit counts across shards — a statement covered in EITHER shard is covered', () => {
    const dir = tmpDir();
    // Same file, complementary coverage: shard A hits stmt 0, shard B hits stmt 1.
    writeShard(dir, 'shardA', coverageJson('/src/x.ts', [1, 0]));
    writeShard(dir, 'shardB', coverageJson('/src/x.ts', [0, 1]));

    const { mergedCount, skipped, summary } = mergeCoverage(findCoverageFiles(dir));

    expect(mergedCount).toBe(2);
    expect(skipped).toEqual([]);
    // Union → both statements covered, not clobbered to one shard's zero.
    expect(summary.statements.total).toBe(2);
    expect(summary.statements.covered).toBe(2);
    expect(summary.statements.pct).toBe(100);
  });

  test('skips empty / malformed shard json but still merges the readable ones', () => {
    const dir = tmpDir();
    writeShard(dir, 'good', coverageJson('/src/x.ts', [1, 1]));
    writeShard(dir, 'empty', {}); // will be overwritten with a zero-byte file below
    fs.writeFileSync(path.join(dir, 'empty', 'coverage-final.json'), '');
    writeShard(dir, 'garbage', {});
    fs.writeFileSync(path.join(dir, 'garbage', 'coverage-final.json'), 'not json{');

    const { mergedCount, skipped, summary } = mergeCoverage(findCoverageFiles(dir));

    expect(mergedCount).toBe(1); // only the good shard
    expect(skipped).toHaveLength(2); // empty + garbage
    expect(summary.statements.covered).toBe(2);
  });

  test('returns a null summary when nothing is readable', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'bad'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad', 'coverage-final.json'), '');

    const { mergedCount, summary } = mergeCoverage(findCoverageFiles(dir));

    expect(mergedCount).toBe(0);
    expect(summary).toBeNull();
  });

  test('skips a valid-JSON but non-istanbul-shaped shard instead of crashing the gate', () => {
    // A shard that crashed mid-write can leave a file that parses as JSON but is missing
    // statementMap/s. istanbul's map.merge throws on it — that throw must be caught and
    // the shard skipped, not allowed to abort the whole merge (WHIT-243 QA finding).
    const dir = tmpDir();
    writeShard(dir, 'malformed', { '/src/x.ts': { path: '/src/x.ts' } }); // no statementMap/s
    writeShard(dir, 'good', coverageJson('/src/a.ts', [1, 1]));

    const { mergedCount, skipped, summary } = mergeCoverage(findCoverageFiles(dir));

    expect(mergedCount).toBe(1);          // only the good shard
    expect(skipped).toHaveLength(1);      // malformed skipped, not thrown
    expect(summary.statements.covered).toBe(2);
  });
});


describe('evaluateFloor', () => {
  const summaryOf = (over) => ({
    statements: { covered: 10, total: 100, pct: 10 },
    branches: { covered: 50, total: 100, pct: 50 },
    functions: { covered: 50, total: 100, pct: 50 },
    lines: { covered: 10, total: 100, pct: 10 },
    ...over,
  });

  test('flags every metric below its floor', () => {
    // statements 10 < 30 and lines 10 < 30 breach; branches 50 >= 42 and functions 50 >= 22 pass.
    const { breaches } = evaluateFloor(summaryOf());
    expect(breaches.map((b) => b.metric).sort()).toEqual(['lines', 'statements']);
  });

  test('passes when every metric meets its floor', () => {
    const ok = summaryOf({
      statements: { covered: 97, total: 100, pct: 97 },
      lines: { covered: 97, total: 100, pct: 97 },
    });
    expect(evaluateFloor(ok).breaches).toEqual([]);
  });

  test('a zero-denominator metric never counts as below floor', () => {
    const ok = summaryOf({
      statements: { covered: 0, total: 0, pct: 0 },
      branches: { covered: 0, total: 0, pct: 0 },
      functions: { covered: 0, total: 0, pct: 0 },
      lines: { covered: 0, total: 0, pct: 0 },
    });
    expect(evaluateFloor(ok).breaches).toEqual([]);
  });

  test('the floor values match the WHIT-243 card', () => {
    expect(FLOOR).toEqual({ statements: 30, branches: 42, functions: 22, lines: 30 });
  });

  test('a REAL empty istanbul summary yields measuredNothing, no breach, numeric pct', () => {
    // istanbul sets pct to the STRING "Unknown" for a zero-denominator metric — feed a
    // genuine empty summary (not a hand-set pct:0) so this locks that evaluateFloor
    // normalises it to a number and flags "measured nothing" rather than crashing/vacuously
    // passing.
    const { rows, breaches, measuredNothing } = evaluateFloor(createCoverageSummary());

    expect(measuredNothing).toBe(true);
    expect(breaches).toEqual([]);
    expect(rows.every((row) => typeof row.pct === 'number')).toBe(true);
  });

  test('measuredNothing is false once any statement is instrumented', () => {
    const summary = summaryOf({ statements: { covered: 1, total: 100, pct: 1 } });
    expect(evaluateFloor(summary).measuredNothing).toBe(false);
  });
});


describe('CLI (main)', () => {
  // Build a coverage-artifacts dir of `n` valid istanbul shards, each fully covering a
  // distinct file, so the merged total is 100% (well above floor).
  function goodArtifacts(n) {
    const dir = tmpDir();
    for (let i = 0; i < n; i += 1) {
      writeShard(dir, `cov-${i}`, coverageJson(`/src/f${i}.ts`, [1, 1, 1]));
    }
    return dir;
  }

  test('exits 0 and reports "floor met" on healthy coverage', () => {
    const { status, stdout } = runCli([goodArtifacts(3)]);
    expect(status).toBe(0);
    expect(stdout).toContain('Coverage floor met');
  });

  test('exits 1 when a metric is below floor', () => {
    const dir = tmpDir();
    // 1 covered of 100 statements → 1% < 30% floor.
    writeShard(dir, 'cov-0', coverageJson('/src/f.ts', [1, ...Array(99).fill(0)]));
    const { status, stderr } = runCli([dir]);
    expect(status).toBe(1);
    expect(stderr).toContain('Coverage floor breached');
  });

  test('exits 1 when fewer reports than expected merged (a shard went missing)', () => {
    const { status, stderr } = runCli([goodArtifacts(3), '5']); // expected 5, only 3 present
    expect(status).toBe(1);
    expect(stderr).toContain('Expected 5 coverage report(s) but only 3 merged');
  });

  test('exits 0 when the expected report count is met', () => {
    const { status } = runCli([goodArtifacts(5), '5']);
    expect(status).toBe(0);
  });

  test('exits 1 when nothing was instrumented (measured-nothing gate)', () => {
    const dir = tmpDir();
    // A valid istanbul file whose one file has an empty statementMap → 0 total statements.
    writeShard(dir, 'cov-0', { '/src/empty.ts': { path: '/src/empty.ts', statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {} } });
    const { status, stderr } = runCli([dir]);
    expect(status).toBe(1);
    expect(stderr).toContain('measured nothing');
  });

  test('exits 2 on a missing directory argument', () => {
    const { status, stderr } = runCli([]);
    expect(status).toBe(2);
    expect(stderr).toContain('usage:');
  });

  test('exits 2 on a non-numeric expected report count instead of silently passing', () => {
    // A NaN comparison is always false, which would disable the missing-shard gate and
    // fail OPEN — reject a malformed count loudly instead.
    const { status, stderr } = runCli([goodArtifacts(1), 'five']);
    expect(status).toBe(2);
    expect(stderr).toContain('Invalid expectedReports');
  });

  test('exits 1 when the artifacts dir has no coverage at all', () => {
    const { status, stderr } = runCli([tmpDir()]);
    expect(status).toBe(1);
    expect(stderr).toContain('No coverage-final.json found');
  });
});
