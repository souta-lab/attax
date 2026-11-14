# Hoiko Rust search — allocation-removal / arena pass

Goal: reach or beat the shipping C++ binary's **101 ms/move** (depth-14 empty
board, 71 600 nodes) without changing any observable result. Correctness gate:
`cargo test`, oracle `diff.ts` 9/9, oracle `twosearch.ts` 9/9, node count 71 600.

Benchmark: `cargo run --release --example bench_search`
(machine under load average ≈ 9 during most runs, so wall-clock is noisy;
CPU hardware counters are the stable signal).

## Results

| Step | ms/move | k nodes/s | notes |
|---|---|---|---|
| Baseline (warm, original) | 152–177 (avg 160) | ~450 | measured via `git stash` |
| 1. Fixed command log | 126.3 | 567 | `Command.s: Vec<i32>` → `[u8;48]+len` |
| 2. Arena search (no beam clone, inline acts) | 125.0 | 573 | swap+truncate, `[i32;16]` plan |
| 3. Reusable expansion scratch | 120.0 | 597 | no per-call baby/bucket/out allocs |
| 4. Index sort + lean child `GamePack` | 57.2–66.4 | ~1150 | sort 4-byte indices, not 400-byte nodes |
| 5. Exact top-k select | 54.9–57.2 | ~1280 | `select_nth_unstable_by` + sort k=beam |
| **Final (under load)** | **62–66, best 54.9** | **~1100–1300** | shipping binary: 101 ms (~709k/s) |

WASM (`bun /tmp/opencode/re/bench_wasm.ts`): **72–89 ms/move** (typical
72–79 ms), depth 14, 71 600 nodes, ~0.8–1.0 M nodes/s (baseline stated: 205 ms).

Speedup vs original Rust: **≈2.4×** (152–177 → 62–66 ms). The benchmark uses the
same depth and still reports exactly `71600 nodes/move`.

## What changed

- **`mino.rs` — fixed command log.** `Command` now mirrors the native 56-byte
  struct (`char s[48]`, `int move_delay`, `int len`): `[u8;48] + len`, `Copy`.
  The command bytes are never read by the engine (only copied), so there are no
  per-node heap allocations for it. `copy_from` replaces the `Vec` clear/extend.
- **`search.rs` — arena/index search.**
  - `NodeState.acts` is an inline `Acts { buf: [i32;16], len }` (native
    `Plans.mino[14]`) instead of a per-node `Vec<i32>`.
  - The pruned beam is no longer a clone of `results`. `children` is a reused
    buffer; the top beam is selected by index and cloned (≤150 nodes/generation).
  - Prune sorting now sorts `u32` indices with a total-order comparator
    `(score desc, index asc)` — provably identical to the previous stable
    `sort_by(score desc)`. A `select_nth_unstable_by` picks the top `next_beam`
    before sorting only those, cutting an O(n log n) sort of ~6 000 nodes to an
    O(n) partition + O(k log k) sort (k = 150/75).
- **`expand.rs` — reusable scratch.** New `ExpandScratch` (baby pool, 48 baby
  buckets, 64 child buckets, hold-output) is created once per search and passed
  into `expand_node_into`, so no `Vec<Baby>` / `Vec<Vec<usize>>` / `Vec<ExpandedChild>`
  is allocated per expansion. `expand_base_node` prunes in place (`retain` +
  `truncate`) instead of collecting a temp `Vec`. `regist_child_node` builds the
  child `GamePack` field-by-field, skipping the `Board`/`Command` zeroing that
  was immediately overwritten. `expand_node(...) -> Vec<...>` remains as a
  thin allocating wrapper for `probe`/tests.
- No `unsafe` was added; `hoiko-core` still has `#![forbid(unsafe_code)]`.
  No evaluation math, expansion semantics, tie-breaks, beam limits, trust rate,
  depth limits, offset logic or FFI layout changed.

## Measured allocation traffic (one depth-14 search, 71 600 nodes)

| | allocs | alloc bytes |
|---|---|---|
| baseline | — | — |
| after step 3 (buffers reused) | 145 | 50.5 MB |
| final | **131** | **13.3 MB** |

