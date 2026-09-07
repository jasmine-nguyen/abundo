#!/usr/bin/env bash
# Offline guard for scripts/build_terraform_artifacts.sh (WHIT-503).
# Proves, without network or terraform:
#   [M1] the lambda_api allowlist in the script == the !lambda_api/* allowlist in .gitignore
#   [M2] `lambda_api` stages EXACTLY the allowlist — no more, no less
#   [M3] on-disk cruft (a stray .py) is NOT shipped by the lambda_api copy
#   [M4] an unknown target exits non-zero (2)
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
trap 'rm -f "$CRUFT"' EXIT

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

echo "ALL PASS"
