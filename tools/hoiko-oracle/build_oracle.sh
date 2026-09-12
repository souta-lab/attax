#!/usr/bin/env bash
# Build the ScpDriverInterface.dll oracle stub and stage a run dir.
#
# Env (all optional):
#   HOIKO_DIR           Hoiko_PPT_v0-beta1 folder (Hoiko.exe + weight dlls)
#                       default: /tmp/opencode/hoiko-bin/extracted/... then
#                       /home/s0u7a/hoiko/Hoiko_PPT_v0-beta1/Hoiko_PPT_v0-beta1
#   HOIKO_ORACLE_ROOT   base dir holding prefix/ + run/ (default /tmp/opencode/oracle)
#   HOIKO_ORACLE_RUN    staged output dir (default $HOIKO_ORACLE_ROOT/run)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HOIKO_ORACLE_ROOT:-/tmp/opencode/oracle}"
RUN_DIR="${HOIKO_ORACLE_RUN:-$ROOT/run}"

DEFAULT_BIN=/tmp/opencode/hoiko-bin/extracted/Hoiko_PPT_v0-beta1/Hoiko_PPT_v0-beta1
if [[ ! -f "$DEFAULT_BIN/Hoiko.exe" ]]; then
  DEFAULT_BIN=/home/s0u7a/hoiko/Hoiko_PPT_v0-beta1/Hoiko_PPT_v0-beta1
fi
BIN="${HOIKO_DIR:-$DEFAULT_BIN}"
if [[ ! -f "$BIN/Hoiko.exe" ]]; then
  echo "build_oracle.sh: Hoiko.exe not found in HOIKO_DIR=$BIN" >&2
  exit 1
fi

command -v mcs >/dev/null || { echo "mcs (mono) required"; exit 1; }
mcs -sdk:4.8 -target:library -out:"$HERE/ScpDriverInterface.dll" "$HERE/ScpDriverStub.cs"

rm -rf "$RUN_DIR" && mkdir -p "$RUN_DIR"
cp "$BIN/Hoiko.exe" "$BIN/config.dll" "$BIN/we.dll" "$BIN/wo.dll" "$BIN/wd.dll" \
   "$BIN/wr.dll" "$BIN/ultra1.dll" "$BIN/ultra2.dll" "$BIN/sprint.dll" "$RUN_DIR/"
cp "$HERE/ScpDriverInterface.dll" "$RUN_DIR/"
echo "built + staged $RUN_DIR"
