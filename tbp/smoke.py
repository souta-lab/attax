#!/usr/bin/env python3
"""Two real TBP games, referee legality checks, primary-choice audit and replay verification."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

if len(sys.argv) != 2:
    sys.exit("usage: python3 tbp/smoke.py /path/to/intetrigence")
arena = str(Path(sys.argv[1]).resolve(strict=True))
launcher = str(Path(__file__).with_name("attax-tbp.sh").resolve())
with tempfile.TemporaryDirectory(prefix="attax-tbp-") as tmp:
    root = Path(tmp)
    log = root / "decisions.jsonl"
    replay = root / "replay.jsonl"
    report = root / "report.json"
    # Run outside the repo to exercise the launcher's working-directory independence.
    subprocess.run([
        arena, "external-arena", "--rules", "guideline", "--opponent", launcher,
        "--games", "2", "--seed", "6001", "--ms", "100", "--pps", "5",
        "--turns", "1000", "--output", str(report), "--replay", str(replay),
    ], cwd=tmp, env={**os.environ, "ATTAX_TBP_LOG": str(log)},
       stdout=subprocess.DEVNULL, check=True, timeout=600)
    records = [json.loads(line) for line in replay.read_text().splitlines()]
    decisions = [json.loads(line) for line in log.read_text().splitlines()]
    moves = [r for r in records if r["type"] == "move" and r["agent"] == "cold_clear_2"]
    results = [r for r in records if r["type"] == "result"]
    assert len(results) == 2, "expected two completed games"
    assert len(moves) == len(decisions) > 0, "decision/move count mismatch"
    fallbacks = sum(m["move"] != d["first"] for m, d in zip(moves, decisions))
    assert fallbacks == 0, f"{fallbacks} primary suggestions rejected"
    assert not any(d["cellsAboveRow20"] for d in decisions), "20-row view exceeded"
    subprocess.run([arena, "verify-replay", "--input", str(replay)],
                   check=True, timeout=60)
    print(f"PASS: {len(results)} games, {len(moves)} legal Attax moves, "
          f"{fallbacks} fallbacks; replay verified")
