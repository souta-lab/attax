#!/usr/bin/env python3
# gen_r7cons.py -- pfl_r6int2.comp -> pfl_r7c1.comp
#
# Round 7: construction (M[k]=0-ization) term-work reduction.
# In the HP3 hand-unrolled construction, term (i,j) of family
# kb is F(c, ky_j) with c = xi + kx_j - kx_i: it depends on
# (i,j) only through (cOff = kx_j - kx_i, ky_j). Over the
# real KX/KY/KN tables (tables.glsl, verified identical on
# VM transcription and PC), an nk=5 family computes 15 terms
# but only 7-8 distinct (cOff, ky) values and 3-5 distinct
# fit loads exist. This generator replaces the construction
# loop with f-unrolled, per-kb specialized cases that compute
# each distinct term value once, with ky as a compile-time
# constant (shlS folds to a single shift / identity; 67% of
# terms have ky == 0). No plan table, no active-kick
# compaction (both closed directions). Outputs (M, NK,
# g_srcPkA/B, g_dyPk) are bit-identical: the generator proves
# it by simulating the original loop form and the specialized
# form over all (cls, rots1, r, xi) x edge+random fit/wall
# patterns before writing the file.
#
# Base pinned by sha256.
import hashlib
import random
import re

BASE = "pfl_r6int2.comp"
EXPECT = "f005f4322daaf4dda08cd0bc3ac9ef4237242caca3d72e01ce7d0b1aed1150bf"
DST = "pfl_r7c1.comp"
TABLES = "/home/hatch/workspace/attax-gpu-spike/opus-phase2/bpg/tables.glsl"

raw = open(BASE, "rb").read()
got = hashlib.sha256(raw).hexdigest()
assert got == EXPECT, f"base sha mismatch: {got}"
lines = raw.decode().split("\n")


def load_tables(path):
    txt = open(path).read()
    out = {}
    for name in ("KX", "KY", "KN"):
        m = re.search(name + r"\[\d+\] = int\[\]\(([^)]*)\)", txt)
        out[name] = [int(x) for x in m.group(1).split(",")]
    return out


T = load_tables(TABLES)
KX, KY, KN = T["KX"], T["KY"], T["KN"]
assert len(KX) == 120 and len(KY) == 120 and len(KN) == 24
MASK64 = (1 << 64) - 1
OFFS = [1, 3, 2]  # f -> off, from the original loop


def shlS(m, s):
    return ((m << max(s, 0)) & MASK64) >> max(-s, 0)


def termF(c, s, fit, wallR):
    cl = min(max(c, 0), 15)
    tf = shlS(fit[cl], s)
    if s > 0 and ((wallR >> cl) & 1) != 0:
        tf |= (1 << s) - 1
    return tf if 0 <= c < 16 else 0


def sim_orig(cls, rots1, r, xi, fit, wallR):
    M = [0] * 15
    NKv = [0] * 3
    srcA = srcB = 0
    dy = 0x4444444444444444
    for f in range(3):
        pr = (r - OFFS[f]) & 3
        kb = ((cls * 3 + f) * 4 + pr)
        nk = 0 if rots1 else KN[kb]
        NKv[f] = nk
        kx = KX[kb * 5:kb * 5 + 5]
        ky = KY[kb * 5:kb * 5 + 5]
        for i in range(5):
            k = f * 5 + i
            if i >= nk:
                continue
            dy = (dy & ~(0xF << (k * 4))) | ((ky[i] + 4) << (k * 4))
            sxi = xi - kx[i]
            if 0 <= sxi < 16:
                sv = ((pr << 4) | sxi) + 1
                if k < 9:
                    srcA |= sv << (k * 7)
                else:
                    srcB |= sv << ((k - 9) * 7)
                ts = [termF(sxi + kx[j], ky[j], fit, wallR)
                      for j in range(i + 1)]
                acc = 0
                for j in range(i):
                    acc |= ts[j]
                M[k] = ts[i] & ~acc & MASK64
    return M, NKv, srcA, srcB, dy


