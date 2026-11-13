"""Read-only replay forensics for one or more rematch run directories.

Usage: python3 -I forensics.py RUN_DIR [RUN_DIR...] [--detail SEED:SWAPPED]

Per game: outcome, per-200-turn windows of attack/sent/cancelled/received and max
heights for both sides, and the attack mix (clear types). Garbage received at a lock is
read from the replay's own pending queue (referee Guideline profile: everything pending
after cancellation is inserted on the next lock).
"""
import collections
import glob
import json
import sys
from pathlib import Path


def height(m):
    return max(x.bit_length() for x in m['board'])


def holes(m):
    return sum(x.bit_length() - x.bit_count() for x in m['board'])


def load(run):
    games = []
    for f in sorted(glob.glob(f'{run}/[0-9]*.jsonl')):
        if '.tbp.' in f:
            continue
        for line in open(f):
            r = json.loads(line)
            if r['type'] == 'start':
                start, moves = r, []
            elif r['type'] == 'move':
                moves.append(r)
            elif r['type'] == 'result':
                games.append((start, r, moves))
    return games


def outcome(start, res):
    w = res['result']['winner']
    return 'D' if w is None else 'W' if start['agents'][w] == 'attax' else 'L'


def clear_kind(m):
    o, mv = m['outcome'], m['move']
    if not o or not o['lines']:
        return None
    spin = mv['spin'] if mv else 'none'
    return f"{'T' + spin[0] + '-' if spin != 'none' else ''}{o['lines']}"


def per_agent(moves, agent):
    return [m for m in moves if m['agent'] == agent]


def summarise(start, res, moves, window=200):
    out = {}
    for agent in ('attax', 'cold_clear_2'):
        a = per_agent(moves, agent)
        rows = []
        for lo in range(0, 1000, window):
            w = [m for m in a if lo <= m['turn'] < lo + window and m['outcome']]
            if not w:
                continue
            rows.append(dict(
                t=lo, n=len(w),
                atk=sum(m['outcome']['attack'] for m in w),
                sent=sum(m['outcome']['sent'] for m in w),
                canc=sum(m['outcome']['cancelled'] for m in w),
                maxh=max(map(height, w)),
                meanh=round(sum(map(height, w)) / len(w), 1),
                holes=round(sum(map(holes, w)) / len(w), 1)))
        mix = collections.Counter(filter(None, map(clear_kind, a)))
        out[agent] = dict(windows=rows, mix=dict(sorted(mix.items())),
                          b2b_bonus=sum(1 for m in a if m['outcome'] and m['outcome']['attack'] >
                                        {'1': 0, '2': 1, '3': 2, '4': 4, 'Tf-1': 2, 'Tf-2': 4,
                                         'Tf-3': 6, 'Tm-1': 0, 'Tm-2': 1}.get(clear_kind(m) or '', 99)))
    return out


def main():
    args = sys.argv[1:]
    detail = None
    if '--detail' in args:
        i = args.index('--detail')
        detail = args[i + 1]
        del args[i:i + 2]
    for run in args:
        print(f'== {Path(run).name}')
        for start, res, moves in load(run):
            o = outcome(start, res)
            r = res['result']
            seat = start['agents'].index('attax')
            tag = f"{r['seed']}:{int(r['swapped'])}"
            print(f"{tag} seat{seat} {o} turns={r['turns']} attack attax={r['attack'][seat]} "
                  f"cc2={r['attack'][1 - seat]}")
            if o == 'W' and detail != tag:
                continue
            s = summarise(start, res, moves)
            for agent in s:
                print(f"   {agent[:5]} mix={s[agent]['mix']} b2b+={s[agent]['b2b_bonus']}")
                for w in s[agent]['windows']:
                    print('     ', w)
            if detail == tag or o == 'L':
                a = per_agent(moves, 'attax')
                c = {m['turn']: m for m in per_agent(moves, 'cold_clear_2')}
                print('   last 40 turns: turn attax(h,holes,atk,sent,canc,pend) | cc2(h,atk,sent)')
                for m in a[-40:]:
                    cm = c.get(m['turn'])
                    oo = m['outcome'] or {}
                    co = (cm or {}).get('outcome') or {}
                    print(f"     {m['turn']:4d} {height(m):2d} {holes(m):2d} {oo.get('attack', '-')} "
                          f"{oo.get('sent', '-')} {oo.get('cancelled', '-')} {len(m['pending'])} "
                          f"{clear_kind(m) or ''} | {height(cm) if cm else '-'} {co.get('attack', '-')} "
                          f"{co.get('sent', '-')} {clear_kind(cm) if cm else ''}")


main()
