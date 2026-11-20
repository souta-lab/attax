#!/usr/bin/env python3
"""Round-10B attack on emitOrderPX (~324 us/dec, PERSISTENT-R6
sec. 10-B.3) on the pfl_r7c1 base. All transforms are anchored
replacements inside the emitOrderPX function body only.

Sizing probes (idempotent, drill must PASS; delta = direct cost):
  r10edblP1  : count segment (loop + subgroup scans + lane0 count
               writes) executed twice with dummy accumulators.
               Delta = pass 1 cost.
  r10edblFan : WG0 fan-in block duplicated verbatim (same-value
               writes). Delta = fan-in cost.
  r10edblP2  : scatter loop duplicated with a second offset
               (identical REPSGEN writes). Delta = pass 2 cost.

Variants (result-invariant; drill must PASS, VGPR <= 120 to bench):
  r10eflag   : pass 1 evaluates the representative test once and
               packs the verdict into SLOTOF: bit30 = representative
               (slot is 14 bits, sentinel is 0xFFFFFFFF), dead
               children get tombstone 0xFFFFFFFE (a value dedupeA
               never writes). Pass 2 then reads SLOTOF only -- the
               tabord / TABMETA / recOrdU / childDead re-reads are
               gone. SLOTOF readers are only dedupeB (before the
               X1 gbar, i.e. before this packing) and emitOrderPX
               itself; both gate on childDead and only consume
               values dedupeA wrote this ply for live children.
  r10efan    : WG0 fan-in O(e) serial global-read loop replaced by
               two subgroup inclusive scans (rows lane / lane+64).
               Same integer sums, same EO_ROFF / STATS writes.
  r10eall    : eflag + efan.

Usage: gen_r10b.py (writes pfl_r10e*.comp in cwd)
"""
import hashlib

BASE = "pfl_r7c1.comp"
EXPECT = "adc2d9a6694f3e721ec00df5243d17b368fb0174271a7bf897209e55f29b4c2e"

raw = open(BASE, "rb").read()
got = hashlib.sha256(raw).hexdigest()
assert got == EXPECT, f"base sha mismatch: {got}"
text = raw.decode()


def emit(name, t):
    open(name, "w").write(t)
    data = t.encode()
    print(name, len(data), hashlib.sha256(data).hexdigest())


def rep1(t, old, new, what):
    assert t.count(old) == 1, f"anchor {what}: count {t.count(old)}"
    return t.replace(old, new, 1)


# ---- extract the emitOrderPX function span ----
FSTART = "bool emitOrderPX(uint ply, inout uint bk) {"
FEND = "\n// ---- repsOrd cache + min/max (sel_cache2 form) ----"
assert text.count(FSTART) == 1 and text.count(FEND) == 1
fi = text.index(FSTART)
fj = text.index(FEND)
fn = text[fi:fj]
assert fn.count("return false;") == 1


def splice(newfn, fan_decl=False):
    t = text[:fi] + newfn + text[fj:]
    if fan_decl:
        t = rep1(t, "shared uint eo_b[64];",
                 "shared uint eo_b[64];\n"
                 "shared uint eo_tR;\n"
                 "shared uint eo_tA;",
                 "eo_t decl")
    return t


def frep(old, new, what):
    assert fn.count(old) == 1, f"fn anchor {what}: count {fn.count(old)}"
    return fn.replace(old, new, 1)


COUNT_LOOP = """  uint myRep = 0u, myAlive = 0u;
  for (uint coff = lo; coff < hi; coff++) {
    uint child = childBase + coff;
    if (childDead(child)) continue;
    myAlive++;
    uint slot = state.u[SLOTOF + coff];
    if (slot == 0xFFFFFFFFu) continue;
    if (recOrdU(child) == tabord.v[slot] && coff == state.u[TABMETA + 2u * slot]) myRep++;
  }"""

SCAN_SEG = """  eo_a[lane] = subgroupInclusiveAdd(myRep);
  eo_b[lane] = subgroupInclusiveAdd(myAlive);
  barrier();
  if (lane == 0u) {
    state.u[EO_REPC + wg] = eo_a[63];
    state.u[EO_ALVC + wg] = eo_b[63];
  }"""

SEG1 = COUNT_LOOP + "\n" + SCAN_SEG

