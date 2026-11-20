#!/usr/bin/env python3
"""Round-6 integration, second stack: bt1 + bh1 + ba1 regenerated
on the adopted pfl_r6g1 base (= pfl_r4tk1 + the emitOrderPX
fan-in fix, operating point G=72; adoption in PERSISTENT-R6
section 6, variant in PERSISTENT-R6-GCEIL-2026-11-20.md).

  pfl_r6int2.comp     - r6g1 base + bt1 + ba1 + bh1

Same transforms and verification discipline as gen_r6int1.py
(anchor-checked, count==1 asserts; composition order
independence asserted over all checked orders; the bt1 applier
re-verified against the shipped pfl_r4bt1.comp on the tk1
base), plus two base-specific checks:

  (a) fan-in presence: the r6g1 NEW block occurs exactly once
      in the base and the pre-fix OLD block is absent.
  (b) cross-check: applying the fan-in replacement (OLD->NEW,
      anchor count==1) to the shipped pfl_r6int1.comp must
      reproduce pfl_r6int2.comp byte-exactly. This proves the
      three transforms never touch the fan-in region and the
      hunk survives composition intact -- i.e. int2 differs
      from the gate-passed int1 (PERSISTENT-R6 section 5) by
      exactly the fan-in fix and nothing else.
"""
import difflib
import hashlib
import random
import re

BASE = "pfl_r6g1.comp"
EXPECT = "efc3f169a0cbecf8390c11b586ea226097338af3033dca1996cd659f9ae9a7d5"
TK1 = "pfl_r4tk1.comp"
TK1_EXPECT = "2f4add4a266948cdadb5cba35e8549cab881df4638f8fcda02fd3b730dba4bcc"
INT1 = "pfl_r6int1.comp"
INT1_EXPECT = "ac32354e7df3ae63f64b7ae25f0bc2e2ea56ae2a50c1c30281f5f672ac2f3b34"
BT1_SHIPPED = "pfl_r4bt1.comp"
BT1_EXPECT = "3acaf58a685ef5aa9be3803a0576acc40813a585c3d0b7dc33a025ce34879ee8"

# fan-in hunk, verbatim from gen_r6g1.py
FANIN_OLD = """  if (wg == 0u && lane < nwg) {
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

FANIN_NEW = """  // r6g1: strided fan-in -- 64 lanes cover up to 128 entries
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


def sha(t):
    return hashlib.sha256(t.encode()).hexdigest()


src = open(BASE, "rb").read()
assert hashlib.sha256(src).hexdigest() == EXPECT, "base sha mismatch"
text = src.decode()

tk1_src = open(TK1, "rb").read()
assert hashlib.sha256(tk1_src).hexdigest() == TK1_EXPECT, "tk1 sha mismatch"
tk1_text = tk1_src.decode()

# (a) fan-in presence in the adopted base, and the base must be
# exactly tk1 + the fan-in hunk (diff-level confirmation).
assert text.count(FANIN_NEW) == 1, "fan-in NEW block not unique in base"
assert text.count(FANIN_OLD) == 0, "pre-fix fan-in block still in base"
assert tk1_text.count(FANIN_OLD) == 1, "fan-in OLD block not unique in tk1"
assert tk1_text.replace(FANIN_OLD, FANIN_NEW) == text, \
    "base is not tk1 + fan-in hunk exactly"
print("fan-in check ok: base == tk1 + fan-in hunk (byte-exact)")

# =====================================================================
# Self-check A/B for bh1 (verbatim from gen_r6b.py): 8x8 bit-matrix
# transpose via 3 masked swaps, and block-transpose packing ==
# original packing loop on random boards, len 1..45 (+48,55,63).
# =====================================================================
def swap_masks(p, q):
    d = (1 << q) - (1 << p)
    lo = hi = 0
    for pos in range(64):
        bp, bq = (pos >> p) & 1, (pos >> q) & 1
        if bp == 1 and bq == 0:
            lo |= 1 << pos
        elif bp == 0 and bq == 1:
            hi |= 1 << pos
    return lo, hi, d

STAGES = []
for (p, q) in ((0, 3), (1, 4), (2, 5)):
    lo, hi, d = swap_masks(p, q)
    keep = (~(lo | hi)) & ((1 << 64) - 1)
    STAGES.append((lo, hi, keep, d))

def transpose8(x):
    for lo, hi, keep, d in STAGES:
        x = (x & keep) | ((x & lo) << d) | ((x & hi) >> d)
    return x & ((1 << 64) - 1)