# ---- specialized case data, per kb -------------------------------
def case_data(kb):
    kx = KX[kb * 5:kb * 5 + 5]
    ky = KY[kb * 5:kb * 5 + 5]
    nk = KN[kb]
    loads = sorted({kx[j] - kx[i]
                    for i in range(nk) for j in range(i + 1)})
    pairs = {}
    for i in range(nk):
        for j in range(i + 1):
            key = (kx[j] - kx[i], ky[j])
            if key not in pairs:
                pairs[key] = len(pairs)
    return {"kx": kx, "ky": ky, "nk": nk, "loads": loads,
            "pairs": pairs}


CASES = {kb: case_data(kb) for kb in range(24)}


def sim_spec(cls, rots1, r, xi, fit, wallR):
    M = [0] * 15
    NKv = [0] * 3
    srcA = srcB = 0
    dy = 0x4444444444444444
    for f in range(3):
        pr = (r - OFFS[f]) & 3
        kb = ((cls * 3 + f) * 4 + pr)
        nk = 0 if rots1 else KN[kb]
        NKv[f] = nk
        if nk == 0:
            continue
        cd = CASES[kb]
        assert cd["nk"] == nk
        kx, ky = cd["kx"], cd["ky"]
        for i in range(nk):
            k = f * 5 + i
            dy = (dy & ~(0xF << (k * 4))) | ((ky[i] + 4) << (k * 4))
        fv = {}
        wv = {}
        for cOff in cd["loads"]:
            c = xi + cOff
            cl = min(max(c, 0), 15)
            fv[cOff] = fit[cl]
            wv[cOff] = (wallR >> cl) & 1
        u = {}
        for (cOff, s), idx in cd["pairs"].items():
            c = xi + cOff
            tf = shlS(fv[cOff], s)
            if s > 0 and wv[cOff] != 0:
                tf |= (1 << s) - 1
            u[idx] = tf if 0 <= c < 16 else 0
        for i in range(nk):
            k = f * 5 + i
            sxi = xi - kx[i]
            if 0 <= sxi < 16:
                sv = ((pr << 4) | sxi) + 1
                if k < 9:
                    srcA |= sv << (k * 7)
                else:
                    srcB |= sv << ((k - 9) * 7)
                acc = 0
                for j in range(i):
                    acc |= u[cd["pairs"][(kx[j] - kx[i], ky[j])]]
                M[k] = u[cd["pairs"][(0, ky[i])]] & ~acc & MASK64
    return M, NKv, srcA, srcB, dy


def prove():
    rng = random.Random(20261120)
    pats = []
    for fitv, wallv in ((0, 0), (MASK64, 0xFFFF), (0, 0xFFFF),
                        (MASK64, 0)):
        pats.append(([fitv] * 16, wallv))
    for _ in range(200):
        pats.append(([rng.getrandbits(64) for _ in range(16)],
                     rng.getrandbits(16)))
    n = 0
    for cls in (0, 1):
        for rots1 in (False, True):
            for r in range(4):
                for xi in range(16):
                    for fit, wallR in pats:
                        a = sim_orig(cls, rots1, r, xi, fit, wallR)
                        b = sim_spec(cls, rots1, r, xi, fit, wallR)
                        assert a == b, (cls, rots1, r, xi, a, b)
                        n += 1
    print(f"equivalence proof OK: {n} cases")


prove()


# ---- GLSL emission -------------------------------------------------
def hx(v):
    return f"0x{v:016x}ul"


def xi_expr(delta):
    # expression for xi + delta
    if delta == 0:
        return "xi"
    if delta > 0:
        return f"xi + {delta}"
    return f"xi - {-delta}"


