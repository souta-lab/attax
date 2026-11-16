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

# Attax Unification Log (Item 97 Chunk 3a — first increment of the single-core restructure)

Chunk 3 in full (one search core in `src/`, `tools/s2-lab/search.ts` deleted, S2 as
data-only profile) is NOT complete. This run landed its scoped first increment —
the foundation the remaining steps build on — with the guideline side proven
bit-identical. The full step plan lives in `docs/UNIFIED-CORE.md`.

## Step 1: Restart + lane

- Restarted by heartbeat lane 0 at 13:04 JST (stall confirmed: stream-log last
  12:33, no agent/unit for chunk 3). Coding delegated to Claude Code via
  `lane-runners/run-claude.sh` (unit `attax97-chunk3a`, `claude_exit=0`; prompt
  `~/workspace/attax-unify-prompt4.txt`). agy NOT used (quota 429 until ~14:59).
- Coordinator reviewed the full diff before accepting it (b2b boundary
  conversion, dedupe/selectBeam key construction, state threading).

## Step 2: What landed (commit `705b11f`)

- **`src/core/profile.ts`** (new): `RULES_PROFILE_TABLE` — guideline vs S2 as
  pure data (`attackRules`, `surge`, `comboInAttack`, `garbageSemantics`
  `"root-lift"`/`"materialized-carried"`, `deathHeight` `"boardLength"`/`21`,
  `rotate180`, `spinEvidence`, `spinClassifier`, `dedupe`, board/visible rows)
  + `rulesProfile()`. All values verified against both searches' code; no
  corrections were needed.
- **`src/ai/bot/state.ts`** (new): ONE per-node state record `NodeState`
  (board, garbageRows, hold, canHold, next, b2bChain, b2bActive, combo,
  pending, lift, dueThisLock, bagRemaining, tSlot), `rootState()`, and
  `evaluatorView()` (the evaluator sees b2b/hold/bag through the record, per
  the 2026-11-15 23:50 amendment). `SearchInput` moved here and is re-exported
  from `search.ts` (avoids a state↔search circular import).
- **`src/ai/bot/search.ts`**: the internal `Node` now carries
  `state: NodeState` as its ONLY copy of those fields; search / expand /
  pieceOptions / dedupe / selectBeam all read through `node.state`. Guideline
  b2b is stored as a 0/1 chain with the identical boolean outcomes
  (`b2bActive = chain > 0`); dedupe keys are constructed identically.
- **`src/ai/bot/stock.ts` / `src/ai/bot/solvency.ts`** (new): Φ and solvency
  moved from `tools/s2-lab` into `src/` as shared mechanisms, with
  `stockStateFrom(state, features, multiplier)` / `solvencyStateFrom(state,
  features)` building their inputs FROM a `NodeState`. The tools files are now
  thin re-export shims; `tools/s2-lab/search.ts` is completely untouched, so
  S2 behaviour is unchanged.
- **`docs/UNIFIED-CORE.md`** (new): target architecture, the itemised
  src-vs-s2-lab search diff inventory, and the remaining steps with gates.
- **`tests/bot-state-profile.test.ts`** (new): 9 tests pinning every profile
  field for both profiles, rootState/evaluatorView (b2b/hold/bag through the
  record), and the stock/solvency state builders.

## Step 3: Gates (coordinator re-run on `705b11f`)

- `tsc --noEmit`: PASS (via `./node_modules/.bin/tsc`)
- `bun test`: PASS (`185 pass`, `0 fail`, `13310 expect()` calls across `23` files)
- `bun run lint`: PASS (`161` files checked, `0` fixes needed)
- `bun run build`: PASS (built in `993ms`; `dist/` churn restored, not committed)
- `cargo test --manifest-path rust/Cargo.toml`: PASS (`attax_search`: `6` passed; `attax_agree`: `1` passed; `hoiko_core`: `60` passed; `0` failed)

## Step 4: Hoiko regression — non-interference gate (`1001-1200`, `--sides both`, `HOIKO_ADAPT=0`)

- Ran 4 x 50-seed chunks (systemd unit `attax97-regression-chunk3a`) into
  `tools/unify/regression-chunk3a-<range>.jsonl`, compared per-game against
  `bench-results/bot-vs-hoiko.jsonl`:
  - `1001-1050`: `98-2`, `0` winner diffs, `0` stat diffs (ticks/lines/sent)
  - `1051-1100`: `94-6`, `0` winner diffs, `0` stat diffs
  - `1101-1150`: `100-0`, `0` winner diffs, `0` stat diffs
  - `1151-1200`: `98-2`, `0` winner diffs, `0` stat diffs
- **Aggregate verdict: PASS — `390-10` games (`195-5` seed pairs, `0` draws),
  exact per-game reproduction of the published record across all `400` games.**
  The state-record refactor is behaviour-identical on the guideline side.
- Run note: the first unit launch was stopped at ~3 min over a cosmetic
  `cd ~` failure (transient units have no HOME); it had in fact been running
  from the systemd working-directory and had recorded no games. The relaunch
  (absolute paths + HOME set) ran the full set fresh — no seeds changed, the
  first completed run is the record.