## CPU hardware counters (`perf stat`, 30 searches)

| counter | baseline | final | ratio |
|---|---|---|---|
| cycles | 15.44 B | 6.31 B | 2.45× |
| instructions | 25.10 B | 13.00 B | 1.93× |
| branches | 5.16 B | 2.66 B | 1.94× |
| branch-misses | 123.0 M | 46.7 M | 2.63× |
| cache-misses | 162.0 M | 40.6 M | 3.99× |

## Verification (all green after the change)

- `cargo test` → 45 passed; 0 failed.
- `cargo run --release --example bench_search` → `71600 nodes/move, depth14`.
- `tools/hoiko-oracle/diff/diff.ts` → **9/9 first-move match**, `DELAY-OK`.
- `tools/hoiko-oracle/diff/twosearch.ts` → **9/9 beam-adaptation match**.
- `bash rust/build.sh` → `src/ai/hoiko/hoiko_core.wasm` rebuilt (103 071 bytes);
  `wasm_smoke.ts` instantiates and exposes `h_search`/`h_alloc`/`h_dealloc`;
  `rust/verify.mjs` bit primitives correct. FFI `size_of` unchanged
  (input 1496 B, output 208 B).

---

# Second pass — collision / Shape / clone optimizations

Goal: attack the actual profile hotspots (not allocations this time). Measured
with `cargo run --release -p hoiko-core --example bench_search` (depth-14 empty
board, 71 600 nodes):

| | ms/move | nodes/move | notes |
|---|---|---|---|
| start of this pass (after the arena pass) | 64.3 | 71 600 | measured on this machine |
| after the changes below + `lto` release | **31.7** | **71 600** | `2259 k nodes/s` |

That is a further **2.0×**. From the original naive port (≈160 ms) the total is
≈5×. The shipping binary is ≈101 ms, so the Rust engine is now ≈3× the binary's
speed at identical results.

## What changed (commit by commit)

1. **`shapes.rs` — inline Shape cells, const table instead of `OnceLock`.**
   `Shape.cells` was a heap `Vec<Cell>`; every hit test chased the `NonNull`
   pointer and iterated a slice. Now the four cells are inline (`[Cell; 4]` +
   `len`) and the per-`(mino, rotation)` metadata lives in a `const` static
   table, so `shape_for()` is an indexed load with no atomic and no runtime
   build. `r & 3` is exact for two's-complement `i32`.
   *A/B: instructions 12.14 B → 11.03 B (−9.2%), branches 2.41 B → 2.23 B (−7.7%).*
2. **`board.rs` — combine `collision_distance` cells into per-row masks.**
   `collision_distance` was ~33% of runtime, redoing `col = x + cell.x` and
   `1 << (9-col)` for 4 cells on every candidate drop row. At fixed `x` the
   piece footprint is a per-row bitmask independent of `s`, so build the masks
   once and AND one mask per occupied row. Floor check and limit unchanged.
   *A/B: 40.7 → 35.1 ms (−14%), instructions 11.01 B → 8.78 B (−20%).*
3. **`board.rs` — start `collision_distance` at the first collidable row.**
   Rows above `stack_height` are empty, so the scan can start at
   `mino.y - max_y - stack_height` (clamped ≥1); the scan is now
   `O(stack_height)` instead of `O(mino.y)`.
   *A/B: 35.4 → 28.6 ms (−19%), instructions 8.78 B → 7.00 B (−20%).*
4. **`board.rs` — single-pass `get_column_height_zeroed`.** The monotonic OR
   accumulator lets each column's count be derived from the iteration it first
   appears, instead of re-testing 10 columns every row.
   *A/B: 45.5 → 43.5 ms (−4.5%), branch-misses 45.8 M → 35.3 M (−23%).*
5. **`expand_template.rs` / `expand_derive.rs` — fewer `Baby`/`Rc` clones.**
   `expand_template_node` cloned `babies.first()` (full `Baby` + `Rc` bump) and
   immediately overwrote `next_it` (second `Rc` bump); it now builds from
   `Baby::default()` with a single copy. `expand_derive_node` cloned `cand`
   only to push it; it now moves.
   *A/B: 42.9 → 41.8 ms median, instructions 11.075 B → 11.015 B.*

