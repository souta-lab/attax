#!/usr/bin/env python3
"""Round-10C attack on sortStage (~306 us/dec, PERSISTENT-R6
sec. 10-B.3) on the pfl_r7c1 base. All transforms are anchored
replacements inside the sortStage function body only.

Key identity (judgeBuildPX2, L3328-3329): EVLIST[2s] = child =
plyCB(ply) + coff and EVLIST[2s+1] = coff, so for every gathered
element in both branches fit == plyCB(ply) + ord. The fit payload
can be reconstructed from ord and never has to ride the network.

Sizing probes (idempotent, drill must PASS; delta = direct cost):
  r10sdblG : gather loops + padding executed twice (the prefixP
             call itself is NOT duplicated). Delta = gather cost.
  r10sdblW : post-network block (LDS store-back + barrier + SELB
             loop + barrier + lane0 block + barrier) duplicated
             verbatim. Delta = writeback-phase cost.

Variants (result-invariant; drill must PASS, VGPR <= 120 to bench):
  r10swb   : register-direct writeback. After the network each
             lane's registers hold exactly elements lane (A) and
             lane+64 (B); write SELB straight from bfA/bfB and drop
             the LDS store-back, barrier #2 and the LDS read loop.
  r10snp   : payload-free network. Gather drops the EVLIST even
             word reads and the sFitW writes (4 -> 3 global reads
             per element); registers carry (kh, kl, ord) only, so
             each bitonic step shuffles 6 words instead of 8; the
             j==32 LDS path exchanges key+ord only; writeback
             reconstructs SELB[i] = plyCB(ply) + sOrderPk[i].
  r10sall  : swb + snp + barrier diet: barriers #3/#4 removed.
             SELB / ST_NSEL consumers sit behind gbar X5 (which
             provides the ordering, as for every other stage);
             h_* are written and read by lane 0 only, and main's
             nReps==0 path writes them with no barrier at all.

Usage: gen_r10c.py (writes pfl_r10s*.comp in cwd)
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


# ---- extract the sortStage function span ----
FSTART = "void sortStage(uint ply) {"
FEND = "\n// ---- S4a: materialization"
assert text.count(FSTART) == 1 and text.count(FEND) == 1
fi = text.index(FSTART)
fj = text.index(FEND)
fn = text[fi:fj]
assert fn.count("barrier();") == 5, f"fn barriers: {fn.count('barrier();')}"


def splice(newfn):
    return text[:fi] + newfn + text[fj:]


def frep(t, old, new, what):
    assert t.count(old) == 1, f"fn anchor {what}: count {t.count(old)}"
    return t.replace(old, new, 1)


GATHER = """  if (nEval > 96u) {
    prefixP(EVORD, nEval, 96u, true, mmv.v[0], mmv.v[1]);
    for (uint i = lane; i < 96u; i += 64u) {
      uint src = state.u[PFXIDX + i];
      selKeySet(i, selKeyOf(EVORD, src));
      sOrderPk[i] = state.u[EVLIST + 2u * src + 1u];
      sFitW[i] = state.u[EVLIST + 2u * src];
    }
  } else {
    for (uint i = lane; i < nEval; i += 64u) {
      selKeySet(i, selKeyOf(EVORD, i));
      sOrderPk[i] = state.u[EVLIST + 2u * i + 1u];
      sFitW[i] = state.u[EVLIST + 2u * i];
    }
  }
  for (uint i = keep + lane; i < 128u; i += 64u) {
    selKeySet(i, 0ul);
    sOrderPk[i] = 0xFFFFFFFFu;
    sFitW[i] = 0u;
  }
  barrier();"""

REGLOAD = """  uint bkhA, bklA, boA, bfA, bkhB, bklB, boB, bfB;
  {
    uint64_t k0 = selKeyGet(lane);
    bkhA = uint(k0 >> 32); bklA = uint(k0); boA = sOrderPk[lane]; bfA = sFitW[lane];
    uint64_t k1 = selKeyGet(lane + 64u);
    bkhB = uint(k1 >> 32); bklB = uint(k1); boB = sOrderPk[lane + 64u]; bfB = sFitW[lane + 64u];
  }"""

J64_BFSWAP = """          t = boA; boA = boB; boB = t;
          t = bfA; bfA = bfB; bfB = t;"""

J32 = """        selKeySet(lane, packUint2x32(uvec2(bklA, bkhA)));
        sOrderPk[lane] = boA; sFitW[lane] = bfA;
        selKeySet(lane + 64u, packUint2x32(uvec2(bklB, bkhB)));
        sOrderPk[lane + 64u] = boB; sFitW[lane + 64u] = bfB;
        barrier();
        {
          uint pl = lane ^ 32u;
          uint64_t pk = selKeyGet(pl);
          uint pkh = uint(pk >> 32), pkl = uint(pk);
          uint po = sOrderPk[pl], pf = sFitW[pl];
          bool up = (((lane & ~32u) & k) == 0u);
          bool isLow = ((lane & 32u) == 0u);
          bool mineFirst = btPrecedes(bkhA, bklA, boA, pkh, pkl, po);
          if (mineFirst != (up == isLow)) { bkhA = pkh; bklA = pkl; boA = po; bfA = pf; }
        }
        {
          uint idx = lane + 64u;
          uint pl = idx ^ 32u;
          uint64_t pk = selKeyGet(pl);
          uint pkh = uint(pk >> 32), pkl = uint(pk);
          uint po = sOrderPk[pl], pf = sFitW[pl];
          bool up = (((idx & ~32u) & k) == 0u);
          bool isLow = ((idx & 32u) == 0u);
          bool mineFirst = btPrecedes(bkhB, bklB, boB, pkh, pkl, po);
          if (mineFirst != (up == isLow)) { bkhB = pkh; bklB = pkl; boB = po; bfB = pf; }
        }"""

GEN_A = """        {
          uint pkh = subgroupShuffleXor(bkhA, j);
          uint pkl = subgroupShuffleXor(bklA, j);
          uint po = subgroupShuffleXor(boA, j);
          uint pf = subgroupShuffleXor(bfA, j);
          bool up = (((lane & ~j) & k) == 0u);
          bool isLow = ((lane & j) == 0u);
          bool mineFirst = btPrecedes(bkhA, bklA, boA, pkh, pkl, po);
          if (mineFirst != (up == isLow)) { bkhA = pkh; bklA = pkl; boA = po; bfA = pf; }
        }"""

GEN_B = """        {
          uint pkh = subgroupShuffleXor(bkhB, j);
          uint pkl = subgroupShuffleXor(bklB, j);
          uint po = subgroupShuffleXor(boB, j);
          uint pf = subgroupShuffleXor(bfB, j);
          uint idx = lane + 64u;
          bool up = (((idx & ~j) & k) == 0u);
          bool isLow = ((idx & j) == 0u);
          bool mineFirst = btPrecedes(bkhB, bklB, boB, pkh, pkl, po);
          if (mineFirst != (up == isLow)) { bkhB = pkh; bklB = pkl; boB = po; bfB = pf; }
        }"""

LANE0 = """  if (lane == 0u) {
    state.u[STATS + ST_NSEL] = keep;
    h_nAlive = state.u[STATS + ST_NALIVE];
    h_nReps = state.u[STATS + ST_NREPS];
    h_nSel = keep;
    h_nEval = nEval;
    h_rounds = state.u[STATS + ST_ROUNDS];
  }"""

POST = """  selKeySet(lane, packUint2x32(uvec2(bklA, bkhA)));
  sOrderPk[lane] = boA; sFitW[lane] = bfA;
  selKeySet(lane + 64u, packUint2x32(uvec2(bklB, bkhB)));
  sOrderPk[lane + 64u] = boB; sFitW[lane + 64u] = bfB;
  barrier();
  for (uint i = lane; i < keep; i += 64u) state.u[SELB + i] = sFitW[i];
  barrier();
