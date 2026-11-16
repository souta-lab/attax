"""Summarize complete, replay-verified seed pairs; never count partial games."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--expected-pairs', type=int)
args = parser.parse_args()
games = []
files = []
for path in sorted(args.directory.glob('[0-9]*.json')):
    record = json.loads(path.read_text())
    verify = path.with_suffix('.verify')
    if not verify.exists() or verify.read_text().strip() != "verified 2 complete matches":
        continue
    pairs = record['matches']
    if len(pairs) != 2 or {p['swapped'] for p in pairs} != {True, False}:
        raise ValueError(f'incomplete/duplicate pair: {path}')
    games.extend(pairs)
    replay = path.with_suffix('.jsonl')
    files.append(dict(seed=pairs[0]['seed'], replay_sha256=hashlib.sha256(replay.read_bytes()).hexdigest(),
                      verification=verify.read_text().strip()))
wins = sum(g['winner'] is not None and g['winner'] == int(g['swapped']) for g in games)
draws = sum(g['winner'] is None for g in games)
pieces = [0, 0]
attack = [0, 0]
for g in games:
    seat = int(g['swapped'])
    for i, side in enumerate([seat, 1-seat]):
        pieces[i] += g['pieces'][side]
        attack[i] += g['attack'][side]
summary = dict(pairs=len(files), games=len(games), wins=wins, losses=len(games)-wins-draws,
               draws=draws, win_rate=wins/len(games) if games else None,
               pieces=pieces, attack=attack,
               attack_per_piece=[a/p if p else None for a,p in zip(attack,pieces)], evidence=files)
print(json.dumps(summary, indent=2))
if args.expected_pairs is not None and len(files) != args.expected_pairs:
    raise SystemExit('incomplete probe')
