#!/usr/bin/env python3
"""Round 10: prefixP compaction attack.

Base pinned: pfl_r7c1.comp sha256 adc2d9a6... (asserted).
Outputs in CWD:
  pfl_r10fus.comp  variant (results invariant): fused compaction.
                   The two full key scans become one: pass 1 counts
                   cntA/cntB, tracks bestKey/bestIdx (k < T, same
                   ascending order and rule as the base write scan) and
                   packs a 2-bit class per item (2: k > T, 1: k == T,
                   0: k < T) into TABFP scratch at +16384 (lane-private
                   words, 8 per lane; K <= 128 because n <= 8192 by the
                   REPSORD/EVORD capacities). The walk's arm/narrow
                   region is TABFP[0, n) and is dead once compaction
                   runs. Pass 2 reads only the classes and performs the
                   base's writes/captures unchanged. The bestKey pool
                   exchange and lane-0 reduction are NOT touched.
  pfl_r10fr.comp   variant (results invariant): r10fus + the bestKey
                   cross-lane reduction replaced by a subgroupShuffleXor
                   butterfly all-reduce (same total order as the base
                   lane-0 loop: real candidate beats sentinel, max key,
                   tie -> min index). Removes the pool/sOrderPk bestKey
                   writes and the 64-iteration serial loop; barrier
                   positions/count unchanged (p_nextIdxA visibility).
"""
import hashlib
import pathlib

BASE_SHA = "adc2d9a6694f3e721ec00df5243d17b368fb0174271a7bf897209e55f29b4c2e"

src = pathlib.Path("pfl_r7c1.comp").read_text()
digest = hashlib.sha256(src.encode()).hexdigest()
assert digest == BASE_SHA, f"base sha mismatch: {digest}"
print(f"base sha256 OK {digest[:12]}")
lines = src.split("\n")

# ---- locate the merged compaction block ----
start_hits = [i for i, l in enumerate(lines)
              if l == "  // ---- merged compaction: one count scan, one write scan ----"]
assert len(start_hits) == 1, f"compaction anchor hits {len(start_hits)}"
start = start_hits[0]
end = None
for i in range(start, len(lines)):
    if lines[i] == "  if (ev && lane == 0u) {":
        end = i
        break
assert end is not None, "ev stamp anchor not found"
block = "\n".join(lines[start:end])
for probe in ("subgroupInclusiveAdd(cntA)", "ST_PFXSZ", "sOrderPk[lane] = bestIdx;"):
    assert probe in block, f"compaction block missing: {probe}"
assert lines[end - 1] == "  barrier();", f"block tail is {lines[end-1]!r}"

LANE0_BLOCK = """  if (lane == 0u) {
    state.u[STATS + ST_PFXSZ] = totA + need;
    state.u[STATS + ST_NGT] = totA;
    if (p_nextIdxA != 0xFFFFFFFFu) {
      state.u[STATS + ST_NKEYLO] = uint(T);
      state.u[STATS + ST_NKEYHI] = uint(T >> 32);
      state.u[STATS + ST_NIDX] = p_nextIdxA;
      state.u[STATS + ST_HASNEXT] = 1u;
    } else {
      uint bi = 0xFFFFFFFFu;
      uint64_t bk2 = 0ul;
      for (uint l = 0u; l < 64u; l++) {
        uint ix = sOrderPk[l];
        if (ix == 0xFFFFFFFFu) continue;
        uint64_t kk = (uint64_t(pool[320u + l]) << 32) | uint64_t(pool[256u + l]);
        if (bi == 0xFFFFFFFFu || kk > bk2 || (kk == bk2 && ix < bi)) { bk2 = kk; bi = ix; }
      }
      if (bi != 0xFFFFFFFFu) {
        state.u[STATS + ST_NKEYLO] = uint(bk2);
        state.u[STATS + ST_NKEYHI] = uint(bk2 >> 32);
        state.u[STATS + ST_NIDX] = bi;
        state.u[STATS + ST_HASNEXT] = 1u;
      } else {
        state.u[STATS + ST_HASNEXT] = 0u;
      }
    }
  }"""
assert LANE0_BLOCK in block, "lane-0 block text mismatch"

