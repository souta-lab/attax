#!/usr/bin/env python3
# mk_bc3.py -- regenerate bxrun_bc3.c from bxrun_bc.c.
# bc3 = the replay-stream counterpart of the production C23 barrier
# diet: of C23's four edits only the cumulative-coverage barrier
# removals have replay analogues, as two conditional removals inside
# run_replay (BASIC-CEILING-2026-11-20.md section 6.1/6.2):
#   R1: the barrier after the PFX span is redundant whenever the
#       round is non-empty (chunk copy's B7 barrier covers it);
#       keep it only for cn==0 rounds (WAW between PFX rounds).
#   R2: the barrier after the ST_B span of the LAST round is
#       redundant (the eval copy is unrelated; SRT's brec read is
#       covered by the B9 barrier); keep it when a round follows.
# Anchors are asserted; run_ply_full is untouched.
# Input : bxrun_bc.c  sha256 97b67e452ab08ff655b9b7f8d14ee9d829502a7862558dd38795e7d210eff49e
# Output: bxrun_bc3.c sha256 7a4c18dd95e34120324d712ffbfebe081c22367bcc2d6569dbed41d813dfb9b2 (111817 B)
import hashlib, pathlib, sys

src_p = pathlib.Path(sys.argv[1])
out_p = pathlib.Path(sys.argv[2])

def H(t): return hashlib.sha256(t.encode()).hexdigest()

def rep(text, old, new, n=1):
    c = text.count(old)
    assert c == n, f"anchor count {c} != {n}: {old[:70]!r}"
    return text.replace(old, new)

bc = src_p.read_text()
assert H(bc) == "97b67e452ab08ff655b9b7f8d14ee9d829502a7862558dd38795e7d210eff49e", H(bc)
a = bc.index("run_replay")
a = bc.rindex("static", 0, a)
b = bc.index("\nstatic ", a + 10)
pre, body, post = bc[:a], bc[a:b], bc[b:]
body = rep(body,
    "barrier_all(F_cmd);\n                    uint32_t cn = R->roundSizes[r];",
    "uint32_t cn = R->roundSizes[r];\n                    if (!cn) barrier_all(F_cmd);")
body = rep(body,
    "si = f_span_open(ST_B); f_disp(F_pB, F_lay_bx, F_setB, pcb, 32, (cn + 63) / 64); f_span_close(si);\n                        barrier_all(F_cmd);",
    "si = f_span_open(ST_B); f_disp(F_pB, F_lay_bx, F_setB, pcb, 32, (cn + 63) / 64); f_span_close(si);\n                        if (r + 1 < R->nRounds) barrier_all(F_cmd);")
bc3 = pre + body + post
assert H(bc3) == "7a4c18dd95e34120324d712ffbfebe081c22367bcc2d6569dbed41d813dfb9b2", H(bc3)
out_p.write_text(bc3)
print("bxrun_bc3.c", len(bc3), H(bc3))
