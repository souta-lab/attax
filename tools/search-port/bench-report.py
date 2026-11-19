#!/usr/bin/env python3
"""Render the bench-engines.sh raw results as a markdown comparison table."""
import glob
import json
import re
import statistics
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/bench-engines"


def time_stats(path):
    """(wall_s, cpu_s, peak_rss_mb) from a /usr/bin/time -v capture."""
    try:
        text = open(path).read()
    except FileNotFoundError:
        return None
    wall = re.search(r"Elapsed \(wall clock\) time.*: ([\d:.]+)", text)
    user = re.search(r"User time \(seconds\): ([\d.]+)", text)
    sys_ = re.search(r"System time \(seconds\): ([\d.]+)", text)
    rss = re.search(r"Maximum resident set size \(kbytes\): (\d+)", text)
    def secs(v):
        parts = [float(p) for p in v.split(":")]
        return parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0]
    return (
        secs(wall.group(1)) if wall else None,
        (float(user.group(1)) + float(sys_.group(1))) if user and sys_ else None,
        int(rss.group(1)) / 1024 if rss else None,
    )


def engine_cells(kind, width):
    """Per-case min across rounds -> median ms, median nodes/s, RSS, CPU/decision."""
    rounds = []
    stats = []
    for f in sorted(glob.glob(f"{OUT}/bench-{kind}-w{width}-r*.json*")):
        if f.endswith(".time"):
            continue
        per = {}
        if kind == "ts":
            rec = json.load(open(f))
            for t in rec["timings"]:
                per[t["id"]] = (t["ms"], t["nodes"])
        else:
            for line in open(f):
                line = line.strip()
                if line:
                    r = json.loads(line)
                    per[r["id"]] = (r["rustMs"], r["nodes"])
        rounds.append(per)
        ts_ = time_stats(f.rsplit(".", 1)[0] + ".time") or time_stats(f + ".time")
        if ts_:
            stats.append(ts_)
    if not rounds:
        return None
    ids = set.intersection(*[set(r) for r in rounds])
    best = [min((r[i] for r in rounds), key=lambda p: p[0]) for i in ids]
    med_ms = statistics.median(p[0] for p in best)
    med_nps = statistics.median(p[1] / p[0] * 1000 for p in best if p[0] > 0)
    rss = max((s[2] for s in stats if s[2]), default=None)
    # The Rust bench runs each case --repeat 3 times (best-of is the reported
    # ms), so its process CPU covers 3 searches per case; TS runs 1.
    searches_per_case = 1 if kind == "ts" else 3
    cpu = statistics.median(
        s[1] / (len(ids) * searches_per_case) * 1000 for s in stats if s[1]
    )
    return med_ms, med_nps, rss, cpu


def wall_of(pattern):
    vals = []
    for f in sorted(glob.glob(f"{OUT}/{pattern}.time")):
        s = time_stats(f)
        if s and s[0]:
            vals.append(s[0])
    return statistics.median(vals) if vals else None


def fmt(v, nd=1):
    return f"{v:,.{nd}f}" if isinstance(v, (int, float)) else "—"


print(open(f"{OUT}/meta.txt").read())
print("| config | width | median ms/move | nodes/sec | peak RSS (MB) | CPU ms/decision |")
print("|---|---|---|---|---|---|")
for kind, label in (("ts", "TS reference"), ("rust-plain", "Rust plain"), ("rust-opt", "Rust optimized")):
    for w in (48, 96):
        c = engine_cells(kind, w)
        if c:
            print(f"| {label} | {w} | {fmt(c[0], 2)} | {fmt(c[1], 0)} | {fmt(c[2], 0)} | {fmt(c[3], 1)} |")
print()
print("| run | wall (s) |")
print("|---|---|")
for name in ("ts", "rust-plain-oneshot", "rust-plain-server", "rust-opt-server"):
    print(f"| corpus (720 decisions, workers=1) — {name} | {fmt(wall_of(f'corpus-{name}'), 1)} |")
print(f"| corpus (720, production workers) — rust-opt-server | {fmt(wall_of('corpus-prod'), 1)} |")
for name in ("ts", "rust-plain-oneshot", "rust-opt-server"):
    print(f"| smoke games — {name} | {fmt(wall_of(f'smoke-{name}'), 1)} |")
