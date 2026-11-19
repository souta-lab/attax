"""Tally probe outcomes from verified replay records (not progress counters).

For every seed with a `<seed>.verify` reading "verified 2 complete matches", each match's
`start` line names the agents per player index and its `result` line gives `winner_agent`,
per-player attack and pieces. Outcomes are cross-checked against the arena `<seed>.json`.

  python3 -I replay_tally.py runs/<label> [--expected-pairs N] [--json]
  python3 -I replay_tally.py --paired runs/<A> runs/<B>
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

ATTAX = "attax"


def games(directory: Path):
    """Yield (seed, swapped, outcome, attax_attack, attax_pieces, opp_attack, opp_pieces)."""
    out = []
    evidence = []
    for verify in sorted(directory.glob("[0-9]*.verify")):
        seed = int(verify.stem)
        if verify.read_text().strip() != "verified 2 complete matches":
            continue
        replay = verify.with_suffix(".jsonl")
        arena = json.loads(verify.with_suffix(".json").read_text())["matches"]
        agents = None
        found = []
        for line in replay.read_text().splitlines():
            d = json.loads(line)
            if d["type"] == "start":
                agents = d["agents"]
            elif d["type"] == "result":
                r = d["result"]
                me = agents.index(ATTAX)
                them = 1 - me
                winner = d.get("winner_agent")
                outcome = "D" if winner is None else ("W" if winner == ATTAX else "L")
                if r["winner"] is not None and agents[r["winner"]] != winner:
                    raise ValueError(f"{replay}: winner index/agent disagree")
                match = [m for m in arena if m["swapped"] == r["swapped"]]
                if len(match) != 1 or match[0]["winner"] != r["winner"]:
                    raise ValueError(f"{replay}: replay and arena record disagree")
                found.append((seed, r["swapped"], outcome, r["attack"][me], r["pieces"][me],
                               r["attack"][them], r["pieces"][them]))
        if len(found) != 2 or {g[1] for g in found} != {False, True}:
            raise ValueError(f"{replay}: expected one match per seat, got {len(found)}")
        out.extend(found)
        evidence.append(dict(seed=seed, replay_sha256=hashlib.sha256(replay.read_bytes()).hexdigest(),
                             verification="verified 2 complete matches"))
    return out, evidence


def summary(directory: Path):
    g, evidence = games(directory)
    w = sum(x[2] == "W" for x in g)
    l = sum(x[2] == "L" for x in g)
    d = sum(x[2] == "D" for x in g)
    pa, pp, oa, op = (sum(x[i] for x in g) for i in (3, 4, 5, 6))
    return dict(label=directory.name, pairs=len(evidence), games=len(g), wins=w, losses=l, draws=d,
                win_rate=w / len(g) if g else None,
                attax_attack=pa, attax_pieces=pp, attax_app=pa / pp if pp else None,
                cc2_attack=oa, cc2_pieces=op, cc2_app=oa / op if op else None,
                per_game=[dict(seed=x[0], swapped=x[1], outcome=x[2]) for x in g],
                evidence=evidence)


def paired(a: Path, b: Path):
    score = {"W": 1.0, "D": 0.5, "L": 0.0}
    ga = {(x[0], x[1]): x[2] for x in games(a)[0]}
    gb = {(x[0], x[1]): x[2] for x in games(b)[0]}
    keys = sorted(set(ga) & set(gb))
    rows = [(k, ga[k], gb[k], score[ga[k]] - score[gb[k]]) for k in keys]
    diffs = [r[3] for r in rows]
    # Seed-pair level (both seats of one seed together): the independent unit.
    seeds = sorted({k[0] for k in keys if (k[0], False) in ga and (k[0], True) in ga
                    and (k[0], False) in gb and (k[0], True) in gb})
    pair_diffs = [sum(score[ga[(s, sw)]] - score[gb[(s, sw)]] for sw in (False, True)) for s in seeds]
    n = len(pair_diffs)
    mean = sum(pair_diffs) / n if n else None
    sd = math.sqrt(sum((x - mean) ** 2 for x in pair_diffs) / (n - 1)) if n > 1 else None
    pos = sum(x > 0 for x in pair_diffs)
    neg = sum(x < 0 for x in pair_diffs)
    m = pos + neg
    # Two-sided exact sign test over non-tied seed pairs.
    k = min(pos, neg)
    sign_p = min(1.0, 2 * sum(math.comb(m, i) for i in range(k + 1)) / 2 ** m) if m else None
    return dict(a=a.name, b=b.name, matched_games=len(rows), matched_seed_pairs=n,
                a_score=sum(score[r[1]] for r in rows), b_score=sum(score[r[2]] for r in rows),
                mean_game_diff=sum(diffs) / len(diffs) if diffs else None,
                mean_seed_pair_diff=mean, seed_pair_diff_sd=sd,
                seed_pairs_a_better=pos, seed_pairs_b_better=neg, seed_pairs_tied=n - m,
                sign_test_p_two_sided=sign_p,
                games=[dict(seed=r[0][0], swapped=r[0][1], a=r[1], b=r[2], diff=r[3]) for r in rows],
                seed_pair_diffs=dict(zip(seeds, pair_diffs)))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("dirs", type=Path, nargs="+")
    p.add_argument("--paired", action="store_true")
    p.add_argument("--expected-pairs", type=int)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    if args.paired:
        print(json.dumps(paired(*args.dirs), indent=2))
    else:
        for d in args.dirs:
            s = summary(d)
            if args.json:
                print(json.dumps(s, indent=2))
            else:
                print(f"{s['label']}: {s['pairs']} pairs {s['games']} games  {s['wins']}W-{s['losses']}L-{s['draws']}D"
                      f"  APP attax {s['attax_app'] or 0:.4f} ({s['attax_attack']}/{s['attax_pieces']})"
                      f"  cc2 {s['cc2_app'] or 0:.4f} ({s['cc2_attack']}/{s['cc2_pieces']})")
            if args.expected_pairs is not None and s["pairs"] != args.expected_pairs:
                raise SystemExit(f"{d}: incomplete probe ({s['pairs']}/{args.expected_pairs})")
