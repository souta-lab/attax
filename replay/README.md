# replay/ — composed replay-assembly stack (basic-form ceiling work)

The replay assembly (`bxrun` harness) re-runs the recorded stage
structure of the basic form so interval costs can be decomposed and
variants A/B-tested in the same window. This directory preserves the
composed stack of **bit-identical wins** measured on that assembly
(2026-11-20, RX 6400, same-window ABAB, canonical dump FNV
`aeec061e4f6c4a0c` on every run) that have not landed anywhere.
Full evidence: `attax-gpu-spike/BASIC-CEILING-2026-11-20.md` and
`BASIC-DDM-2026-11-20.md` (spike tree, outside this repo).

## The stack

- Host: `bxrun_bc3.c` — `bxrun_bc.c` (sha256 `97b67e45…`, spike
  `adopt26/`) plus the bc3 barrier edits R1/R2 (see `mk_bc3.py`;
  output sha256 `7a4c18dd…`). The base host already carries the
  DDM switch and the matboards_w dispatch switch.
- Environment: `BX_MBW=1 SELG_DDM=1 SELG_V2=1 SELG_V3=1
  SELG_FUSE3=1` (the DW configuration of the ceiling records).
- Kernel substitutions (base → variant in this directory):

| slot | variant | measured effect (same-window ABAB) |
|---|---|---|
| dedupe | `rec_dedup_m.comp` (DDM, single dispatch) | dedupe span 319–323 → 111 µs/dec (**−206**) |
| A1 (BX first half) | `bxp_a1y.comp` (row-mask map, scalarised) | WHOLE-CB **−1.7%** on DW |
| matboards | `matboards_w.comp` (per-survivor WG, row-space) | A1 path **−335 µs/dec**; reconstitution 469 → 78 |
| order | `order2w.comp` (V1: 1024 threads + subgroup scan) | part of S2 below |
| sort | `sel_sort3f_bit.comp` (V2: full bitonic for 96<n≤1024) | part of S2 below |
| cache | `sel_cache2w.comp` (V4: per-WG min/max aggregation) | part of S2 below |

S2 = V1+V2+V4 composed: **−104.1 µs/decision (−4.4%)** WHOLE-CB
average over the base assembly, two clean repetitions.

## Exclusions (measured, do not re-add silently)

- `sel_prefix6b_fin12` (V3): bit-identical but **slower** (+26.7);
  rejected. The all-in stack including it ("sall") is therefore
  not the stack — S2 above is.
- DDP (packed dedupe table) and DL512: identity failures, rejected.
- `bxp_a1x` / `bxp_a1z` / `bxp_a1w`: bit-identical but slower
  (VGPR step-function regression), rejected.

## Gate

Build `bxrun_bc3` against Vulkan, assemble the SPV set (base set
with the six substitutions above; the prefix kernel is the
recompiled-from-source `sel_prefix6b`, FNV-verified equivalent to
the shipped SPV), run `full` over the 180-decision corpus: the
harness's built-in check must report FNV `aeec061e4f6c4a0c`,
IDENTICAL, 0 mismatches.

## Relation to the production form

These wins are kernel/host results on the replay assembly. Landing
them in the production runner (`gpu/host/vkrunner_s26.c`) is
separate work (production wiring for a GATE_OUT-less path plus a
survivor-count grid dispatch, and a clean-window whole-stream
measurement), as laid out in BASIC-CEILING §4.3. The production
host's own structural wins (C23, d8, F1) land separately in `gpu/`.
