#!/usr/bin/env bash
# Offline guard for scripts/build_terraform_artifacts.sh (WHIT-503).
# Proves, without network or terraform:
#   [M1] the lambda_api allowlist in the script == the !lambda_api/* allowlist in .gitignore
#   [M2] `lambda_api` stages EXACTLY the allowlist — no more, no less
#   [M3] on-disk cruft (a stray .py) is NOT shipped by the lambda_api copy
#   [M4] an unknown target exits non-zero (2)
#   [M5] every top-level shared/*.py is staged into the layer
#   [M6] shared subpackages are staged; __pycache__, tests/ and test_*.py are not
#   [M7] a staged subpackage imports from the layer
#   [M8] tzdata is pip-installed into the layer dir
# M5-M8 run in a sandbox copy, so the real terraform/layer/python is never touched.
# Run: bash scripts/tests/build_artifacts_test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/build_terraform_artifacts.sh"
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- [M1] allowlist parity: script vs .gitignore -----------------------------
script_list=$(bash -c '
  set -euo pipefail
  eval "$(grep -E "^LAMBDA_API_SOURCES=" "'"$SCRIPT"'")"
  printf "%s\n" "${LAMBDA_API_SOURCES[@]}"
' | sort)
gitignore_list=$(grep -E '^!lambda_api/' "$ROOT/.gitignore" | sed 's#^!lambda_api/##' | sort)
[ "$script_list" = "$gitignore_list" ] || fail "[M1] allowlist drift:
script:
$script_list
.gitignore:
$gitignore_list"
echo "PASS [M1] allowlist matches .gitignore"

# --- [M3 setup] plant cruft that must NOT ship -------------------------------
CRUFT="$ROOT/lambda_api/__cruft_should_not_ship__.py"
echo "x = 1" >"$CRUFT"
SANDBOX=$(mktemp -d)
trap 'rm -f "$CRUFT"; rm -rf "$SANDBOX"' EXIT

# --- run the staging target --------------------------------------------------
bash "$SCRIPT" lambda_api

# --- [M2] staged set == allowlist exactly ------------------------------------
staged=$(ls -1 "$ROOT/terraform/build/lambda_api" | sort)
[ "$staged" = "$script_list" ] || fail "[M2] staged set != allowlist:
staged:
$staged
allowlist:
$script_list"
echo "PASS [M2] staged exactly the allowlist"

# --- [M3] cruft excluded -----------------------------------------------------
[ ! -e "$ROOT/terraform/build/lambda_api/__cruft_should_not_ship__.py" ] ||
  fail "[M3] on-disk cruft leaked into the staged dir"
echo "PASS [M3] stray lambda_api/*.py not shipped"

# --- [M4] unknown target errors ----------------------------------------------
rc=0
bash "$SCRIPT" definitely_not_a_target >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "[M4] unknown target exit=$rc (expected 2)"
echo "PASS [M4] unknown target exits 2"

# --- [M5-M8 setup] sandbox copy with a planted subpackage --------------------
REAL_PY=$(command -v python3)
mkdir -p "$SANDBOX/scripts" "$SANDBOX/bin"
cp "$SCRIPT" "$SANDBOX/scripts/"
cp -R "$ROOT/shared" "$SANDBOX/shared"
probe="$SANDBOX/shared/probe_pkg"
mkdir -p "$probe/sub" "$probe/__pycache__" "$probe/tests"
echo "from probe_pkg.sub.leaf import VALUE" >"$probe/__init__.py"
: >"$probe/sub/__init__.py"
echo "VALUE = 581" >"$probe/sub/leaf.py"
: >"$probe/__pycache__/junk.pyc"
echo "x = 1" >"$probe/tests/test_x.py"
echo "x = 1" >"$SANDBOX/shared/test_top.py"
# Stub python3 so the tzdata pip step runs offline; it only logs its arguments.
PIP_LOG="$SANDBOX/pip.log"
printf '#!/usr/bin/env bash\necho "$*" >>"%s"\n' "$PIP_LOG" >"$SANDBOX/bin/python3"
chmod +x "$SANDBOX/bin/python3"
PATH="$SANDBOX/bin:$PATH" bash "$SANDBOX/scripts/build_terraform_artifacts.sh" shared_layer
LAYER="$SANDBOX/terraform/layer/python"

# --- [M5] every top-level shared module staged -------------------------------
for f in "$ROOT"/shared/*.py; do
  [ -f "$LAYER/$(basename "$f")" ] || fail "[M5] $(basename "$f") missing from the layer"
done
echo "PASS [M5] top-level shared/*.py staged"

# --- [M6] subpackage staged, tests and caches skipped ------------------------
for f in probe_pkg/__init__.py probe_pkg/sub/__init__.py probe_pkg/sub/leaf.py; do
  [ -f "$LAYER/$f" ] || fail "[M6] $f missing from the layer"
done
leaked=$(cd "$LAYER" && find . -name __pycache__ -o -name tests -o -name 'test_*.py')
[ -z "$leaked" ] || fail "[M6] test/cache files leaked into the layer: $leaked"
echo "PASS [M6] subpackage staged; tests and caches skipped"

# --- [M7] the staged subpackage imports --------------------------------------
PYTHONPATH="$LAYER" "$REAL_PY" -c 'import probe_pkg; assert probe_pkg.VALUE == 581' ||
  fail "[M7] probe_pkg did not import from the layer"
echo "PASS [M7] staged subpackage imports"

# --- [M8] tzdata installed into the layer ------------------------------------
grep -q -- "--target $LAYER tzdata" "$PIP_LOG" || fail "[M8] tzdata not installed into the layer: $(cat "$PIP_LOG")"
echo "PASS [M8] tzdata installed into the layer"

echo "ALL PASS"
