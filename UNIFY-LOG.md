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

# Attax Unification Log (Item 97 Chunk 2)

## Step 1: Checkpoint

- Committed Chunk 1's `UNIFY-LOG.md` as docs commit `f6df0a9` (`docs: record item 97 chunk 1 in UNIFY-LOG.md`). `tools/unify/regression-*.jsonl` remain untracked run artifacts.

## Step 2: Cherry-pick dedupe adoption (`fd842ca`)

- Skipped sibling `01a5817` (`WIP: audit dedupe key fidelity (combo/lift)` — empty WIP checkpoint).
- Cherry-picked `fd842ca` (`search: dedupe key includes combo, lift and canHold (state fidelity fix)`) cleanly as `3038d09` (no conflicts):
  - `src/ai/bot/search.ts`: `dedupe()` now includes `canHold`, `lift`, and `combo` (with `combo` folded to `-1` when `guideline` is `true`), and `search()` passes `options.guideline ?? false`.
  - `rust/attax-search/src/search.rs`: `DedupeKey` and `dedupe()` mirrored identically with `options.guideline`.
  - `tests/bot-search.test.ts`: added `"beam dedupe key"` (5 tests).
  - `tools/search-port/dedupe-measure.ts`, `tools/search-port/lift-vs-rows.ts`: added.
- **Gates (post-cherry-pick `3038d09`)**:
  - `tsc --noEmit`: PASS
  - `bun test`: PASS (`174 pass`, `0 fail`, `13229 expect()` calls across `22` files)
  - `bun run lint` (`biome check .`): PASS (`156` files checked, `0` fixes needed)
  - `bun run build` (`tsc --noEmit && vite build`): PASS (built in `912ms`)
  - `cargo test --manifest-path rust/Cargo.toml`: PASS (`attax_search`: `6` passed; `attax_agree`: `1` passed; `hoiko_core`: `60` passed; `0` failed)

## Step 3: Guideline A/B — Hoiko regression (`1001-1200`, `--sides both`, `HOIKO_ADAPT=0`)

- Ran 4 x 50-seed chunks into `tools/unify/regression-dedupe-<range>.jsonl`, compared per-game against `bench-results/bot-vs-hoiko.jsonl`:
  - `1001-1050`: `94-6`, `8` winner diffs
  - `1051-1100`: `96-4`, `6` winner diffs
  - `1101-1150`: `96-4`, `4` winner diffs
  - `1151-1200`: `92-8`, `6` winner diffs
- **Aggregate A/B verdict: `378-22` games, `0` draws, `24` winner diffs vs the published `390-10` record.** The regression does NOT hold, so under the pre-registered rule (QUEUE item 97; Souta 2026-11-15 17:10 + 23:50 amendment) the unconditional dedupe key is REJECTED for the guideline profile and ADOPTED for the S2 profile only. The key is converted to profile-conditional form (Step 4). The published `390-10` (`195-5` seed pairs) stands as the old key's record either way.
- Lane note: the agy lane running this chunk died on 2026-11-16 11:48:15 JST with quota `429 RESOURCE_EXHAUSTED` (`agy_exit=3`) after the A/B files had landed. The heartbeat patrol (11:54 JST) declared the stream stalled and restarted it with a new coordinator; the A/B numbers above were independently re-verified by that coordinator from the `.jsonl` files (same totals, same per-chunk split, `24` diffs).

## Step 4: Profile-conditional conversion (restarted stream, 2026-11-16)

- **WIP checkpoint**: `429a5c2` — the chunk-2 log section above plus the dead lane's uncommitted TS draft of the conversion found in the working tree (`src/ai/bot/search.ts`). `dist/` churn excluded.
- **Conversion commit**: `06b9e46` (`search: profile-conditional dedupe key (guideline keeps legacy key, s2 keeps full provenance)`), implemented by a Claude Code lane (`run-claude.sh`, unit `attax97-profilecond`, `claude_exit=0`; prompt `~/workspace/attax-unify-prompt3.txt`) and re-verified gate-by-gate by the coordinator:
  - `src/ai/bot/search.ts` (from the checkpoint draft, verified character-for-character): `SearchProfile = "guideline" | "s2"`, `SearchOptions.profile?`, default `"guideline"`. Guideline key is exactly the pre-`fd842ca` legacy key `` `${next}|${hold}|${b2b ? 1 : 0}|${board.join(",")}` `` (no `canHold`/`combo`/`lift`); S2 key is the full `fd842ca` key (combo folded to `-1` under the guideline rig). `selectBeam` unchanged (it already used the full key pre-`fd842ca`).
  - `rust/attax-search/src/search.rs`: mirrored identically — `SearchProfile { Guideline, S2 }` enum, `SearchOptions.profile`, two-variant `DedupeKey` (`Guideline(u32, Option<Kind>, bool, Board)` / `S2(u32, Option<Kind>, bool, bool, i32, i32, Board)`). `rust/attax-search/src/lib.rs` exports `SearchProfile`; the one construction site in `rust/attax-search-cli/src/main.rs` pins `Guideline` (behaviour unchanged).
  - `src/ai/bot/fighter.ts`: `BotOptions.profile?` threaded through to `search()` (spread only when set; default stays guideline, so `scripts/benchmark.ts` — which passes neither `guideline` nor `profile` — reproduces the frozen record).
  - `tests/bot-search.test.ts`: combo/lift/canHold separation tests now pass `"s2"` explicitly; the guideline-rig combo-fold test runs under `"s2"` with `guideline=true`; new pins verify the guideline profile (and the no-profile default) MERGE nodes differing only in combo, lift or canHold, and still separate on b2b/hold/queue index.
- **Gates (post-conversion `06b9e46`, coordinator re-run)**:
  - `tsc --noEmit`: PASS (run via `./node_modules/.bin/tsc`; `bunx` is not on these shells' PATH)
  - `bun test`: PASS (`176 pass`, `0 fail`, `13243 expect()` calls across `22` files)
  - `bun run lint` (`biome check .`): PASS (`156` files checked, `0` fixes needed)
  - `bun run build` (`tsc --noEmit && vite build`): PASS (built in `890ms`; `dist/` churn restored afterwards, not committed)
  - `cargo test --manifest-path rust/Cargo.toml`: PASS (`attax_search`: `6` passed; `attax_agree`: `1` passed; `hoiko_core`: `60` passed; `0` failed)

## Step 5: Profile-conditional regression — Hoiko (`1001-1200`, `--sides both`, `HOIKO_ADAPT=0`)

- Ran 4 x 50-seed chunks (systemd unit `attax97-regression-pc`) into `tools/unify/regression-profilecond-<range>.jsonl`, compared per-game against `bench-results/bot-vs-hoiko.jsonl`:
  - `1001-1050`: `98-2`, `0` winner diffs, `0` stat diffs (ticks/lines/sent)
  - `1051-1100`: `94-6`, `0` winner diffs, `0` stat diffs
  - `1101-1150`: `100-0`, `0` winner diffs, `0` stat diffs
  - `1151-1200`: `98-2`, `0` winner diffs, `0` stat diffs
- **Aggregate verdict: PASS — `390-10` games (`195-5` seed pairs, `0` draws), exact per-game reproduction of the published record across all `400` games.** The guideline side is restored bit-for-bit under the legacy key; the S2 profile keeps the full combo/lift/canHold provenance in both TS and Rust.
- **Chunk 2 status: COMPLETE.** Final tree: `06b9e46` on `unify/consolidation-2026-11-16`. Next is chunk 3 (single-core restructure). NO PUSH — the unified tree is reported to Souta before any push.