## Chunk 3 status: INCREMENT 3a COMPLETE — chunk 3 NOT complete

Remaining (in `docs/UNIFIED-CORE.md`, in order): (i) port the S2
award/garbage/death semantics into the shared `src/` search behind the
profile table (exact b2b chain, `awardLock("tetrio-s2")` staging + frame
multiplier, `classifyS2Spin`, materialized garbageRows + carried
pending/dueThisLock, terminal-dead death at 21, Φ/solvency/root-veto wiring
through `NodeState`); (ii) rewire `tools/s2-lab/attax-player.ts` and the
imitation variants to the shared search; (iii) delete
`tools/s2-lab/search.ts`; (iv) SPECULATE parity check (the shared core
already implements the speculativePieces chance-node logic — verify the
S2 copy matches semantically); (v) S2-side evidence (ports/contracts tests
+ lab smoke) after the port; (vi) Hoiko regression 1001-1200 exact
reproduction after every step. NO PUSH — the unified tree is reported to
Souta before any push.

### Chunk 3b step (i) — S2 semantics ported into the shared search (2026-11-16 13:56–14:27 JST)

- Golden battery captured PRE-PORT and committed first: `9c357f5` (tools/unify/s2-battery.ts, capture-s2-golden.ts, s2-golden.json — 13 S2 + 4 guideline cases, full SearchResults from the then-current lab/src searches).
- Lane A (Claude Opus 5.5 high, run-claude.sh) committed `36059c3`: SearchInput gains frame/garbageRows/b2bChain/dueThisLock/acceptRoot; src search under profile "s2" reproduces the lab search exactly (tetrio-s2 award + frame multiplier, classifyS2Spin, spinEvidence/rotate180, acceptRoot, garbage compaction + materialization, terminal death at row 21, Φ/solvency via the src builders, root veto, production lab dedupe/selectBeam keys). Guideline path unchanged (separate expand, legacy keys). Parity test tools/s2-lab/shared-parity.test.ts: all 17 cases exact (JSON-normalized for -0, which the golden cannot store). Chunk-2 S2 dedupe pins re-pinned to the production lab key (canHold merges; combo never folds; pending/garbageRows separate); guideline pins untouched.
- Coordinator verification: tsc OK, bun test 204 pass, lint clean; **Hoiko regression 1001–1200: 390W–10L, 0 diffs** (tools/unify/regression-chunk3b-*.jsonl, thinkMs excluded from comparison).
- Note: the VM rebooted once mid-verification (~14:04); the lane's commit was already on disk and the tree stayed clean.

### Chunk 3b steps (ii)+(iii) — S2 lab rewired onto the shared search; lab search deleted (2026-11-16 14:29–15:15 JST)

- Lane B (Claude Opus 5.5 high, run-claude.sh) committed `2442170`: attax-player now decides through src/ai/bot/search.ts under profile "s2". The lab input shape (numeric exact chain in `b2b`, required `dueThisLock`) lives in the new tools/s2-lab/s2-input.ts; `toSharedInput` is the single mapping onto the shared input (b2b flag + b2bChain), used by the player, the adapted tests and the capture tool. Player exported surface unchanged; run-match/league-night/eval-worker still bundle.
- Tests adapted with assertions and expect() counts untouched: contracts (6), ports (24), staging (3), s2-variants (6). Imitation variants + teacher-oracle take types from the shim only; variant behaviour unchanged.
- Player-level equivalence added to tools/s2-lab/shared-parity.test.ts (30/30): every battery case expressible as a public decision goes through projectAttax → toSharedInput → shared search and reproduces its pre-port golden exactly (best + full result); decideAttax checked the same way; mutation checks confirm the check exercises the mapping (dropping profile "s2" fails 11, collapsing the chain fails 2, combo off-by-one fails 11). capture-s2-golden re-capture from the shared core is byte-identical to s2-golden.json (sha256 d075f254…5c08 unchanged).
- tools/s2-lab/search.ts DELETED; repo-wide grep finds no import of it (only historical mentions in comments/docs).
- Coordinator verification: tsc OK, bun test 217 pass / 0 fail, lint clean, build OK (dist reverted), cargo test 6+1+60 pass; **Hoiko regression 1001–1200: 390W–10L, 0 diffs** (tools/unify/regression-chunk3b-final-*.jsonl).
- Remaining-steps (iv) SPECULATE parity and (v) S2 evidence are covered in substance by this chunk's evidence: the battery's speculative case (all 7 kinds) reproduces the pre-port lab golden exactly through the shared core, and the ports/contracts/staging suites pass under the shared core with the player-level checks as the lab smoke. 
- **CHUNK 3b COMPLETE.** Chunk 3 as a whole is complete except the item-99 adopt-branch stack (feat/adopt-c1-c5 + feat/adopt-s2-c1-c3-c5), which belongs to a later chunk. NO PUSH — the unified tree is reported to Souta first.
