#!/usr/bin/env python3
"""Serve-mode gate driver: drive `vkrunner_s26 serve` over a decisions
corpus, assemble a results file from the framed responses, and leave
it for m4-harness check / cmp_results validation.

Usage:
  serve_smoke.py <decisions.bin> <out.bin> [workdir] [mg.spv] [exp.spv] [tables.bin]

Defaults reproduce the 2026-11-19 verification layout on the spike PC
(workdir /tmp/s9work/gpu-integ, vendored shaders in ../gpu-vendor,
gate data in ../gate-data). Requires the step-26 env toggles in the
environment (S22_PASSA=off S23_SOA=1 S26_PFUSE=on S26_LFUSE=on
S26_FILL=on).
"""
import struct, subprocess, sys, threading

DEC_WORDS = 108
RS_MAGIC = 0x4D345253
DC_MAGIC = 0x4D344443

dec_path, out_path = sys.argv[1], sys.argv[2]
workdir = sys.argv[3] if len(sys.argv) > 3 else "/tmp/s9work/gpu-integ"
mg = sys.argv[4] if len(sys.argv) > 4 else "../gpu-vendor/bpmg_b1.spv"
exp = sys.argv[5] if len(sys.argv) > 5 else "../gpu-vendor/expand_s25_noba.spv"
tables = sys.argv[6] if len(sys.argv) > 6 else "../gate-data/tables.bin"

raw = open(dec_path, "rb").read()
magic, n = struct.unpack_from("<II", raw, 0)
assert magic == DC_MAGIC, hex(magic)
recs = [raw[8 + i * DEC_WORDS * 4: 8 + (i + 1) * DEC_WORDS * 4] for i in range(n)]
assert all(len(r) == DEC_WORDS * 4 for r in recs)

p = subprocess.Popen(["./vkrunner_s26", "serve", mg, exp, tables],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, cwd=workdir)

def writer():
    for r in recs:
        p.stdin.write(r)
    p.stdin.close()

t = threading.Thread(target=writer)
t.start()
blocks = []
for i in range(n):
    hdr = p.stdout.read(8)
    assert len(hdr) == 8, f"decision {i}: short header {len(hdr)}"
    status, blen = struct.unpack("<II", hdr)
    block = p.stdout.read(blen)
    assert len(block) == blen, f"decision {i}: short block"
    assert status == 0, f"decision {i}: status {status}"
    blocks.append(block)
t.join()
rc = p.wait()
assert rc == 0, f"serve exit code {rc}"
with open(out_path, "wb") as f:
    f.write(struct.pack("<II", RS_MAGIC, n))
    for b in blocks:
        f.write(b)
print(f"serve smoke: {n} decisions, all status 0, wrote {out_path}")
