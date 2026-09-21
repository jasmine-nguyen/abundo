/**
 * Tests for the sharded-coverage merge gate (scripts/coverage-merge-check.js) — WHIT-243.
 *
 * This script IS the coverage floor (jest.config.js carries no coverageThreshold, which
 * can't gate a sharded run), so its merge math and gate exit codes are worth locking.
 * Trimmed to one fail-on-revert check per guard (WHIT-453): the union merge, the
 * malformed-shard skip, the floor boundary, the measured-nothing guard, and the CLI's
 * pass/breach/missing-shard/usage exit codes. Runs in the `logic` (node) project.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCoverageSummary } = require('istanbul-lib-coverage');

const { FLOOR, findCoverageFiles, mergeCoverage, evaluateFloor } = require('./coverage-merge-check.js');

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
  const raw = typeof json === 'string' ? json : JSON.stringify(json);
  fs.writeFileSync(path.join(sub, 'coverage-final.json'), raw);
}

// A coverage-artifacts dir of `n` valid shards, each fully covering a distinct file, so
// the merged total is 100% (well above floor).
function goodArtifacts(n) {
  const dir = tmpDir();
  for (let i = 0; i < n; i += 1) {
    writeShard(dir, `cov-${i}`, coverageJson(`/src/f${i}.ts`, [1, 1, 1]));
  }
  return dir;
}


describe('mergeCoverage', () => {
  test('unions hit counts across shards — a statement covered in EITHER shard is covered', () => {
    const dir = tmpDir();
    // Same file, complementary coverage: shard A hits stmt 0, shard B hits stmt 1.
    writeShard(dir, 'shardA', coverageJson('/src/x.ts', [1, 0]));
    writeShard(dir, 'shardB', coverageJson('/src/x.ts', [0, 1]));

    const { mergedCount, summary } = mergeCoverage(findCoverageFiles(dir));

    expect(mergedCount).toBe(2);
    // Union → both statements covered, not clobbered to one shard's zero.
    expect(summary.statements.covered).toBe(2);
    expect(summary.statements.pct).toBe(100);
  });

  test('skips empty / non-JSON / non-istanbul shards but still merges the readable one', () => {
    // A shard that crashed mid-write can leave an empty file, garbage, or valid JSON with
    // no statementMap. istanbul's map.merge throws on the last — all three must be skipped,
    // not allowed to abort the merge and take the whole gate down with them.
    const dir = tmpDir();
    writeShard(dir, 'good', coverageJson('/src/x.ts', [1, 1]));
    writeShard(dir, 'empty', '');
    writeShard(dir, 'garbage', 'not json{');
    writeShard(dir, 'malformed', { '/src/y.ts': { path: '/src/y.ts' } }); // no statementMap/s

    const { mergedCount, skipped, summary } = mergeCoverage(findCoverageFiles(dir));

    expect(mergedCount).toBe(1); // only the good shard
    expect(skipped).toHaveLength(3);
    expect(summary.statements.covered).toBe(2);
  });
});


describe('evaluateFloor', () => {
  const summaryOf = (over) => ({
    statements: { covered: 30, total: 100, pct: 30 }, // exactly at floor
    branches: { covered: 42, total: 100, pct: 42 },
    functions: { covered: 22, total: 100, pct: 22 },
    lines: { covered: 30, total: 100, pct: 30 },
    ...over,
  });

  test('a metric below its floor breaches; exactly-at-floor does not (< not <=)', () => {
    expect(evaluateFloor(summaryOf()).breaches).toEqual([]); // all four sit ON the floor
    const dip = summaryOf({ statements: { covered: 2999, total: 10000, pct: 29.99 } });
    expect(evaluateFloor(dip).breaches.map((row) => row.metric)).toEqual(['statements']);
  });

  test('the floor is exactly the WHIT-243 card values', () => {
    // The boundary test above sits a summary ON 30/42/22/30 and asserts no breach — that
    // pins each floor only from ABOVE (lowering branches to 10 would still pass it). Silently
    // lowering a floor is the protection regression this change swore not to introduce, so
    // pin the exact values here.
    expect(FLOOR).toEqual({ statements: 30, branches: 42, functions: 22, lines: 30 });
  });

  test('a real empty istanbul summary is measuredNothing, not a breach, with numeric pct', () => {
    // istanbul sets pct to the STRING "Unknown" for a zero-denominator metric — feed a
    // genuine empty summary so this locks that evaluateFloor normalises it to a number and
    // flags "measured nothing" rather than crashing or vacuously passing.
    const { rows, breaches, measuredNothing } = evaluateFloor(createCoverageSummary());

    expect(measuredNothing).toBe(true);
    expect(breaches).toEqual([]);
    expect(rows.every((row) => typeof row.pct === 'number')).toBe(true);
  });
});


describe('CLI (main)', () => {
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

  test('exits 1 when nothing was instrumented (measured-nothing gate)', () => {
    const dir = tmpDir();
    // A valid istanbul file whose one file has an empty statementMap → 0 total statements.
    writeShard(dir, 'cov-0', { '/src/empty.ts': { path: '/src/empty.ts', statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {} } });
    const { status, stderr } = runCli([dir]);
    expect(status).toBe(1);
    expect(stderr).toContain('measured nothing');
  });

  test('exits 1 with "No coverage-final.json" when the artifacts dir is empty', () => {
    // Missing / undownloaded coverage (findCoverageFiles → []) must fail CLOSED. Falling
    // through to "floor met" would fail OPEN — the one direction a gate must never take.
    const { status, stderr } = runCli([tmpDir()]);
    expect(status).toBe(1);
    expect(stderr).toContain('No coverage-final.json found');
  });

  test('exits 2 on a non-numeric expected report count instead of silently passing', () => {
    // A NaN comparison is always false, which would disable the missing-shard gate and fail
    // OPEN — reject a malformed count loudly instead.
    const { status, stderr } = runCli([goodArtifacts(1), 'five']);
    expect(status).toBe(2);
    expect(stderr).toContain('Invalid expectedReports');
  });

  test('exits 2 on a missing directory argument', () => {
    const { status, stderr } = runCli([]);
    expect(status).toBe(2);
    expect(stderr).toContain('usage:');
  });
});
