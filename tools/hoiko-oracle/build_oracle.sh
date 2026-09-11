#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${HOIKO_DIR:?set HOIKO_DIR to the Hoiko_PPT_v0-beta1 folder (Hoiko.exe + *.dll)}"

command -v mcs >/dev/null || { echo "mcs (mono) required"; exit 1; }
mcs -sdk:4.8 -target:library -out:"$HERE/ScpDriverInterface.dll" "$HERE/ScpDriverStub.cs"

rm -rf "$HERE/run" && mkdir -p "$HERE/run"
cp "$BIN/Hoiko.exe" "$BIN/config.dll" "$BIN/we.dll" "$BIN/wo.dll" "$BIN/wd.dll" \
   "$BIN/wr.dll" "$BIN/ultra1.dll" "$BIN/ultra2.dll" "$BIN/sprint.dll" "$HERE/run/"
cp "$HERE/ScpDriverInterface.dll" "$HERE/run/"
echo "built + staged $HERE/run"
