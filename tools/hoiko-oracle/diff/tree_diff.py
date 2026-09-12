#!/usr/bin/env python3
"""Diff the shipping Hoiko.exe search arena (`oracle_tree.bin`, written by the
stub's `tree_dump=1` mode) against the replica's beam dump (`beams` mode of
`rust/target/release/examples/eval_dump`, `--beams` input file).

Arena layout (SPEC_Search §3): generation d's child array starts at node index
(d-1)*1500, stride 328. The first `keep` nodes are the post-partial_sort beam;
gen 14's array is the MaxElement input list. The replica dump lists the same
nodes in order; identity keys include score, first move, own placement, act,
combo/btb, hold, next-iterator base, and all 32 board rows.

Usage:
  python3 tree_diff.py ORACLE_TREE REPLICA_BEAMS.txt --log TREE_LOG
"""

import collections
import struct
import sys

STRIDE = 328
GEN_STRIDE = 1500


def parse_tree_addr(log_path):
    for line in open(log_path, encoding="utf-8", errors="replace"):
        if "tree=0x" in line:
            return int(line.split("tree=0x")[1].split()[0], 16)
    raise SystemExit(f"no tree address in {log_path}")


class Arena:
    def __init__(self, path, tree):
        self.data = open(path, "rb").read()
        self.tree = tree
        self.min_mptr = min(
            struct.unpack_from("<Q", self.data, i * STRIDE)[0] for i in range(34)
        )

    def node(self, base):
        data = self.data
        mptr = struct.unpack_from("<Q", data, base)[0]
        hold = struct.unpack_from("<i", data, base + 16)[0]
        x, y, r, m = struct.unpack_from("<4i", data, base + 64)
        last_srs = struct.unpack_from("<i", data, base + 80)[0]
        rows = struct.unpack_from("<32i", data, base + 96)
        combo, btb = struct.unpack_from("<2i", data, base + 288)
        act = struct.unpack_from("<i", data, base + 296)[0]
        score = struct.unpack_from("<i", data, base + 308)[0]
        parent = struct.unpack_from("<Q", data, base + 320)[0]
        return dict(
            score=score, x=x, y=y, r=r, m=m, last_srs=last_srs, act=act,
            combo=combo, btb=btb, hold=hold, base=(mptr - self.min_mptr) // 4,
            rows=rows, parent=parent,
        )

    def first_move(self, base):
        addr = base
        n = self.node(base)
        for _ in range(20):
            parent_off = n["parent"] - self.tree
            if parent_off == addr or parent_off < 0 or parent_off >= len(self.data):
                break
            addr = parent_off
            n = self.node(addr)
        return (n["x"], n["r"], n["m"])

    def key(self, base):
        n = self.node(base)
        f = self.first_move(base)
        return (
            n["score"], f[0], f[1], f[2], n["x"], n["y"], n["r"], n["m"],
            n["act"], n["combo"], n["btb"], n["hold"], n["base"] + 1, n["rows"],
        )


def parse_replica(path):
    gens = []
    cur = None
    for line in open(path):
        line = line.rstrip("\n")
        if line.startswith("BEAM "):
            parts = dict(p.split("=") for p in line.split()[1:])
            cur = {
                "depth": int(parts["depth"]),
                "num": int(parts["num"]),
                "keep": int(parts["keep"]),
                "nodes": [],
            }
            gens.append(cur)
        elif line.startswith("N "):
            f = line.split()
            rows = tuple(int(v) for v in f[16].split(","))
            cur["nodes"].append(
                (int(f[2]), int(f[3]), int(f[4]), int(f[5]), int(f[6]), int(f[7]),
                 int(f[8]), int(f[9]), int(f[10]), int(f[12]), int(f[13]),
                 int(f[14]), int(f[15]), rows)
            )
    return gens


def main():
    tree_path, beams_path = sys.argv[1], sys.argv[2]
    log_path = "/tmp/opencode/oracle/run/tree196.log"
    if "--log" in sys.argv:
        log_path = sys.argv[sys.argv.index("--log") + 1]
    tree = parse_tree_addr(log_path)
    arena = Arena(tree_path, tree)
    gens = parse_replica(beams_path)
    print(f"tree=0x{tree:x} arena={len(arena.data)} bytes gens={len(gens)}")
    failed = False
    for g in gens:
        d = g["depth"]
        keep = g["keep"]
        exe = [arena.key(((d - 1) * GEN_STRIDE + i) * STRIDE) for i in range(keep)]
        rep = g["nodes"]
        idx_diff = sum(1 for a, b in zip(exe, rep) if a != b)
        ce, cr = collections.Counter(exe), collections.Counter(rep)
        mdiff = sum((ce - cr).values()) + sum((cr - ce).values())
        status = "MATCH" if idx_diff == 0 and mdiff == 0 else f"DIFF idx={idx_diff} multiset={mdiff}"
        if status != "MATCH":
            failed = True
        print(f"gen {d:2d}: num={g['num']:5d} keep={keep:4d} {status}")
    print("VERDICT:", "FAIL" if failed else "all generations match")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