for pos in range(64):
    j, i = pos >> 3, pos & 7
    y = transpose8(1 << pos)
    assert y == 1 << ((i << 3) | j), f"transpose wrong at {pos}"
rng = random.Random(20261120)
for _ in range(2000):
    x = rng.getrandbits(64)
    t = transpose8(x)
    for j in range(8):
        for i in range(8):
            assert ((t >> (8 * i + j)) & 1) == ((x >> (8 * j + i)) & 1)
print("self-check A ok: transpose masks",
      [(hex(lo), hex(hi), d) for lo, hi, _, d in STAGES])

def pack_orig(col, ln):
    rp = [0] * 7
    for r2 in range(40):
        rm = 0
        if r2 < ln:
            lev = ln - 1 - r2
            for j in range(10):
                rm |= ((col[j] >> lev) & 1) << j
        rp[r2 // 6] |= rm << (10 * (r2 % 6))
    return rp

def pack_new(col, ln):
    rp = [0] * 7
    for g in range(5):
        sh = ln - 8 * (g + 1)
        if sh <= -8:
            continue
        chunks = []
        for j in range(10):
            if sh >= 0:
                chunks.append((col[j] >> sh) & 0xFF)
            else:
                chunks.append((col[j] << (-sh)) & 0xFF)
        P = 0
        for j in range(8):
            P |= chunks[j] << (8 * j)
        Q = chunks[8] | (chunks[9] << 8)
        T = transpose8(P)
        T2 = transpose8(Q)
        for i in range(8):
            r2 = 8 * g + 7 - i
            rm = ((T >> (8 * i)) & 0xFF) | (((T2 >> (8 * i)) & 0xFF) << 8)
            rp[r2 // 6] |= rm << (10 * (r2 % 6))
    return rp

for ln in list(range(1, 46)) + [48, 55, 63]:
    for _ in range(60):
        if ln <= 40:
            col = [rng.getrandbits(ln) for _ in range(10)]
        else:
            col = [rng.getrandbits(64) for _ in range(10)]
        assert pack_orig(col, ln) == pack_new(col, ln), f"pack mismatch len={ln}"
print("self-check B ok: block-transpose packing == original (len 1..45,48,55,63)")

# =====================================================================
# GLSL emission helpers for bh1 (verbatim from gen_r6b.py)
# =====================================================================
def glsl_u64(v):
    return "0x%016Xul" % v

TRANSPOSE_FN = """
// r6bh1: 8x8 bit-matrix transpose in a u64 (masked swaps;
// masks derived and verified in gen_r6b.py).
uint64_t transpose8x8(uint64_t x) {
%s
    return x;
}
"""
lines = []
for lo, hi, keep, d in STAGES:
    lines.append(
        "    x = (x & %s) | ((x & %s) << %du) | ((x & %s) >> %du);"
        % (glsl_u64(keep), glsl_u64(lo), d, glsl_u64(hi), d))
TRANSPOSE_FN = TRANSPOSE_FN % "\n".join(lines)

def bh1_block(g):
    """GLSL for one 8-row block (rows 8g..8g+7)."""
    out = []
    out.append("        { int sh = len - %d;" % (8 * (g + 1)))
    out.append("          if (sh > -8) {")
    for j in range(10):
        out.append(
            "            uint64_t B%d_%d = sh >= 0 ? ((col[%d] >> uint(sh)) & 0xFFul)"
            " : ((col[%d] << uint(-sh)) & 0xFFul);" % (g, j, j, j))
    p = " | ".join("(B%d_%d << %du)" % (g, j, 8 * j) if j else "B%d_0" % g
                   for j in range(8))
    out.append("            uint64_t P = %s;" % p)
    out.append("            uint64_t Q = B%d_8 | (B%d_9 << 8u);" % (g, g))
    out.append("            uint64_t T = transpose8x8(P);")
    out.append("            uint64_t T2 = transpose8x8(Q);")
    for i in range(8):
        r2 = 8 * g + 7 - i
        out.append(
            "            rp%d |= ((T >> %du) & 0xFFul | (((T2 >> %du) & 0xFFul) << 8))"
            " << %du;" % (r2 // 6, 8 * i, 8 * i, 10 * (r2 % 6)))
    out.append("          } }")
    return "\n".join(out)

def rep1(t, old, new, what):
    assert t.count(old) == 1, f"anchor {what}: count {t.count(old)}"
    return t.replace(old, new)

def emit(name, t):
    open(name, "w").write(t)
    print(name, len(t.encode()), sha(t))

# =====================================================================
# ba1 transform (from gen_r6b.py, function form)
# =====================================================================
def apply_ba1(t):
    # (ii) wall: sWallPk staging -> subgroupBallot
    t = rep1(t, "    if (l < 2u) sWallPk[l] = 0u;\n", "", "sWallPk zeroing")
    t = rep1(t, "    if (wall) atomicOr(sWallPk[l >> 5], 1u << (l & 31u));",
             "    uint64_t wallBits = packUint2x32(subgroupBallot(wall).xy);  // r6ba1 A2",
             "sWallPk atomicOr")
    t = rep1(t, """    uint wallPk0 = sWallPk[0], wallPk1 = sWallPk[1];
    uint wallR = r == 0 ? (wallPk0 & 0xFFFFu) : r == 1 ? (wallPk0 >> 16) : r == 2 ? (wallPk1 & 0xFFFFu) : (wallPk1 >> 16);""",
             "    uint wallR = uint((wallBits >> uint(r << 4)) & 0xFFFFul);",
             "wallR derivation")
    # (i) per-term branch -> clamp + value mask (15 terms)
    term_re = re.compile(
        r"uint64_t (t\d) = 0ul; \{ int c = sxi \+ (kx\d); uint w = 0u;\s*"
        r"if \(c >= 0 && c < 16\) \{ \1 = fitGet\(uint\(\(r << 4\) \| c\)\);"
        r" w = \(wallR >> uint\(c\)\) & 1u; \}\s*"
        r"\1 = shlS\(\1, (ky\d)\); if \(\3 > 0 && w != 0u\) \1 \|= \(1ul << uint\(\3\)\) - 1ul; \}")

    def term_sub(m):
        tv, kx, ky = m.group(1), m.group(2), m.group(3)
        return ("uint64_t %s = 0ul; { int c = sxi + %s; int cl = clamp(c, 0, 15);\n"
                "                uint64_t tf = fitGet(uint((r << 4) | cl));"
                " uint w = (wallR >> uint(cl)) & 1u;\n"
                "                tf = shlS(tf, %s); if (%s > 0 && w != 0u)"
                " tf |= (1ul << uint(%s)) - 1ul;\n"
                "                %s = (c >= 0 && c < 16) ? tf : 0ul; }"
                % (tv, kx, ky, ky, ky, tv))

    t, nterms = term_re.subn(term_sub, t)
    assert nterms == 15, f"construction terms replaced: {nterms} != 15"
    # (iii) seed rk -> running counter
    t = rep1(t, "            uint idx = Fpre;\n            while (m != 0ul) {",
             "            uint idx = Fpre;\n            uint cIdx = 0u;\n            while (m != 0ul) {",
             "seed walk cIdx decl")
    t = rep1(t, "uint rk = Fpre + (y == 63u ? 0u : popc64(F >> (y + 1u)));",
             "uint rk = Fpre + (cnt - 1u - cIdx);  // r6ba1 A3",
             "seed rk popc")
    t = rep1(t, "                if (rk < 512u) ordSet(rk, (l << 6) | y); else sErr = 1u;\n                idx++;",
             "                if (rk < 512u) ordSet(rk, (l << 6) | y); else sErr = 1u;\n                idx++; cIdx++;",
             "seed walk cIdx++")
    return t

# =====================================================================
# bh1 transform (from gen_r6b.py, function form)
# =====================================================================
def apply_bh1(t):
    ROW_MASK_TAIL = """    m |= uint((c9 >> level) & 1ul) << 9;
    return m;
}
"""
    t = rep1(t, ROW_MASK_TAIL, ROW_MASK_TAIL + TRANSPOSE_FN, "transpose fn insertion")
    pstart = t.index("        uint64_t rp0 = 0ul, rp1 = 0ul, rp2 = 0ul, rp3 = 0ul, rp4 = 0ul, rp5 = 0ul, rp6 = 0ul;")
    pend = t.index("        uint64_t hh = (uint64_t(0x14650FB0u)")
    old_loop = t[pstart:pend]
    assert "for (int r2 = 0; r2 < 40; r2++)" in old_loop and "row_mask10" in old_loop
    new_pack = ("        uint64_t rp0 = 0ul, rp1 = 0ul, rp2 = 0ul, rp3 = 0ul,"
                " rp4 = 0ul, rp5 = 0ul, rp6 = 0ul;\n"
                "        // r6bh1: 8-row block transpose packing (bit-identical;\n"
                "        // verified against the row_mask10 loop in gen_r6b.py).\n"
                + "\n".join(bh1_block(g) for g in range(5)) + "\n")
    return t[:pstart] + new_pack + t[pend:]

# =====================================================================
# bt1 transform (from gen_r4bt1.py, function form): line-level diff
# hunks between pfl_r3n2.comp and pfl_r3bt1.comp, applied to the
# target by exact text matching with 3 lines of context.
# =====================================================================
CTX = 3
_n2 = open("pfl_r3n2.comp").read().splitlines(keepends=True)
_bt = open("pfl_r3bt1.comp").read().splitlines(keepends=True)
print("bt1 sources: pfl_r3n2.comp", sha("".join(_n2)),
      "/ pfl_r3bt1.comp", sha("".join(_bt)))

def apply_bt1(tgt):
    sm = difflib.SequenceMatcher(a=_n2, b=_bt, autojunk=False)
    raw = [(i1, i2, j1, j2) for tag, i1, i2, j1, j2 in sm.get_opcodes()
           if tag != "equal"]
    clusters = []
    for h in raw:
        if clusters and h[0] - clusters[-1][1] <= 2 * CTX:
            p = clusters[-1]
            clusters[-1] = (p[0], h[1], p[2], h[3])
        else:
            clusters.append(h)
    hunks = []
    for i1, i2, j1, j2 in clusters:
        a1, a2 = max(0, i1 - CTX), min(len(_n2), i2 + CTX)
        b1, b2 = max(0, j1 - CTX), min(len(_bt), j2 + CTX)
        old = "".join(_n2[a1:a2])
        new = "".join(_bt[b1:b2])
        assert tgt.count(old) == 1, "bt1 hunk not unique: " + old[:60]
        tgt = tgt.replace(old, new, 1)
        hunks.append((a2 - a1, b2 - b1))
    return tgt, hunks

# =====================================================================
# Compose on the r6g1 base. Order-independence is asserted, not
# assumed: the three anchor sets are disjoint, so every order
# must agree byte-exactly.
# =====================================================================
t_ba = apply_ba1(text)
t_bh = apply_bh1(text)
t_bt, hunks0 = apply_bt1(text)

# bt1 applier re-verification on the tk1 base (as in gen_r6int1):
shipped = open(BT1_SHIPPED).read()
assert sha(shipped) == BT1_EXPECT, "shipped bt1 sha mismatch"
t_bt_tk1, _ = apply_bt1(tk1_text)
assert t_bt_tk1 == shipped, "bt1 applier does not reproduce shipped pfl_r4bt1.comp"
print("bt1 applier verified on tk1 base: reproduces pfl_r4bt1.comp, hunks:", hunks0)

t_babh = apply_bh1(t_ba)
assert t_babh == apply_ba1(t_bh), "ba1/bh1 order dependence"
t_btba, _ = apply_bt1(t_ba)
assert t_btba == apply_ba1(t_bt), "bt1/ba1 order dependence"
t_btbh, _ = apply_bt1(t_bh)
assert t_btbh == apply_bh1(t_bt), "bt1/bh1 order dependence"
t_int, hunks = apply_bt1(t_babh)
assert t_int == apply_ba1(apply_bh1(t_bt)), "full-stack order dependence (ba last)"
assert t_int == apply_bh1(apply_ba1(t_bt)), "full-stack order dependence (bh last)"
print("order independence verified for all checked compositions; bt1 hunks:", hunks)

# (b) cross-check: int2 must be exactly int1 + the fan-in hunk.
int1_src = open(INT1, "rb").read()
assert hashlib.sha256(int1_src).hexdigest() == INT1_EXPECT, "int1 sha mismatch"
int1_text = int1_src.decode()
assert int1_text.count(FANIN_OLD) == 1, "fan-in OLD not unique in int1"
assert int1_text.count(FANIN_NEW) == 0, "fan-in NEW already in int1"
assert int1_text.replace(FANIN_OLD, FANIN_NEW) == t_int, \
    "int2 != int1 + fan-in hunk (transforms touched the fan-in region?)"
assert t_int.count(FANIN_NEW) == 1 and t_int.count(FANIN_OLD) == 0, \
    "fan-in hunk not intact in int2"
print("cross-check ok: pfl_r6int2 == pfl_r6int1 + fan-in hunk (byte-exact)")

emit("pfl_r6int2.comp", t_int)
print("gen_r6int2 done")
