#!/usr/bin/env bash
# Run the oracle once; writes ./run/oracle_result.txt and prints it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WINEPREFIX="${HOIKO_ORACLE_PREFIX:-$HERE/prefix}" WINEDEBUG=-all
cd "$HERE/run"
rm -f oracle_result.txt
timeout 90 wine Hoiko.exe
echo "===== oracle_result.txt ====="
cat oracle_result.txt
