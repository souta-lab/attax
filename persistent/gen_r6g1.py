#!/usr/bin/env python3
# gen_r6g1.py -- pfl_r4tk1.comp -> pfl_r6g1.comp
#
# r6g1: fix the persistent form's G ceiling (round 6-A diagnosis,
# PERSISTENT-R6-GCEIL-2026-11-20.md). emitOrderPX's WG0 prefix
# fan-in assumed nwg <= 64: one lane per WG entry, totals
# published by lane nwg-1. The kernel has local_size_x = 64, so
# for nwg >= 65 entries 64..nwg-1 never get their EO_ROFF and
# the publishing lane does not exist: ST_NREPS / ST_NALIVE keep
# resetScratch's 0, main() reads nReps == 0 and skips the whole
# B&B + sort for every ply. Verify signature at G = 72/84/96
# (both r4tk1 and r4bt1, whose emitOrderPX text is identical):
# dec7 has exactly 14 plies -> alive/reps/eval/evalset/sel each
# 14; pos/arena = 1316 = total selections over those plies;
# all BPX-side checks 0. The EO scratch layout itself supports
# nwg <= 128 (EO_REPC / EO_ALVC / EO_ROFF are 128 entries each
# inside REPSORD[0..384)); only the fan-in loop was capped.
#
# Fix (dimension side only): WG0's lanes cover the nwg entries
# strided -- lane l takes entries l, l+64, ... -- and the lane
# handling entry nwg-1 publishes the totals. For nwg <= 64 the
# entry->lane mapping and the (ascending, exact uint) summation
# order are unchanged, so the variant is bit-identical to the
# base at the current operating points; for 65 <= nwg <= 128
# the second iteration of lanes 0..nwg-65 covers the rest, all
# before the gbar that already follows the block. Drill + full
# gate are the judges.
#
# Base is pinned by sha256 (usage: gen_r6g1.py <base.comp>).
import hashlib
import sys

BASES = {
    "2f4add4a266948cdadb5cba35e8549cab881df4638f8fcda02fd3b730dba4bcc":
        "pfl_r4tk1.comp",
}
DST = "pfl_r6g1.comp"

SRC = sys.argv[1]
raw = open(SRC, "rb").read()
got = hashlib.sha256(raw).hexdigest()
assert got in BASES and BASES[got] == SRC, \
    f"base sha/name mismatch: {SRC} {got}"
src = raw.decode()

OLD = """  if (wg == 0u && lane < nwg) {
    uint r = 0u, a = 0u;
    for (uint w = 0u; w < lane; w++) {
      r += state.u[EO_REPC + w];
      a += state.u[EO_ALVC + w];
    }
    state.u[EO_ROFF + lane] = r;
    if (lane == nwg - 1u) {
      state.u[STATS + ST_NREPS] = r + state.u[EO_REPC + nwg - 1u];
      state.u[STATS + ST_NALIVE] = a + state.u[EO_ALVC + nwg - 1u];
    }
  }"""

NEW = """  // r6g1: strided fan-in -- 64 lanes cover up to 128 entries
  // (EO scratch layout limit). nwg <= 64: same mapping and
  // summation order as the original one-lane-per-entry form.
  if (wg == 0u) {
    for (uint e = lane; e < nwg; e += 64u) {
      uint r = 0u, a = 0u;
      for (uint w = 0u; w < e; w++) {
        r += state.u[EO_REPC + w];
        a += state.u[EO_ALVC + w];
      }
      state.u[EO_ROFF + e] = r;
      if (e == nwg - 1u) {
        state.u[STATS + ST_NREPS] = r + state.u[EO_REPC + e];
        state.u[STATS + ST_NALIVE] = a + state.u[EO_ALVC + e];
      }
    }
  }"""

assert src.count(OLD) == 1, f"anchor count {src.count(OLD)}"
out = src.replace(OLD, NEW)
open(DST, "w").write(out)
print("wrote", DST, "lines(wc)", out.count("\n"),
      "sha256", hashlib.sha256(out.encode()).hexdigest())
