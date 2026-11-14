"""Compare a re-run Hoiko benchmark against the published records, ignoring timing only.

  python3 -I bench_diff.py bench-results/bot-vs-hoiko.jsonl bench-results/rematch-web-final.jsonl

Records are keyed by (seed, aSide). Every field must match except `thinkMs` (wall-clock).
Exits non-zero on any non-timing difference, a duplicate key, or a key missing from the
reference. Reports how many reference records the candidate covers.
"""
import json
import sys

TIMING = {"thinkMs"}


def strip(value):
    if isinstance(value, dict):
        return {k: strip(v) for k, v in value.items() if k not in TIMING}
    if isinstance(value, list):
        return [strip(v) for v in value]
    return value


def load(path):
    records = {}
    with open(path) as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            record = json.loads(line)
            key = (record["seed"], record["aSide"])
            if key in records:
                raise SystemExit(f"{path}:{number}: duplicate record {key}")
            records[key] = record
    return records


reference = load(sys.argv[1])
candidate = load(sys.argv[2])
differences = []
for key, record in sorted(candidate.items()):
    if key not in reference:
        differences.append((key, "not in reference"))
    elif strip(record) != strip(reference[key]):
        differences.append((key, {"reference": strip(reference[key]), "candidate": strip(record)}))
print(json.dumps(dict(reference_records=len(reference), candidate_records=len(candidate),
                      missing_from_candidate=len(set(reference) - set(candidate)),
                      non_timing_differences=len(differences),
                      differences=differences[:20]), indent=2))
sys.exit(1 if differences else 0)
