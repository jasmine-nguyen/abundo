#!/usr/bin/env node
/**
 * Merge per-shard Jest coverage and enforce the client coverage floor (WHIT-243).
 *
 * CI runs the heavy `screen` project in N shards plus the fast `logic` project, each
 * emitting an istanbul-shaped `coverage-final.json` (via `--coverageReporters=json`
 * under `coverageProvider: 'v8'`). Jest's own `coverageThreshold` can only gate a
 * SINGLE run, so it can't police a sharded total — and if it were left on, every shard
 * would self-fail against its own partial slice. So the floor lives here instead: we
 * find every `coverage-final.json` under the input dir, merge them with
 * istanbul-lib-coverage (which sums per-statement/branch/function hit counts without
 * double-counting the shared denominator that `collectCoverageFrom` forces into every
 * shard), then exit non-zero if any global metric is below the floor.
 *
 * Usage: node scripts/coverage-merge-check.js <dir>
 *   <dir> is searched RECURSIVELY for coverage-final.json, so it works on both the CI
 *   layout (one downloaded-artifact subdir per shard) and a flat local dir. Writes a
 *   markdown table to $GITHUB_STEP_SUMMARY when that env var is set (mirrors the Python
 *   workflow's coverage summary).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createCoverageMap, createCoverageSummary } = require('istanbul-lib-coverage');

// The coverage floor — the single source of truth now that jest.config.js no longer
// carries `coverageThreshold` (which can't gate a sharded run). Keep in sync with the
// WHIT-243 card's "done when".
const FLOOR = { statements: 30, branches: 42, functions: 22, lines: 30 };
const METRICS = ['statements', 'branches', 'functions', 'lines'];

function findCoverageFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, not fatal
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'coverage-final.json') found.push(full);
    }
  };
  walk(dir);
  return found;
}

/**
 * Merge every readable coverage-final.json in `files` into one global summary.
 * A crashed shard can leave a zero-byte/partial json; those are skipped (not thrown)
 * so the surviving shards still merge — with fail-fast:false a partial set is expected.
 * Returns { mergedCount, skipped: [{file, reason}], summary } where summary is the
 * istanbul global CoverageSummary (or null when nothing merged).
 */
function mergeCoverage(files) {
  const map = createCoverageMap({});
  const skipped = [];
  let mergedCount = 0;
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) throw new Error('empty file');
      // map.merge validates the istanbul shape and THROWS on a valid-JSON-but-malformed
      // file (a shard that crashed mid-write leaving a file with no statementMap/s). Keep
      // it INSIDE the try so a partial shard is skipped, not allowed to crash the gate.
      map.merge(JSON.parse(raw));
    } catch (err) {
      skipped.push({ file, reason: err.message });
      continue;
    }
    mergedCount += 1;
  }
  if (mergedCount === 0) return { mergedCount, skipped, summary: null };

  const summary = createCoverageSummary();
  for (const file of map.files()) {
    summary.merge(map.fileCoverageFor(file).toSummary());
  }
  return { mergedCount, skipped, summary };
}

/**
 * Compare a global summary against FLOOR. Returns { rows, breaches, measuredNothing }.
 * Each row is { metric, covered, total, pct, floor, below }. A metric with a zero
 * denominator can't be "below" (nothing to cover), so it never breaches. `measuredNothing`
 * is true when NOT ONE statement was instrumented — a gate measuring zero code must fail
 * loudly (a vacuous green-at-0% is exactly what this card exists to prevent), not report
 * "floor met".
 */
