# GPU engine integration — design

Decision (Souta, 2026-11-19): the Vulkan GPU search becomes a first-class
engine path in attax main **now**, on the step-26 configuration
(wall ≈4.53 ms/decision, ≈12.7× the Rust reference), without waiting for
the BP+BX unified architecture. BP+BX development continues; its landing
target is this productized path (same host boundary, new kernels).

> **Status (2026-11-20): landed, with the engine rule changed after this
> design was written.** The fallback arrangement in §1, §5 item 4 and §6
> was **not** adopted: by Souta's ruling of 2026-11-19 the GPU search is
> the only engine and there is no fallback (see AGENTS.md, "Search engine
> rule"). The Rust and TS searches were removed from the repo in Phase C
> (2026-11-19); the Rust search survives only as the
> identity-verification reference in the PC archive. The boundary, format
> and gate sections below are the landed design; the engine-selection
> passages are kept as the record of the superseded plan.

## 1. What "GPU-only" means here

- The Vulkan path targets real GPUs only. llvmpipe is dropped as an
  adoption condition, a design constraint, and a fallback: on llvmpipe
  the Vulkan path's best measured time (79.4 ms) is slower than the Rust
  engine (57.66 ms), so a GPU-less environment loses nothing.
- The Rust engine (`rust/attax-search`) is **not** removed. It stays as
  (a) the reference implementation the GPU path is gated against, and
  (b) the engine for environments without a usable Vulkan device.
- Engine selection is therefore: Vulkan device present and gate-clean →
  GPU path; otherwise → Rust. Selection happens once at engine start,
  never per decision.
  **Superseded by Souta's rulings of 2026-11-19 and executed as Phase C
  the same day:** there is no engine selection and no Rust fallback. The
  Rust/TS engine paths are removed from the repo; the GPU path is the
  only engine, and an environment without a usable Vulkan device stops.
  The Rust search survives only as the identity-verification reference
  in the PC archive.

## 2. The engine boundary (what already exists)

The spike host `host/vkrunner_s26.c` separates cleanly:

- **Engine core** (keep, this is the product):
  `vk_setup` (device selection; must refuse llvmpipe-class devices for
  the product path), `pipeline_init` (builds all pipelines/buffers once),
  `run_decision_s2(dec, out, &wall_ms, &gpu_ms)` — one decision = one
  submit; input is a 108-word decision record, output is the wire result
  record appended to an `Out` buffer. The final selection runs host-side
  inside `run_decision_s2` with the step-1 host semantics; that code is
  part of the engine, not the harness.
- **Harness** (stays a harness): `main` modes `run` / `bench` / `prof` /
  `dump` / `expandcheck` / `expandtime` / `mgreplay*`, the file loaders
  (`load_decisions`, `load_tables`), and the profiling duplicate
  `run_decision_prof`.

Formats (all pre-existing, gate-verified, magic-headed):

- Decision record: 108 u32 words — board rows [0,40) as u16 masks,
  garbage-row flags [40,80) as u8, board_len [80], seq_len [81],
  piece sequence [82,96), active rotation/x/y [96,99), root hold [99],
  can_hold [100], root scalar state [101,106) (b2b/combo/pending/due
  family; `root_due` is [104]).
- Wire result record: per node, the 108-word node record repacked by
  `write_wire_record` (rows as u16, flags as u8, f64 value/reward as raw
  bits). This is exactly what `m4-harness check` and `cmp_results.py`
  validate, so the adoption gate needs no new comparator.
- Tables: evaluation lookup tables (362 f64 entries), loaded from a
  TB_MAGIC file. See §4 for the generation caveat.

## 3. Product shape

1. **Split the host** into `vkengine.c/h` (engine core + a small C API:
   `vk_engine_init(mg_spv, exp_spv, tables)`,
   `vk_engine_decide(dec_words, out)`, `vk_engine_shutdown`) and
   `vkrunner.c` (the existing harness modes on top of the API). The
   split must be behavior-preserving: the adoption gate re-runs after
   the split and must stay all-zero / IDENTICAL.
2. **Serve mode** — **implemented 2026-11-19** (ahead of the §3.1
   split; it needed no split, only a new `main` mode around the
   existing core): a long-lived process mode of the runner that reads
   108-word decision records from stdin and writes wire records to
   stdout, flushing per decision. Vulkan init is paid once per match,
   not once per decision. Gate-verified over all 180 decisions
   (README "Gate status"). This is the form the S2 lab can drive:
   `tools/s2-lab/run-match.mjs` currently calls the TS `search`
   (`attax-player.ts`), whose semantics `rust/attax-search` mirrors
   bit-for-bit; a GPU driver next to `attax-player.ts` selects the serve
   process when a GPU engine is configured, and falls back to the
   existing path otherwise.
3. **Codec**: the lab-side driver needs SearchInput → decision-record
   encoding and wire-record → SearchResult decoding. The encoding
   already exists in reference form in the gate harness
   (`m4-harness genfull`, which builds decision records from observed
   game states); the codec must be verified decision-for-decision
   against it on the 180-decision corpus before any live match use.
4. **Rust-side surface (later)**: an `attax-gpu` crate wrapping the C
   engine via FFI behind the same `Searcher`-shaped API is the natural
   end state for non-lab consumers. It is *not* required for the first
   product step (the lab serve mode is), and it must not fork the
   semantics: same records in, same wire records out.

## 4. Tables generation caveat (correctness-critical)

The gate passes only with the pinned tables file (W8 lineage on feat/w8-setup-value since 2026-11-25, sha256 `3c8fa328…`; previously W7 lineage `783225ab…`, before that PC-lineage `07b87df1…`).
Regenerating tables with a different toolchain shifted 25 powi values by
1 ULP and failed the gate (value-bits mismatches in the tens of
thousands). Root cause, per the harness source: the powi terms must
carry the *runtime* bits of the search binary, and constant folding in
some toolchains produces different bits. Consequences for productization:

- Until a tables generator is proven against the gate, the engine ships
  with the pinned tables for the production weights (config O) and the
  gate corpus stays the arbiter for any regeneration.
- A Rust-side generator (runtime `powi`, no const-folding of the table
  build) is the candidate replacement; it is adopted only when its
  output passes the full V3 gate on the reference device.

## 5. Adoption gate (definition of done for the branch)

1. From this tree: build OK, manifest OK.
2. On the reference device (RX 6400): step-26 final configuration,
   180 decisions — `m4-harness check` all categories 0 **and**
   `cmp_results` IDENTICAL. (llvmpipe runs are not part of the gate.)
3. Wall measured in the same session with the GPU clock state recorded
   (sclk sampler; boost 2320 MHz dominant) and no other GPU tenant
   running — bench numbers taken under contention are not evidence.
4. Only after 1–3: hook the serve mode into the lab.
   **Superseded by Souta's rulings of 2026-11-19:** there is no engine
   switch and no default-off period. The lab driver is GPU-only
   (`tools/s2-lab/gpu-player.ts` + `gpu-codec.ts`, branch
   `gpu/lab-driver`): with no usable Vulkan device it stops with a clear
   error — a silent fallback to a path tens of times slower would
   contaminate measurements. The Rust/TS engine paths are being removed
   from the repo by a separate lane; the Rust search survives only as
   the gate harnesses' archived reference on the PC.

## 6. Non-goals for this branch

- No BP/BX kernels (they land later, into this same host boundary).
- No search-semantics changes of any kind: width, ply count, selection,
  and the f64 evaluation graph are bit-frozen by the gate.
- No removal of the Rust engine or of the TS search.
  (Branch-scoped at the time; a separate lane — Phase C, 2026-11-19 —
  removed both after the profile port landed and the guideline profile
  passed its GPU gate.)
