#!/usr/bin/env bash
# One-time Wine prefix setup for the Hoiko runtime oracle (network required, ~15 min).
# Requires: wine (>=9), winetricks. Installs .NET Framework 4.8 into a win64 prefix.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WINEPREFIX="${HOIKO_ORACLE_PREFIX:-$HERE/prefix}" WINEARCH=win64 WINEDEBUG=-all
winetricks -q win10
winetricks -q dotnet48
echo "prefix ready: $WINEPREFIX"