function evaluateFloor(summary) {
  const rows = METRICS.map((metric) => {
    const { covered, total } = summary[metric];
    // istanbul reports pct as the STRING "Unknown" for a zero-denominator metric; treat
    // it as 0 so nothing downstream ever formats/compares a non-number.
    const pct = total > 0 ? summary[metric].pct : 0;
    const below = total > 0 && pct < FLOOR[metric];
    return { metric, covered, total, pct, floor: FLOOR[metric], below };
  });
  const breaches = rows.filter((row) => row.below);
  const measuredNothing = summary.statements.total === 0;
  return { rows, breaches, measuredNothing };
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/coverage-merge-check.js <coverage-artifacts-dir> [expectedReports]');
    process.exit(2);
  }
  // Optional: the number of reports the caller expects (CI passes 1 logic + N screen
  // shards). A missing/failed shard → fewer reports → fail, so a red shard can't slip
  // through as a partial (under-counted) number that still clears the floor. A malformed
  // arg must NOT silently disable the check (a NaN comparison is always false — it would
  // fail OPEN, the dangerous direction for a gate), so reject a non-integer explicitly.
  let expectedReports = null;
  if (process.argv[3] !== undefined) {
    expectedReports = Number(process.argv[3]);
    if (!Number.isInteger(expectedReports) || expectedReports < 0) {
      console.error(`Invalid expectedReports "${process.argv[3]}" — must be a non-negative integer.`);
      process.exit(2);
    }
  }

  const files = findCoverageFiles(dir);
  if (files.length === 0) {
    console.error(`No coverage-final.json found under "${dir}". Every shard failed to `
      + 'produce coverage, or the artifacts were not downloaded — failing the gate.');
    process.exit(1);
  }

  const { mergedCount, skipped, summary } = mergeCoverage(files);
  for (const { file, reason } of skipped) {
    console.error(`Skipping unreadable coverage file "${file}": ${reason}`);
  }
  if (summary === null) {
    console.error(`Found ${files.length} coverage file(s) under "${dir}" but none were `
      + 'readable — failing the gate.');
    process.exit(1);
  }

  const { rows, breaches, measuredNothing } = evaluateFloor(summary);

  console.log(`\nMerged client coverage (${mergedCount} shard report(s)):`);
  for (const row of rows) {
    const flag = row.below ? '  ✗ BELOW FLOOR' : '';
    console.log(`  ${row.metric.padEnd(11)} ${row.pct.toFixed(2).padStart(6)}%  `
      + `(${row.covered}/${row.total}, floor ${row.floor}%)${flag}`);
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const md = [
      '## 🧪 Client coverage (merged across shards)',
      '',
      `Merged from ${mergedCount} shard report(s). Floor: statements ${FLOOR.statements} `
        + `/ branches ${FLOOR.branches} / functions ${FLOOR.functions} / lines ${FLOOR.lines}.`,
      '',
      '| Metric | Coverage | Covered / Total | Floor | Status |',
      '| --- | --- | --- | --- | --- |',
      ...rows.map((row) => `| ${row.metric} | ${row.pct.toFixed(2)}% | `
        + `${row.covered}/${row.total} | ${row.floor}% | ${row.below ? '❌ below' : '✅'} |`),
      '',
    ].join('\n');
    try {
      fs.appendFileSync(summaryPath, md);
    } catch (err) {
      console.error(`Could not write run summary: ${err.message}`);
    }
  }

  // A missing shard means the merged number is under-counted — fail rather than gate on
  // a partial set (with the workflow's `if: !cancelled()`, this job runs even when a shard
  // failed, so this is the check that turns a lost shard into a red gate, not a silent pass).
  if (expectedReports !== null && mergedCount < expectedReports) {
    console.error(`\nExpected ${expectedReports} coverage report(s) but only ${mergedCount} merged`
      + ' — a shard failed to produce or upload coverage. Failing the gate.');
    process.exit(1);
  }

  // Files were found and parsed, but not one statement was instrumented — the gate would
  // be measuring zero code. Fail loudly instead of a vacuous "floor met".
  if (measuredNothing) {
    console.error('\nNo statements were instrumented — coverage measured nothing (a '
      + 'collectCoverageFrom mismatch, or an empty merge). Failing the gate.');
    process.exit(1);
  }

  if (breaches.length > 0) {
    const detail = breaches
      .map((row) => `${row.metric} ${row.pct.toFixed(2)}% < ${row.floor}%`)
      .join(', ');
    console.error(`\nCoverage floor breached: ${detail}`);
    process.exit(1);
  }

  console.log('\n✓ Coverage floor met.');
}

// Run as a CLI, but stay importable (require.main guard) so the pure pieces above can
// be unit-tested without invoking process.exit.
if (require.main === module) {
  main();
}

module.exports = { FLOOR, METRICS, findCoverageFiles, mergeCoverage, evaluateFloor };
