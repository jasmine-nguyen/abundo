#!/usr/bin/env bash
# Build the gitignored Terraform lambda/layer artifacts. SINGLE SOURCE OF TRUTH,
# called BOTH by the Terraform null_resource provisioners (terraform/lambda.tf,
# terraform/layers.tf) and by the CI deploy workflow (.github/workflows/deploy.yml)
# before `terraform init`.
#
# Why CI needs this: the provisioners only run on create / trigger-change. CI uses
# the REMOTE state, which already records them as created with matching triggers,
# so on a fresh runner they DON'T re-run and the build dirs stay absent — plan then
# errors on a missing source_dir and apply would ship the webhook without its deps
# (the documented 500). CI runs this script itself; keeping it the one recipe both
# sides use means the local and CI builds can never drift.
#
# Usage: build_terraform_artifacts.sh [webhook|lambda_api|shared_layer|all]  (default: all)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

build_webhook() {
  # Install the webhook lambda's third-party deps into lambda/ (standardwebhooks).
  # --no-deps on purpose: its declared deps (httpx, wrapt's compiled .so) are unused
  # and would ship an architecture-incompatible wheel into the Linux runtime.
  python3 -m pip install --no-deps --quiet --target "$ROOT/lambda" -r "$ROOT/lambda/requirements.txt"
}

build_lambda_api() {
  # Stage lambda_api from ONLY its git-tracked *.py files into a clean dir: a new
  # committed module ships automatically, and untracked cruft (a stray __pycache__,
  # a leftover stale module) never does.
  rm -rf "$ROOT/terraform/build/lambda_api"
  mkdir -p "$ROOT/terraform/build/lambda_api"
  local files
  files=$(git -C "$ROOT" ls-files -- ':(glob)lambda_api/*.py') || { echo 'build_lambda_api: git ls-files failed' >&2; exit 1; }
  [ -n "$files" ] || { echo 'build_lambda_api: no tracked lambda_api/*.py' >&2; exit 1; }
  local f
  while IFS= read -r f; do
    cp "$ROOT/$f" "$ROOT/terraform/build/lambda_api/"
  done <<<"$files"
}

build_shared_layer() {
  # Rebuild the shared layer from scratch (a deleted shared file must not linger),
  # copy only .py files, and bundle tzdata (handler.py's ZoneInfo needs the IANA db,
  # which Lambda's base image doesn't reliably ship). --no-deps: tzdata is pure data.
  # The copy is recursive (subpackages ship), .py only, skipping tests and caches.
  local dest="$ROOT/terraform/layer/python" f
  rm -rf "$dest"
  mkdir -p "$dest"
  (cd "$ROOT/shared" && find . \( -name __pycache__ -o -name tests \) -prune -o \
      -name '*.py' ! -name 'test_*.py' ! -name conftest.py -print) |
    while IFS= read -r f; do
      mkdir -p "$dest/$(dirname "$f")"
      cp "$ROOT/shared/$f" "$dest/$f"
    done
  python3 -m pip install --no-deps --quiet --target "$dest" tzdata
}

target="${1:-all}"
case "$target" in
  webhook) build_webhook ;;
  lambda_api) build_lambda_api ;;
  shared_layer) build_shared_layer ;;
  all)
    build_webhook
    build_lambda_api
    build_shared_layer
    ;;
  *)
    echo "unknown target: $target (want: webhook|lambda_api|shared_layer|all)" >&2
    exit 2
    ;;
esac