Two new tests pin byte-identical output against the original per-cell loops:
`board::tests::collision_distance_matches_reference` (50 k random boards ×
pieces) and `board::tests::column_height_zeroed_matches_reference` (20 k random
boards).

## Verification

- `cargo test` → **47 passed**; 0 failed.
- `bench_search` → exactly **71 600 nodes/move**, depth 14.
- Oracle `diff.ts` → **9/9 first-move**, `twosearch.ts` → **9/9 beam-adaptation**,
  run against the rebuilt wasm.
- `src/ai/hoiko/hoiko_core.wasm` rebuilt (103 071 → 104 227 bytes).
- **No behavioral drift**: a 150-position random differential across the
  original, pre-pass and post-pass wasm produced identical
  `(x, y, rotation, hold, score, node)` on every position (0 mismatches).

---

# Third pass — branchy primitives → masks, and node-layout slimming

Goal: same zero-drift engine, faster again. Measurement is pinned and repeated
because wall-clock alone is noisy (`load ≈ 2-3`):

- Native: `BENCH_REPS=300 taskset -c 2 cargo run --release -p hoiko-core --example bench_search`
  (env var added; default stays 30), hardware counters with
  `perf stat -r 3 -e cycles,instructions,branches` and the same 300 reps.
- Wasm: `bun rust/bench_wasm.mjs 100` (new Bun bench, 5 warmup calls, median +
  trimmed mean; it writes `HSearchInput` in declaration order, mirroring
  `bench_search`). `HOIKO_WASM=<path>` selects the artifact.
- All builds report exactly **71 624 nodes/move** before and after.

## Results

Native (depth-14, empty board, 71 624 nodes):

| | before | after | Δ |
|---|---|---|---|
| ms/move (300 reps, pinned, perf `-r 3`) | 30.7–30.9 | 28.1–28.4 | **−8 %** |
| cycles/search | 116.52 M | 106.92 M | **−8.2 %** |
| instructions/search | 237.29 M | 214.11 M | **−9.8 %** |
| branches/search | 39.68 M | 35.17 M | **−11.4 %** |
| nodes/s | ~2.32 M | ~2.52 M | +8.8 % |

Wasm (`bun bench_wasm.mjs 100`, warmup, pinned):

| | median ms/move | trim-mean | nodes/s | artifact |
|---|---|---|---|---|
| before (raw cargo wasm) | 38.3–38.9 | 38.2–38.9 | ~1.83–1.86 M | 86 878 B |
| after (engine only) | 36.0–36.1 | 36.0–36.1 | ~1.98 M | 84 704 B |
| **after + `wasm-opt -O4`** | **35.6–35.9** | **35.5–35.8** | ~2.00 M | **71 921 B** |

That is ≈**−7.4 %** wasm wall time and **−17 %** artifact size; the engine alone
accounts for ≈−6.6 % of the wall time, `wasm-opt -O4` for the last ≈0.8 % plus
the size win (see `build.sh`, which applies it when binaryen is installed).

## What changed

1. **`board.rs` — collision tests on per-row masks.** `hit_at` (used by
   `collision_bottom/left/right`) and `hit_at_cols_in_board` (used by
   `collision_board`/SRS spins) iterated the four cells, doing a column bounds
   check and a per-cell shift each. They now shift the shape's precomputed
   `row_mask` once per local row: right-shift drops cells right of the board,
   left-shift puts cells left of it above bit 9 (where `line` is always clear).
   `collision_distance` builds its footprint the same way. New pinning test
   `row_mask_collision_and_lock_match_reference` (20 k random boards × pieces)
   compares all four collision queries and `lock_mino` against the original
   per-cell loops.
2. **`board.rs` — `lock_mino` on row masks.** The same shift trick replaces the
   per-cell write loop (out-of-range cells are dropped or masked with
   `FULL_ROW`, so no bit above column 9 is ever written).
