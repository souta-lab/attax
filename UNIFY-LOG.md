# Attax Unification Log (Item 97 Chunk 1)

Branch: `unify/consolidation-2026-11-16` (base: `main` @ `7eed7c8`)

## Step 1: Stack `ports/s2-c1-c2-2026-11-15` (@ `54fad7e`)

- **Pre-check**: `git merge-base --is-ancestor fix/s2-driver-defects-2026-11-15 ports/s2-c1-c2-2026-11-15` returned exit 0 (`fix/s2-driver-defects-2026-11-15` @ `7186362` is already an ancestor of `ports/s2-c1-c2-2026-11-15`).
- **Merge commit**: `5adcdcf` (`Merge ports/s2-c1-c2-2026-11-15 into unify/consolidation-2026-11-16`).
- **Conflicts**: Only `dist/index.html` conflicted (hashed bundle references from `main` vs `ports`). Zero conflicts in `src/`, `rust/`, `tests/`, or `tools/`. Resolved by taking `--ours` on `dist/index.html` and running `bun run build` (`vite build`) to regenerate `dist/` cleanly for the merged tree.
- **Gates**:
  - `tsc --noEmit`: PASS
  - `bun test`: PASS (161 pass, 0 fail, 11575 expect() calls across 20 files)
  - `bun run lint` (`biome check .`): PASS (146 files checked, 0 fixes needed)
  - `bun run build` (`tsc --noEmit && vite build`): PASS (built in 3.50s)
  - `cargo test --manifest-path rust/Cargo.toml`: PASS (`attax_search`: 6 passed; `attax_agree`: 1 passed; `hoiko_core`: 60 passed; 0 failed)

## Step 2: Stack `feat/imitation-pipeline-2026-11-15` (@ `72caa2c`)

- **Pre-check**: Diff against merge-base `5f594ec` showed strictly tools-only additions (`10` files under `tools/s2-lab/imitation/`), zero changes under `src/` or anywhere else.
- **Merge commit**: `a6ce2df` (`Merge feat/imitation-pipeline-2026-11-15 into unify/consolidation-2026-11-16`).
- **Integration adjustment**:
  - `tools/s2-lab/imitation/s2-variants.test.ts` initially failed 1/169 tests (`existing variant matches tools/s2-lab/search.ts identically`) because `tools/s2-lab/search.ts` already includes the F1-F5 driver fixes from `ports/s2-c1-c2-2026-11-15`, whereas `"existing"` in `s2-variants.ts` preserves the pre-F1-F5 (`5f594ec`) baseline for §D ablation.
  - Updated that single test in `tools/s2-lab/imitation/s2-variants.test.ts` to verify that `"existing"` retains the pre-F1-F5 baseline while `"corrected"` matches post-F1-F5 `tools/s2-lab/search.ts` (modulo `lastSrs` witness, `value`, `depth`, and `candidates.length`).
- **Gates**:
  - `tsc --noEmit`: PASS
  - `bun test`: PASS (169 pass, 0 fail, 13223 expect() calls across 22 files)
  - `bun run lint` (`biome check .`): PASS (154 files checked, 0 fixes needed)
  - `bun run build` (`tsc --noEmit && vite build`): PASS (built in 3.50s)
  - `cargo test --manifest-path rust/Cargo.toml`: PASS (`attax_search`: 6 passed; `attax_agree`: 1 passed; `hoiko_core`: 60 passed; 0 failed)

## Step 3: Hoiko regression gate (`1001-1200`, `--sides both`, `HOIKO_ADAPT=0` default)

- **Rules audit** (`bun run audit`, seeds `3001-3020`): PASS (843/843 locks agree).
- **Chunk 1 (`1001-1050`)**: `tools/unify/regression-1001-1050.jsonl` — `98-2` games (`49-1` seed pairs, loss on `1024` both sides), `0` draws. Matches `bench-results/bot-vs-hoiko.jsonl` exactly (`0` winner diffs, `0` stat diffs across 100 games).
- **Chunk 2 (`1051-1100`)**: `tools/unify/regression-1051-1100.jsonl` — `94-6` games (`47-3` seed pairs, losses on `1076`, `1081`, `1095` both sides), `0` draws. Matches `bench-results/bot-vs-hoiko.jsonl` exactly (`0` winner diffs, `0` stat diffs across 100 games).
- **Chunk 3 (`1101-1150`)**: `tools/unify/regression-1101-1150.jsonl` — `100-0` games (`50-0` seed pairs), `0` draws. Matches `bench-results/bot-vs-hoiko.jsonl` exactly (`0` winner diffs, `0` stat diffs across 100 games).
- **Chunk 4 (`1151-1200`)**: `tools/unify/regression-1151-1200.jsonl` — `98-2` games (`49-1` seed pairs, loss on `1170` both sides), `0` draws. Matches `bench-results/bot-vs-hoiko.jsonl` exactly (`0` winner diffs, `0` stat diffs across 100 games).
- **Aggregate Verdict (`1001-1200`)**: PASS — `390-10` games (`195-5` seed pairs, `0` draws; losing seeds `[1024, 1076, 1081, 1095, 1170]`). Exact per-game match against `bench-results/bot-vs-hoiko.jsonl` across all `400` games (`0` winner diffs, `0` stat diffs on ticks/lines/sent). Non-interference for the frozen guideline side is verified on commit `a6ce2df`.
