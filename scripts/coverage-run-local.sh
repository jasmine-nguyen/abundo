#!/usr/bin/env bash
#
# Reproduce the CI sharded-coverage flow locally (WHIT-243).
#
# CI can't run the whole client suite under coverage in one process: the 100+ `screen`
# suites boot the entire React Native module graph, which OOM-crashes a worker under
# istanbul and hangs ~9 min under the v8 provider's source remap. So both CI and this
# script SHARD the work: the fast `logic` project runs whole, the heavy `screen` project
# runs in N shards, each measuring coverage for its own slice into a separate dir, and
# scripts/coverage-merge-check.js merges them and enforces the floor.
#
# Run this before opening a PR to get the same pass/fail the CI `coverage` job gives,
# without the hang. Override the shard count or output dir via SHARDS / OUT env vars.
set -euo pipefail

SHARDS="${SHARDS:-4}"
OUT="${OUT:-coverage-artifacts}"

rm -rf "$OUT"
mkdir -p "$OUT"

export TZ=Australia/Melbourne

echo "→ logic project (full, with coverage)"
npx jest --selectProjects logic --coverage --coverageReporters=json \
  --coverageDirectory="$OUT/logic" --maxWorkers=2

for shard in $(seq 1 "$SHARDS"); do
  echo "→ screen shard ${shard}/${SHARDS}"
  npx jest --selectProjects screen --shard="${shard}/${SHARDS}" --coverage \
    --coverageReporters=json --coverageDirectory="$OUT/screen-${shard}" \
    --workerIdleMemoryLimit=512MB --maxWorkers=2
done

echo "→ merge + enforce the floor"
node scripts/coverage-merge-check.js "$OUT"