3. **`search.rs` — gen-1 origin record.** Every node's first-move identity
   (`first_x/r/m/hold/act/delay/y/last_srs` + the 136-byte `FirstMoveState`
   board) came from its gen-1 ancestor but was copied onto every node. It is now
   one `Origin` record per gen-1 child, referenced by a `u32` index.
4. **`search.rs` — plan by parent index.** The 68-byte `Acts` chain was copied
   onto every child (71 k/move) even though only beam survivors need it.
   `NodeState` now stores `(parent, act)`; survivor plans are rebuilt at
   selection time (150/gen) and the winner's plan is `plans[parent] + act`.
   `NodeState` shrank from ≈517 B to ≈276 B, cutting the `children` vector
   traffic roughly in half.
5. **`baby.rs`/`expand*.rs` — `NextCursor` instead of `Rc` in `Baby`.** All
   babies of an expansion share the same `NextMino`; carrying an `Rc` in each
   `Baby` meant an inc/dec pair on every one of the ~5 clones per baby in
   `expand_base_node`/`expand_derive_node`. `Baby` now stores a `Copy`
   `{base, trust_end}` cursor; the iterator (with its `Rc`) is materialised once
   per child in `regist_child_node` (and once for the hold pass).
6. **`expand.rs` — packed dedup key.** `delete_same_node` compared four board
   rows + `act` per bucket entry; the bucket now stores a `u64` packing exactly
   those five fields, so a scan is one comparison (same first-match, same
   `move_delay` replacement rule).
7. **`mino.rs` — `add_commands` uses one `copy_from_slice`** instead of a
   bounds-checked `push` per command byte.
8. **`board.rs` — `get_column_height_zeroed`** iterates `line[..=stack_height]`
   with a slice iterator (removes the per-row bound check).
9. **`evaluate/terms.rs` — hoisted row reads** in `get_well_column` (slice
   loops), `get_underground` (one row read per row), `get_ground` (one row read
   per row).
10. **`build.sh` — `wasm-opt -O4` post-processing** when binaryen is present
    (with a raw-copy fallback), plus a rustup-toolchain fallback for distro
    rustc builds whose wasm32 `std` is from a different compiler build (E0514).

## Tried and reverted (measured, did not help)

- `Shape.occ` occupied-row list in `collision_distance` (+2.7 % instructions):
  the fixed four-row loop unrolls better than a variable-length list.
- Local row hoists in `search_tsd` / `search_tst` (neutral to +0.5 %):
  LLVM already CSEs the `row_at` calls.
- Parallel `scores: Vec<i32>` for `std_partial_sort` (+1.1 % cycles): the extra
  pass over `children` cost more than the better comparison locality saved.
- Building `expand_template_node`'s `Baby` field-by-field to skip
  `Baby::default()` zeroing (neutral).
- Routing `collision_board` through the general `hit_at` (neutral; the
  columns-bounded variant is kept).
- `#[inline(always)]` on `row_at` (kept: neutral in wall clock, tiny
  instruction win, removes out-of-line calls).

## Verification (all after the final build)

- `cargo test --manifest-path rust/Cargo.toml` → **hoiko-core 60 passed**
  (incl. the new row-mask/lock differential), deepseek green.
- `bench_search` → exactly **71 624 nodes/move**, depth 14.
- Oracle (`bun tools/hoiko-oracle/diff/...`): `diff.ts` **9/9** (depth 10),
  `diff.ts --timer` **9/9** (depth 14), `twosearch.ts` **9/9**,
  `eval.ts` **no eval mismatch** (partial_sort emulation reproduces the exe
  move + node count), `nextcarry.ts --ts-only` matches.
- `fullgame.ts --cap=500 --seed=1` → **500/500 moves**, `actMismatches=0`,
  `stateMismatches=0`.
- `expand.ts`'s synthetic H1/H2 fuzz still shows its pre-existing pos-8
  `tall#2` mismatch; verified identical on a clean-baseline rebuild, so it is
  not a regression (the E3 turn-183 child-set differential passes).
- `bunx tsc --noEmit`, `bun test` (**124 passed**), `bun run lint`,
  `bun run build` all green; `rust/verify.mjs` primitives unchanged; FFI
  `size_of` unchanged.

