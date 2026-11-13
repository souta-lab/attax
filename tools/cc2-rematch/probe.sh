#!/bin/bash
set -eu
export PATH=/opt/hatch-image/bin:$PATH
repo=/home/hatch/workspace/attax-tbp-pack
rig=/home/hatch/workspace/attax-gauntlet
label=$1
first=$2
last=$3
mkdir -p "$repo/tools/cc2-rematch/runs/$label"
for seed in $(seq "$first" "$last"); do
 prefix="$repo/tools/cc2-rematch/runs/$label/$seed"
 test ! -e "$prefix.jsonl"
 ATTAX_REPO="$repo" ATTAX_EXTERNAL="$repo/tools/cc2-rematch/attax.sh" ATTAX_TBP_LOG="$prefix.attax.log" TBP_AUDIT="$prefix.tbp.jsonl" "$rig/rig/target/release/intetrigence" external-arena --rules guideline --opponent "$rig/cold-clear-2/target/release/cold-clear-2" --strict-external-time --games 2 --seed "$seed" --ms 100 --pps 5 --turns 1000 --output "$prefix.json" --replay "$prefix.jsonl" > "$prefix.progress" 2> "$prefix.stderr"
 "$rig/rig/target/release/intetrigence" verify-replay --input "$prefix.jsonl" > "$prefix.verify"
 echo "completed $label $seed"
done