FUS_HEAD = """  // ---- r10fus: one key scan; 2-bit classes staged in TABFP scratch ----
  uint K = (n + 63u) / 64u;
  uint lo = lane * K;
  uint hi = min(n, lo + K);
  uint cntA = 0u, cntB = 0u;
  uint64_t bestKey = 0ul;
  uint bestIdx = 0xFFFFFFFFu;
  uint clsW = 0u;
  for (uint i = lo; i < hi; i++) {
    uint64_t k = selKeyOf(keysOff, i);
    uint c = 0u;
    if (k > T) { cntA++; c = 2u; }
    else if (k == T) { cntB++; c = 1u; }
    else if (bestIdx == 0xFFFFFFFFu || k > bestKey) { bestKey = k; bestIdx = i; }
    uint t = i - lo;
    clsW |= c << (2u * (t & 15u));
    if ((t & 15u) == 15u || i + 1u == hi) {
      state.u[TABFP + 16384u + lane * 8u + (t >> 4)] = clsW;
      clsW = 0u;
    }
  }
  pool[256u + lane] = subgroupInclusiveAdd(cntA);
  pool[320u + lane] = subgroupInclusiveAdd(cntB);
  uint offA = pool[256u + lane] - cntA;
  uint offB = pool[320u + lane] - cntB;
  uint totA = pool[256u + 63u];
  barrier();
  uint wA = offA, rB = offB;
  uint curW = 0u;
  for (uint i = lo; i < hi; i++) {
    uint t = i - lo;
    if ((t & 15u) == 0u) curW = state.u[TABFP + 16384u + lane * 8u + (t >> 4)];
    uint c = (curW >> (2u * (t & 15u))) & 3u;
    if (c == 2u) {
      state.u[PREFIXB + wA] = selIdOf(ev, i);
      state.u[PFXIDX + wA] = i;
      wA++;
    } else if (c == 1u) {
      if (rB == need - 1u) p_tauIdx = i;
      if (rB < need) {
        state.u[PREFIXB + totA + rB] = selIdOf(ev, i);
        state.u[PFXIDX + totA + rB] = i;
      }
      if (rB == need) p_nextIdxA = i;
      rB++;
    }
  }
  pool[256u + lane] = uint(bestKey);
  pool[320u + lane] = uint(bestKey >> 32);
  sOrderPk[lane] = bestIdx;
  barrier();
"""

fus_text = "\n".join(lines[:start]) + "\n" + FUS_HEAD + LANE0_BLOCK + "\n  barrier();\n" + "\n".join(lines[end:])
pathlib.Path("pfl_r10fus.comp").write_text(fus_text)
print("wrote pfl_r10fus.comp")

# ---- fr: fus + shuffle all-reduce for bestKey ----
fl = fus_text.split("\n")
seg_hits = [i for i, l in enumerate(fl) if l == "  pool[256u + lane] = uint(bestKey);"]
assert len(seg_hits) == 1, f"fr seg anchor hits {len(seg_hits)}"
seg = seg_hits[0]
l0 = None
for i in range(seg, len(fl)):
    if fl[i] == "  if (lane == 0u) {":
        l0 = i
        break
assert l0 is not None
tail = None
for i in range(l0, len(fl)):
    if fl[i] == "  barrier();":
        tail = i
        break
assert tail is not None

FR_SEG = """  uint bkLo = uint(bestKey);
  uint bkHi = uint(bestKey >> 32);
  uint bIdx = bestIdx;
  for (uint off = 32u; off > 0u; off >>= 1) {
    uint oLo = subgroupShuffleXor(bkLo, off);
    uint oHi = subgroupShuffleXor(bkHi, off);
    uint oIx = subgroupShuffleXor(bIdx, off);
    if (oIx != 0xFFFFFFFFu && (bIdx == 0xFFFFFFFFu || oHi > bkHi || (oHi == bkHi && (oLo > bkLo || (oLo == bkLo && oIx < bIdx))))) {
      bkLo = oLo; bkHi = oHi; bIdx = oIx;
    }
  }
  barrier();
  if (lane == 0u) {
    state.u[STATS + ST_PFXSZ] = totA + need;
    state.u[STATS + ST_NGT] = totA;
    if (p_nextIdxA != 0xFFFFFFFFu) {
      state.u[STATS + ST_NKEYLO] = uint(T);
      state.u[STATS + ST_NKEYHI] = uint(T >> 32);
      state.u[STATS + ST_NIDX] = p_nextIdxA;
      state.u[STATS + ST_HASNEXT] = 1u;
    } else if (bIdx != 0xFFFFFFFFu) {
      state.u[STATS + ST_NKEYLO] = bkLo;
      state.u[STATS + ST_NKEYHI] = bkHi;
      state.u[STATS + ST_NIDX] = bIdx;
      state.u[STATS + ST_HASNEXT] = 1u;
    } else {
      state.u[STATS + ST_HASNEXT] = 0u;
    }
  }
  barrier();"""

fr_text = "\n".join(fl[:seg]) + "\n" + FR_SEG + "\n" + "\n".join(fl[tail + 1:])
pathlib.Path("pfl_r10fr.comp").write_text(fr_text)
print("wrote pfl_r10fr.comp")
print("gen_r10 done")
