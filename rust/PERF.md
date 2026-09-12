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
- `bash rust/build.sh` → `src/ai/wasm/hoiko_core.wasm` rebuilt (103 071 bytes);
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
- `src/ai/wasm/hoiko_core.wasm` rebuilt (103 071 → 104 227 bytes).
- **No behavioral drift**: a 150-position random differential across the
  original, pre-pass and post-pass wasm produced identical
  `(x, y, rotation, hold, score, node)` on every position (0 mismatches).
