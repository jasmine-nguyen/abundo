#!/bin/bash
# SessionStart hook. A cloud session starts from a fresh clone, so this installs
# what /build and its checks (project-context.md, "Checks") need. Local sessions
# already have these, so it does nothing outside the cloud.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR"

python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' \
  || { echo "cloud-setup: build_graph.py needs Python 3.11+, found $(python3 --version)" >&2; exit 1; }

# Each install runs again only when the files it installs from have changed.
fingerprint() { cat "$@" | git hash-object --stdin; }

# requirements.txt is /build's own; requirements-dev.txt is what the pytest check needs (as in CI).
python_deps="requirements.txt lambda_sync_trigger/requirements-dev.txt"
[ -x .venv/bin/python ] || python3 -m venv .venv
if [ "$(cat .venv/.deps-stamp 2>/dev/null)" != "$(fingerprint $python_deps)" ]; then
  .venv/bin/pip install --quiet --disable-pip-version-check \
    -r requirements.txt -r lambda_sync_trigger/requirements-dev.txt
  fingerprint $python_deps > .venv/.deps-stamp
fi

if [ "$(cat node_modules/.deps-stamp 2>/dev/null)" != "$(fingerprint package-lock.json)" ]; then
  npm ci --no-audit --no-fund --loglevel=error
  fingerprint package-lock.json > node_modules/.deps-stamp
fi

echo "cloud-setup: /build dependencies ready (.venv/bin/python, node_modules)"
