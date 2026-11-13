#!/bin/bash
set -eu
export PATH=/opt/hatch-image/bin:$PATH
repo=/home/hatch/workspace/attax-tbp-pack
rig=/home/hatch/workspace/attax-gauntlet
label=$1
first=$2
last=$3
out="$repo/tools/cc2-rematch/runs/$label"
test ! -e "$out"
mkdir -p "$out/source"
cp -R "$repo/src" "$out/source/src"
cp "$repo/tools/cc2-rematch/attax-tbp.ts" "$out/adapter.ts"
cat > "$out/external.sh" <<SCRIPT
#!/bin/sh
exec /opt/hatch-image/bin/bun "$out/adapter.ts"
SCRIPT
chmod +x "$out/external.sh"
git rev-parse HEAD > "$out/commit.txt"
rg --files "$out/source" | sort | xargs sha256sum > "$out/source.sha256"
if test -n "${ATTAX_WEIGHTS:-}"; then
 cp "$ATTAX_WEIGHTS" "$out/weights.json"
 export ATTAX_WEIGHTS="$out/weights.json"
fi
env | sort | rg '^ATTAX_' > "$out/environment.txt" || true
for seed in $(seq "$first" "$last"); do
 prefix="$repo/tools/cc2-rematch/runs/$label/$seed"
 test ! -e "$prefix.jsonl"
 ATTAX_REPO="$out/source" ATTAX_EXTERNAL="$out/external.sh" ATTAX_TBP_LOG="$prefix.attax.log" TBP_AUDIT="$prefix.tbp.jsonl" "$rig/rig/target/release/intetrigence" external-arena --rules guideline --opponent "$rig/cold-clear-2/target/release/cold-clear-2" --strict-external-time --games 2 --seed "$seed" --ms 100 --pps 5 --turns 1000 --output "$prefix.json" --replay "$prefix.jsonl" > "$prefix.progress" 2> "$prefix.stderr"
 "$rig/rig/target/release/intetrigence" verify-replay --input "$prefix.jsonl" > "$prefix.verify"
 echo "completed $label $seed"
done
