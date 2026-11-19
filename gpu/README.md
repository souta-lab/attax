# attax GPU engine (Vulkan) — step-26 configuration, vendored

This directory vendors the Vulkan GPU search path that was developed in the
attax-gpu-spike step campaign (steps 1–26) so it can become a first-class
engine path in this repository. Status: **adoption gate passed 2026-11-19
and landed on main** (see "Gate status"). The S2 lab driver lives in
`tools/s2-lab/gpu-player.ts` on top of the codec in
`tools/s2-lab/gpu-codec.ts` (branch `gpu/lab-driver`).

## Configuration (the step-26 final configuration)

- Host: `host/vkrunner_s26.c` (single-file C Vulkan host). Vendored
  byte-identical from the spike at sha256 `836b189b…`; the repo copy has
  since gained the `serve` mode (see below), the rules-profile switch
  and the stage-1C movegen selection, and now hashes to
  `59a0a578…`. The spike original is unchanged and remains the reference
  for the step-26 sessions.
- Movegen SPV (s2 profile): `shaders/bpmg_b1.spv` (sha256 prefix
  `6c2142f2…`) — the BP (bit-parallel) movegen, variant B1, integrated
  2026-11-19 (stage 1C). It reads `mg_in` directly and writes the
  production `mg_out` format; the host pushes `{0, 0}` at its dispatch.
  Source is vendored in-tree at `shaders/src/bpmg_b1.comp`
  (+ `shaders/src/tables.glsl`); rebuild with
  `glslangValidator --target-env vulkan1.2 -V bpmg_b1.comp -o bpmg_b1.spv`
  from that directory. The previous movegen,
  `shaders/movegen_s24_fci.spv` (sha256 prefix `0066dccd…`), remains
  the guideline profile's movegen (see Rules profiles) and the s2
  A/B rollback: passing its path in s2 mode restores the legacy
  `{1, serial}` pushes automatically (the host resolves the push
  contract from the loaded kernel's name).
- Expand SPV: `shaders/expand_s25_noba.spv` (sha256 prefix `55fa3bef…`).
- The other 46 SPVs in `shaders/` are loaded by the host from the expand
  SPV's directory (every name is a string literal in the host source;
  the set is machine-checked against it). All 48 SPVs are pinned in
  `shaders/MANIFEST.sha256`. Note `sel_passA22.spv` is loaded
  unconditionally at pipeline init even though the final configuration
  (S22_PASSA=off) never dispatches it — the file must be present.
- Environment toggles for the final configuration:
  `S22_PASSA=off`, `S23_SOA=1`, `S26_PFUSE=on`, `S26_LFUSE=on`,
  `S26_FILL=on`. Setting the S26 toggles off reverts to the step-23
  dispatch stream inside the same host.
- Search semantics: width 96, max 15 ply, config O — identical to the
  Rust search it was gated against. One decision = one submit;
  measured wall ≈4.53 ms/decision on an RX 6400 (sclk 2320) vs the Rust
  reference's 57.66 ms median (M0, PC). The Rust/TS engine paths were
  removed from the repo in Phase C (2026-11-19); the Rust search survives
  only as the identity-verification reference in the PC archive.

## Rules profiles (guideline / s2)

The engine runs either rules profile of the unified core, selected by
one setting: the environment variable **`ATTAX_GPU_PROFILE`**
(`s2`, the default, or `guideline`). The host resolves it once at
process start — never per decision — and it changes exactly two
things: which SPVs `pipeline_init` loads for six pipeline slots
(mg_build, ex_build, expand, htlook, leaf_prep26 — the guideline
variants carry the `_gl` suffix — and movegen) and the movegen opts
word the host writes into params word 22 (s2 = 7: spin evidence +
180 inputs + S2 180 kicks; guideline = 0). The movegen slot differs
by design: the s2 movegen is the BP kernel (`bpmg_b1.spv`), which
has the S2 options baked in and ignores the opts word, while the
guideline movegen is the legacy `movegen_s24_fci.spv`, which is
opts-driven and implements both option sets, including the engine
T-spin classifier the guideline profile needs. In guideline mode
the host loads the fci kernel from the expand SPV's directory,
ignoring the movegen path argument.

Under `s2` the pipeline is the step-26 configuration above with
the movegen slot running the BP kernel; the stage-1C adoption gate
keeps S2 results bit-identical.
Under `guideline`, the variant kernels implement the root-lift
garbage semantics, the guideline attack table, the legacy dedupe
key and expand-returns-null death (encoded as dead = 2: neither
beam nor leaf). One extra pass runs in this profile only:
`rootfix_gl.spv` re-ranks the ply-0 arena records' root labels —
the reference numbers depth-0 children by rank among surviving
children, and a death does not consume an index. Both profiles
use the same pinned tables file — the shipping guideline weights
and config O are the same numbers.

