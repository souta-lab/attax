#!/usr/bin/env bash
# Run the oracle once; writes oracle_result.txt in the run dir and prints it.
#
# Env (all optional):
#   HOIKO_ORACLE_ROOT     base dir holding prefix/ + run/ (default /tmp/opencode/oracle)
#   HOIKO_ORACLE_PREFIX   WINEPREFIX (default $HOIKO_ORACLE_ROOT/prefix)
#   HOIKO_ORACLE_RUN      staged exe + oracle_input.txt dir (default $HOIKO_ORACLE_ROOT/run)
#   HOIKO_ORACLE_TIMEOUT  wine timeout seconds (default 120)
set -euo pipefail
ROOT="${HOIKO_ORACLE_ROOT:-/tmp/opencode/oracle}"
RUN_DIR="${HOIKO_ORACLE_RUN:-$ROOT/run}"
if [[ ! -f "$RUN_DIR/Hoiko.exe" ]]; then
  echo "run_oracle.sh: no Hoiko.exe in $RUN_DIR (run build_oracle.sh first, set HOIKO_DIR)" >&2
  exit 1
fi
export WINEPREFIX="${HOIKO_ORACLE_PREFIX:-$ROOT/prefix}" WINEDEBUG=-all
cd "$RUN_DIR"
rm -f oracle_result.txt
timeout "${HOIKO_ORACLE_TIMEOUT:-120}" wine Hoiko.exe
echo "===== oracle_result.txt ====="
cat oracle_result.txt