FANIN = """  if (wg == 0u) {
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

SCATTER = """  uint off = state.u[EO_ROFF + wg] + eo_a[lane] - myRep;
  for (uint coff = lo; coff < hi; coff++) {
    uint child = childBase + coff;
    if (childDead(child)) continue;
    uint slot = state.u[SLOTOF + coff];
    if (slot == 0xFFFFFFFFu) continue;
    if (recOrdU(child) == tabord.v[slot] && coff == state.u[TABMETA + 2u * slot])
      state.u[REPSGEN + off++] = child;
  }"""

for name, anchor in [("SEG1", SEG1), ("FANIN", FANIN), ("SCATTER", SCATTER)]:
    assert fn.count(anchor) == 1, f"anchor {name}: count {fn.count(anchor)}"

# =====================================================================
# dblP1: count segment twice (dummy accumulators, same-value writes)
# =====================================================================
seg1d = SEG1.replace("myRep", "myRepD").replace("myAlive", "myAliveD")
# the dummy segment must not clobber eo_a/eo_b semantics: it recomputes
# the same values, so overwriting eo_a/eo_b with them is a no-op.
emit("pfl_r10edblP1.comp", splice(frep(
    SEG1, SEG1 + "\n" + seg1d + " // R10B PROBE dblP1: count segment twice",
    "dblP1")))

# =====================================================================
# dblFan: fan-in block twice (verbatim, same-value writes)
# =====================================================================
emit("pfl_r10edblFan.comp", splice(frep(
    FANIN, FANIN + "\n" + FANIN + " // R10B PROBE dblFan: fan-in twice",
    "dblFan")))

# =====================================================================
# dblP2: scatter loop twice (second offset, identical writes)
# =====================================================================
scat2 = SCATTER.replace("uint off =", "uint off2 =", 1).replace(
    "REPSGEN + off++", "REPSGEN + off2++", 1)
emit("pfl_r10edblP2.comp", splice(frep(
    SCATTER, SCATTER + "\n" + scat2 + " // R10B PROBE dblP2: scatter twice",
    "dblP2")))

# =====================================================================
# eflag: pass 1 packs the verdict into SLOTOF; pass 2 reads SLOTOF only
# =====================================================================
COUNT_EFLAG = """  uint myRep = 0u, myAlive = 0u;
  for (uint coff = lo; coff < hi; coff++) {
    uint child = childBase + coff;
    if (childDead(child)) { state.u[SLOTOF + coff] = 0xFFFFFFFEu; continue; }
    myAlive++;
    uint slot = state.u[SLOTOF + coff];
    if (slot == 0xFFFFFFFFu) continue;
    if (recOrdU(child) == tabord.v[slot] && coff == state.u[TABMETA + 2u * slot]) {
      myRep++;
      state.u[SLOTOF + coff] = slot | 0x40000000u;
    }
  }"""

SCATTER_EFLAG = """  uint off = state.u[EO_ROFF + wg] + eo_a[lane] - myRep;
  for (uint coff = lo; coff < hi; coff++) {
    uint s = state.u[SLOTOF + coff];
    if (s == 0xFFFFFFFEu || s == 0xFFFFFFFFu) continue;
    if ((s & 0x40000000u) != 0u)
      state.u[REPSGEN + off++] = childBase + coff;
  }"""


def apply_eflag(f):
    f = f.replace(COUNT_LOOP, COUNT_EFLAG, 1)
    f = f.replace(SCATTER, SCATTER_EFLAG, 1)
    return f


assert apply_eflag(fn) != fn
emit("pfl_r10eflag.comp", splice(apply_eflag(fn)))

# =====================================================================
# efan: fan-in as two subgroup inclusive scans
# =====================================================================
FANIN_EFAN = """  if (wg == 0u) {
    // R10B efan: fan-in as two subgroup scans (was: per-lane O(e)
    // serial global-read loop, r6g1 form). Same integer sums, same
    // EO_ROFF / STATS writes. nwg <= 128 as before (EO scratch).
    uint vR0 = lane < nwg ? state.u[EO_REPC + lane] : 0u;
    uint vA0 = lane < nwg ? state.u[EO_ALVC + lane] : 0u;
    uint sR0 = subgroupInclusiveAdd(vR0);
    uint sA0 = subgroupInclusiveAdd(vA0);
    if (lane == 63u) { eo_tR = sR0; eo_tA = sA0; }
    barrier();
    uint tR0 = eo_tR, tA0 = eo_tA;
    if (lane < nwg) state.u[EO_ROFF + lane] = sR0 - vR0;
    uint e2 = lane + 64u;
    uint vR1 = e2 < nwg ? state.u[EO_REPC + e2] : 0u;
    uint vA1 = e2 < nwg ? state.u[EO_ALVC + e2] : 0u;
    uint sR1 = subgroupInclusiveAdd(vR1);
    uint sA1 = subgroupInclusiveAdd(vA1);
    if (e2 < nwg) state.u[EO_ROFF + e2] = tR0 + sR1 - vR1;
    if (lane == 63u) {
      state.u[STATS + ST_NREPS] = tR0 + sR1;
      state.u[STATS + ST_NALIVE] = tA0 + sA1;
    }
  }"""

emit("pfl_r10efan.comp", splice(frep(FANIN, FANIN_EFAN, "efan"),
                                fan_decl=True))

# =====================================================================
# eall: eflag + efan
# =====================================================================
fn_all = apply_eflag(fn)
assert fn_all.count(FANIN) == 1
fn_all = fn_all.replace(FANIN, FANIN_EFAN, 1)
emit("pfl_r10eall.comp", splice(fn_all, fan_decl=True))

print("gen_r10b done")