def emit_case(f, kb):
    cd = CASES[kb]
    kx, ky, nk = cd["kx"], cd["ky"], cd["nk"]
    out = []
    base = f * 5
    # dyPk: constant nibble replacement for i < nk
    mask = 0
    val = 0
    for i in range(nk):
        pos = (base + i) * 4
        mask |= 0xF << pos
        val |= (ky[i] + 4) << pos
    out.append(f"g_dyPk = (g_dyPk & ~{hx(mask)}) | {hx(val)};")
    # loads: one fit load + wall bit per distinct cOff
    qof = {}
    for q, cOff in enumerate(cd["loads"]):
        qof[cOff] = q
        out.append(f"int c{q} = {xi_expr(cOff)};")
        out.append(f"int cl{q} = clamp(c{q}, 0, 15);")
        out.append(f"uint64_t fv{q} = fitGet(uint((r << 4) | cl{q}));")
        out.append(f"uint w{q} = (wallR >> uint(cl{q})) & 1u;")
    # distinct term values
    for (cOff, s), m in sorted(cd["pairs"].items(), key=lambda kv: kv[1]):
        q = qof[cOff]
        if s > 0:
            fill = (1 << s) - 1
            out.append(f"uint64_t u{m} = (fv{q} << {s}) | "
                       f"(w{q} != 0u ? {hx(fill)} : 0ul);")
        elif s < 0:
            out.append(f"uint64_t u{m} = fv{q} >> {-s};")
        else:
            out.append(f"uint64_t u{m} = fv{q};")
        out.append(f"u{m} = (c{q} >= 0 && c{q} < 16) ? u{m} : 0ul;")
    # srcPk + M assembly
    for i in range(nk):
        k = base + i
        out.append(f"int sxi{i} = {xi_expr(-kx[i])};")
        out.append(f"if (sxi{i} >= 0 && sxi{i} < 16) {{")
        out.append(f"  uint sv{i} = uint(((pr << 4) | sxi{i}) + 1);")
        if k < 9:
            out.append(f"  g_srcPkA |= uint64_t(sv{i}) << {k * 7};")
        else:
            out.append(f"  g_srcPkB |= uint64_t(sv{i}) << {(k - 9) * 7};")
        diag = cd["pairs"][(0, ky[i])]
        if i == 0:
            out.append(f"  M[{k}] = u{diag};")
        else:
            acc = " | ".join(
                f"u{cd['pairs'][(kx[j] - kx[i], ky[j])]}"
                for j in range(i))
            out.append(f"  M[{k}] = u{diag} & ~({acc});")
        out.append("}")
    return out


def emit_fblock(f):
    out = []
    out.append(f"    // r7c1 f={f}: per-kb specialized construction "
               f"(gen_r7cons.py; see PERSISTENT-R6 round 7)")
    out.append("    {")
    out.append(f"        int pr = (r - {OFFS[f]}) & 3;")
    out.append(f"        int kb = ((cls * 3 + {f}) * 4 + pr);")
    out.append("        int nk = rots == 1 ? 0 : KN[kb];")
    out.append(f"        NK[{f}] = nk;")
    for i in range(5):
        out.append(f"        M[{f * 5 + i}] = 0ul;")
    out.append("        if (nk > 0) {")
    out.append("            switch (kb) {")
    kbs = [f * 4 + pr for pr in range(4)] + \
          [12 + f * 4 + pr for pr in range(4)]
    # group kb values sharing one (KX, KY, KN) triple
    groups = {}
    for kb in kbs:
        cd = CASES[kb]
        key = (tuple(cd["kx"]), tuple(cd["ky"]), cd["nk"])
        groups.setdefault(key, []).append(kb)
    for key, gkbs in sorted(groups.items(), key=lambda kv: kv[1][0]):
        cases = " ".join(f"case {kb}:" for kb in gkbs)
        out.append(f"            {cases} {{")
        for line in emit_case(f, gkbs[0]):
            out.append(f"                {line}")
        out.append("            } break;")
    out.append("            default: break;")
    out.append("            }")
    out.append("        }")
    out.append("    }")
    return out


def find1(pred, what):
    hits = [i for i, L in enumerate(lines) if pred(L)]
    assert len(hits) == 1, f"anchor {what}: {len(hits)} hits"
    return hits[0]


loop_hits = [i for i, L in enumerate(lines)
             if L.strip() == "for (int f = 0; f < 3; f++) {"]
assert len(loop_hits) >= 2, "loop anchors"  # construction + spin
s = loop_hits[0]  # construction is the first occurrence
e = find1(lambda L: L.strip() == "// ---- start adjustment and seeds",
          "seeds comment")
assert s < e, "region order"
old = "\n".join(lines[s:e])
assert "PORTS HP3" in old and "M[k] = t4 & ~(t0 | t1 | t2 | t3);" in old, \
    "region content"

new = []
for f in range(3):
    new.extend(emit_fblock(f))
lines[s:e] = new

out = "\n".join(lines)
open(DST, "w").write(out)
print("wrote", DST, "sha256",
      hashlib.sha256(out.encode()).hexdigest(),
      f"({len(out)} bytes)")
