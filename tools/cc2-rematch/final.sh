#!/bin/bash
# Run only after the candidate is frozen and development jobs have finished.
set -eu
cd /home/hatch/workspace/attax-tbp-pack
label=${1:-final-12001-12020}
# An empty range freezes source/configuration without playing any game.
tools/cc2-rematch/probe.sh "$label" 1 0
ATTAX_USE_FROZEN=1 tools/cc2-rematch/probe.sh "$label" 12001 12010 &
lane1=$!
ATTAX_USE_FROZEN=1 tools/cc2-rematch/probe.sh "$label" 12011 12020 &
lane2=$!
status=0
wait "$lane1" || status=$?
wait "$lane2" || status=$?
if test "$status" != 0; then exit "$status"; fi
python3 tools/cc2-rematch/summarize.py "tools/cc2-rematch/runs/$label" --expected-pairs 20