""" + LANE0 + """
  barrier();"""

for name, anchor in [("GATHER", GATHER), ("REGLOAD", REGLOAD),
                     ("J64_BFSWAP", J64_BFSWAP), ("J32", J32),
                     ("GEN_A", GEN_A), ("GEN_B", GEN_B),
                     ("LANE0", LANE0), ("POST", POST)]:
    assert fn.count(anchor) == 1, f"anchor {name}: count {fn.count(anchor)}"

# =====================================================================
# dblG: gather loops + padding twice (prefixP call not duplicated)
# =====================================================================
gather_copy = GATHER.replace(
    "    prefixP(EVORD, nEval, 96u, true, mmv.v[0], mmv.v[1]);\n", "", 1)
assert "prefixP" not in gather_copy
emit("pfl_r10sdblG.comp", splice(frep(
    fn, GATHER,
    GATHER + "\n" + gather_copy + " // R10C PROBE dblG: gather twice",
    "dblG")))

# =====================================================================
# dblW: post-network block twice (verbatim, same-value writes)
# =====================================================================
emit("pfl_r10sdblW.comp", splice(frep(
    fn, POST, POST + "\n" + POST + " // R10C PROBE dblW: post twice",
    "dblW")))

# =====================================================================
# swb: register-direct writeback
# =====================================================================
WB_POST = """  if (lane < keep) state.u[SELB + lane] = bfA;
  if (lane + 64u < keep) state.u[SELB + lane + 64u] = bfB;
  barrier();