## Serve mode (product path)

```bash
./vkrunner_s26 serve shaders/bpmg_b1.spv shaders/expand_s25_noba.spv <tables.bin> [device]
```

A long-lived engine process: reads 108-word decision records from
stdin, answers each with `u32 status, u32 block_bytes` followed by the
exact per-decision block the `run` mode writes into a results file.
Vulkan init is paid once per process. Verified 2026-11-19 on the
reference device: all 180 gate decisions served with status 0 and the
assembled output passed the full adoption gate below
(`gpu/tests/serve_smoke.py` is the driver used).

## Gate status

2026-11-19, from this tree (host built from `gpu/host/`, shaders from
`gpu/shaders/`), RX 6400, final configuration: **adoption gate passed**
— `m4-harness check` all categories 0 over 180 decisions
(229,063 beam nodes / 52,669 finished nodes), `cmp_results` IDENTICAL,
bench wall median 4.180 ms/decision with no other GPU tenant.
The same gate re-passed after the serve-mode addition, in both `run`
and `serve` modes. Remaining before main hookup: the lab-side codec
and driver (DESIGN.md §3.2–3.3) and the engine-selection switch.

2026-11-19 (stage 1C, BP movegen), same tree and device, sclk 2320
under load, no other GPU tenant: **stage-1C gate passed** — with
`bpmg_b1.spv` as the s2 movegen, `m4-harness check` all categories 0
over 180 decisions (229,063 beam / 52,669 finished), `cmp_results`
IDENTICAL, in both `run` and `serve` modes. Same-session bench
(180 decisions × 5 reps, wall median): BP host 3.426 ms/decision vs
the profile-port host with the fci movegen at 3.631 ms/decision in
the same session (−5.6%). The guideline profile re-passed its
dedicated corpus with the stage-1C host (all categories 0 over
232,763 beam / 17,280 finished nodes). Full record:
`attax-gpu-spike/STAGE1C-B1-INTEGRATION-2026-11-19.md`.

## Build

```bash
bash gpu/build.sh   # verifies the SPV manifest, then gcc -O2 host -lvulkan -lm
```

## Adoption gate (must pass from this tree before any main hookup)

On a machine with a real Vulkan GPU (RX 6400 is the reference device;
llvmpipe is **not** an adoption target — see DESIGN.md):

```bash
S22_PASSA=off S23_SOA=1 S26_PFUSE=on S26_LFUSE=on S26_FILL=on \
  ./vkrunner_s26 run shaders/bpmg_b1.spv shaders/expand_s25_noba.spv \
  <tables.bin> <decisions.bin> res.bin 180
m4-harness check <expect.bin> res.bin        # every category must be 0
cmp_results.py res.bin <results-s2.bin>      # must print IDENTICAL
```

The evaluation tables **are** vendored here: `gpu/tables.bin`, the pinned
PC-lineage file, sha256
`07b87df1819985e8c49ee09b826d7906b089711296722c3a6924578e0f95f5e9`
(1,448 bytes; copied from the PC gate-data set 2026-11-19 with the hash
verified after transfer). The lab driver verifies this hash at startup and
refuses any other tables file. The tables lineage is correctness-critical:
tables regenerated by the VM toolchain (`bf85b4b3…`) differ by 1 ULP in 25
powi values and fail the gate. See DESIGN.md §4 before generating tables
anywhere else. The remaining gate data (decisions / expect / results-s2)
is not vendored; it lives in the PC gate-data set and the spike tree
(`attax-gpu-spike/m4/data`, `attax-gpu-spike/data/obs.bin`).

## Provenance

- `bpmg_b1.spv` was compiled 2026-11-19 from the in-tree source
  `shaders/src/bpmg_b1.comp`, itself derived from the spike's adopted
  B1 kernel (`attax-gpu-spike/stage1-work/varB1.comp`, sha256
  `7ecdd848…`) with only the input/output stages adapted to the
  production contract (see the source header and
  `attax-gpu-spike/STAGE1C-B1-INTEGRATION-2026-11-19.md`).
- Host and the other SPVs were copied on 2026-11-19 from the spike workspaces
  (PC `/tmp/s9work/opt26`, `/tmp/s9work/opt24/mg24`,
  `/tmp/s9work/opt26/build-scr26`) with sha256 verification at every hop.
- Shader `.comp` sources live in the spike tree, one generation pipeline
  per step (`opt<N>/gen_shaders<N>.py` + `opt<N>/src<N>/`); the step-25/26
  sources are in `opt25/src25/` and `opt26/src26/`. A per-SPV source
  revision map is pending; the SPVs pinned here are the canonical
  artifacts the gate consumes.
