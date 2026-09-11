# Prep — Rust/WASM port of the Hoiko engine

Status: PREP ONLY (not started). Search is already oracle-matched (9/9, 2/2);
`OffsetOffAI` integration is in flight separately. This document captures the
feasibility findings so the port can start the moment we choose to.

## Motivation (measured)

The TS search is correct but slow:

| | depth 14 / ~71.6k nodes | rate |
|---|---|---|
| shipping binary (`Hoiko.exe`) | **101 ms** | 709k nodes/s |
| TS engine (Bun) | **~430 ms** | 166k nodes/s |

The binary's real in-match timer is `GetDelay - 5 ms` (≈107 ms for a no-clear move), so
under that budget the binary still reaches depth 14 (101 ms) while TS is cut at the
`minDepth=10` floor. That is a concrete strength loss, independent of the missing
`OffsetOffAI`.

## Where the time goes (profiled)

| fn | cost |
|---|---|
| `evaluate` | **1.0 µs/node** |
| `expandNode` | **~124 µs/call** (19–51 children) |
| `GamePack new + board.line.set` | 0.56 µs |
| `GamePack copy + lockDown` | 3.03 µs |
| `shapeFor` / popcount etc. | 0.06 µs (negligible) |

The bottleneck is **per-node object allocation / copy (GC pressure)**, not arithmetic.
That is exactly what a Rust value-type + arena implementation removes.

## Method comparison

| Method | Speed vs TS | Cost | Risk | Verdict |
|---|---|---|---|---|
| **Rust → WASM (full port)** | ~1.8–3.8x | medium | low (port of an already-verified reference + oracle can verify) | **recommended** |
| TS optimization (arena / typed arrays / no clone) | ~2–3x | medium | medium (may still miss the 107 ms budget) | fallback |
| C++ (`hoiko-src`) → Emscripten | ~4x | medium | **high** (src is the older revision: `ExpandBaseNode` etc. missing, eval stubbed) | avoid |
| Hybrid (only hot fns in WASM) | low | medium | high (per-node boundary marshalling dominates) | avoid |

## Toolchain — VERIFIED WORKING

- System has `rustc`/`cargo` 1.95 but no `rustup` and no wasm target.
- Installed rustup to `/tmp` (non-invasive): `RUSTUP_HOME=/tmp/opencode/rustup CARGO_HOME=/tmp/opencode/cargo`
  `rustup target add wasm32-unknown-unknown` → installed.
- `[lib] crate-type = ["cdylib"]`, `opt-level = 3`, `lto = true` builds a `.wasm`.
- **Bun runs it**: `WebAssembly.instantiate(bytes)` + exported fns. End-to-end sanity passed
  (`popcount10(0x3ff)=10`, `log2_hoiko(512)=0`).
- **Rust edition 2024 gotcha**: exported fns need `#[unsafe(no_mangle)]` (plain
  `#[no_mangle]` is a hard error on 1.95).
- Need to export an allocator (or pass a caller-owned linear-memory buffer) so the host
  can hand a board in and get a move out; start from a fixed scratch region to keep the
  boundary zero-copy.

## Debugging — the real concern, and why it is LOW risk here

WASM debugging *in general* is harder: no `console.log`, panics become opaque
`unreachable` traps, DWARF source maps are partial, and stepping needs browser/Node
inspector support. **We avoid all of that:**

1. **Debug natively, ship WASM.** The crate compiles to a normal `x86_64-unknown-linux-gnu`
   binary too (verified: `cargo run` prints). The logic is pure (no OS/timer/IO), so native
   and wasm behave identically. Use `println!`, `RUST_BACKTRACE=1`, `gdb`/`rust-gdb`
   natively; only `--target wasm32-unknown-unknown` for shipping.
2. **No browser debugging.** The search is deterministic and pure; it is exercised from
   Bun/Node in tests, never stepped in a browser.
3. **Differential testing by construction.** We already have:
   - the TS reference (oracle-matched 9/9),
   - 32 golden fixtures (`verify/golden.ts`),
   - the Wine oracle (absolute ground truth).
   Build a harness that runs TS, Rust-native, and WASM on the same positions and asserts
   identical output. A divergence localizes to one function, which is then debugged
   natively.
4. **Panic hygiene.** Add `console_error_panic_hook` (or return typed error codes) so a
   Rust panic surfaces a message instead of a bare trap.

Net: the WASM-specific debugging cost is close to zero because every bug is reproduced and
fixed in the native Rust build first.

## Benchmarking pitfall (learned)

A naive microbench marked the loop-invariant work as eliminable: LLVM hoisted the body and
reported an impossible 40M M iter/s. **Every bench must have a data dependency** (feed the
accumulator back into the next iteration) or use `std::hint::black_box`. The corrected
numbers above (1.8x wasm / 3.8x native) are the trustworthy ones.

## Proposed layout

```
crates/hoiko-core/        # no_std-friendly, pure logic; no JS/WASM deps
  board.rs    mino.rs   shapes.rs   gamepack.rs   nextmino.rs
  expand.rs   evaluate/ (terms, tsd, tst, dtcannon, pc)   search.rs   offset.rs
  ffi.rs      # #[unsafe(no_mangle)] search(...) -> *const MoveResult
crates/hoiko-wasm/        # wasm32 cdylib wrapper (small; allocator + boundary)
```

FFI: one call per move — input: board rows + current + next queue + hold + combo + btb +
garbage state; output: `{ x, rotation, y, lastSrs, planActs[..], garbageWait }`. One call
per move means boundary cost is negligible.

## Verification plan

1. Port `board/mino/shapes/gamepack/nextmino` → assert vs TS unit fixtures.
2. Port `expand` + `evaluate` → assert vs `verify/golden.ts` + TS A/B.
3. Port `search` → assert first move equals TS on the 9 oracle positions at depth 10 and
   depth 14; then run the full differential harness (TS vs Rust-native vs WASM) over
   thousands of random positions.
4. Wire `offset.rs` and re-check the app-level versus behaviour.
5. Ship the `.wasm` into the app behind the same `VersusFighter` adapter.

## Estimated effort

Design/FFI ~30 min; Rust translation in parallel (5 agents, TS files are the spec) ~1–2 h;
toolchain/build ~30 min (done); oracle + differential verification ~30 min. **≈ half a day**,
low risk because the reference is verified and the oracle can prove correctness.