""" + LANE0 + """
  barrier();"""

emit("pfl_r10swb.comp", splice(frep(fn, POST, WB_POST, "swb")))

# =====================================================================
# np transforms (payload-free); post_tail selects the tail block
# =====================================================================
NP_GATHER = """  if (nEval > 96u) {
    prefixP(EVORD, nEval, 96u, true, mmv.v[0], mmv.v[1]);
    for (uint i = lane; i < 96u; i += 64u) {
      uint src = state.u[PFXIDX + i];
      selKeySet(i, selKeyOf(EVORD, src));
      sOrderPk[i] = state.u[EVLIST + 2u * src + 1u];
    }
  } else {
    for (uint i = lane; i < nEval; i += 64u) {
      selKeySet(i, selKeyOf(EVORD, i));
      sOrderPk[i] = state.u[EVLIST + 2u * i + 1u];
    }
  }
  for (uint i = keep + lane; i < 128u; i += 64u) {
    selKeySet(i, 0ul);
    sOrderPk[i] = 0xFFFFFFFFu;
  }
  barrier();"""

NP_REGLOAD = """  uint bkhA, bklA, boA, bkhB, bklB, boB;
  {
    uint64_t k0 = selKeyGet(lane);
    bkhA = uint(k0 >> 32); bklA = uint(k0); boA = sOrderPk[lane];
    uint64_t k1 = selKeyGet(lane + 64u);
    bkhB = uint(k1 >> 32); bklB = uint(k1); boB = sOrderPk[lane + 64u];
  }"""

NP_J32 = """        selKeySet(lane, packUint2x32(uvec2(bklA, bkhA)));
        sOrderPk[lane] = boA;
        selKeySet(lane + 64u, packUint2x32(uvec2(bklB, bkhB)));
        sOrderPk[lane + 64u] = boB;
        barrier();
        {
          uint pl = lane ^ 32u;
          uint64_t pk = selKeyGet(pl);
          uint pkh = uint(pk >> 32), pkl = uint(pk);
          uint po = sOrderPk[pl];
          bool up = (((lane & ~32u) & k) == 0u);
          bool isLow = ((lane & 32u) == 0u);
          bool mineFirst = btPrecedes(bkhA, bklA, boA, pkh, pkl, po);
          if (mineFirst != (up == isLow)) { bkhA = pkh; bklA = pkl; boA = po; }
        }
        {
          uint idx = lane + 64u;
          uint pl = idx ^ 32u;
          uint64_t pk = selKeyGet(pl);
          uint pkh = uint(pk >> 32), pkl = uint(pk);
          uint po = sOrderPk[pl];
          bool up = (((idx & ~32u) & k) == 0u);
          bool isLow = ((idx & 32u) == 0u);
          bool mineFirst = btPrecedes(bkhB, bklB, boB, pkh, pkl, po);
          if (mineFirst != (up == isLow)) { bkhB = pkh; bklB = pkl; boB = po; }
        }"""

NP_GEN_A = """        {
          uint pkh = subgroupShuffleXor(bkhA, j);
          uint pkl = subgroupShuffleXor(bklA, j);
          uint po = subgroupShuffleXor(boA, j);
          bool up = (((lane & ~j) & k) == 0u);
          bool isLow = ((lane & j) == 0u);
          bool mineFirst = btPrecedes(bkhA, bklA, boA, pkh, pkl, po);
          if (mineFirst != (up == isLow)) { bkhA = pkh; bklA = pkl; boA = po; }
        }"""

NP_GEN_B = """        {
          uint pkh = subgroupShuffleXor(bkhB, j);
          uint pkl = subgroupShuffleXor(bklB, j);
          uint po = subgroupShuffleXor(boB, j);
          uint idx = lane + 64u;
          bool up = (((idx & ~j) & k) == 0u);
          bool isLow = ((idx & j) == 0u);
          bool mineFirst = btPrecedes(bkhB, bklB, boB, pkh, pkl, po);
          if (mineFirst != (up == isLow)) { bkhB = pkh; bklB = pkl; boB = po; }
        }"""

NP_POST = """  selKeySet(lane, packUint2x32(uvec2(bklA, bkhA)));
  sOrderPk[lane] = boA;
  selKeySet(lane + 64u, packUint2x32(uvec2(bklB, bkhB)));
  sOrderPk[lane + 64u] = boB;
  barrier();
  {
    uint childBase = plyCB(ply);
    for (uint i = lane; i < keep; i += 64u) state.u[SELB + i] = childBase + sOrderPk[i];
  }
  barrier();
""" + LANE0 + """
  barrier();"""

ALL_POST = """  {
    uint childBase = plyCB(ply);
    if (lane < keep) state.u[SELB + lane] = childBase + boA;
    if (lane + 64u < keep) state.u[SELB + lane + 64u] = childBase + boB;
  }
""" + LANE0


def apply_np(f, post):
    f = frep(f, GATHER, NP_GATHER, "np gather")
    f = frep(f, REGLOAD, NP_REGLOAD, "np regload")
    f = frep(f, J64_BFSWAP, "          t = boA; boA = boB; boB = t;",
             "np j64")
    f = frep(f, J32, NP_J32, "np j32")
    f = frep(f, GEN_A, NP_GEN_A, "np genA")
    f = frep(f, GEN_B, NP_GEN_B, "np genB")
    f = frep(f, POST, post, "np post")
    assert "bfA" not in f and "bfB" not in f, "np: bf remains"
    assert "sFitW" not in f, "np: sFitW remains"
    return f


emit("pfl_r10snp.comp", splice(apply_np(fn, NP_POST)))
emit("pfl_r10sall.comp", splice(apply_np(fn, ALL_POST)))

print("gen_r10c done")
