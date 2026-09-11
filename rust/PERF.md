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
