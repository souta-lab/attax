# Overnight repository scan — prioritized findings

Branch: `overnight/scan` (worktree `/tmp/opencode/wt-scan`)
Date: 2026-09-12
Scope: whole repository (TS app + Rust engines + scripts/tools + docs/evidence/config).
Mode: **discovery only** — no source code was modified. This file is the only artifact.

## Gate status at scan time (confirming nothing changed)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | PASS (exit 0) |
| Lint | `bun run lint` (`biome check .`) | PASS (89 files) |
| Build | `bun run build` (`tsc --noEmit && vite build`) | PASS |
| Rust tests | `cargo test --manifest-path rust/Cargo.toml` | PASS |
| Tests | `bun test` | **FAIL — 100 pass / 1 fail (timeout)** |

`bun test` was already red before this scan (no code changed); see F3.

---

## Severity legend

- **P0 / critical** — invalidates the project's headline strength claims or breaks a required gate.
- **P1 / high** — real correctness/fairness bug, broken guardrail, or unsupported public claim.
- **P2 / medium** — correctness/test-quality/hygiene issue with contained impact.
- **P3 / low** — dead code, doc typo, portability, duplication risk.

---

# P0

## F1 — Match harness is asymmetric: fighters spend different numbers of game steps per piece (invalidates the strength claims)

- **Severity:** P0 (fairness / measurement validity)
- **Where:**
  - `src/versus/controller.ts:81-106` (`planSteps`), `:351-405` (`stepSide`), `:367-373` (one queue step per `stepIntervalMs`)
  - `src/ai/deepseek-v2.ts:182` (`steps: [{ kind: "placeAt", ... }]`)
  - `src/ai/deepseek-rust-core.ts:235` (`steps: [{ kind: "placeAt", ... }]`)
  - `src/ai/hoiko-rust-core.ts:536-547` (`steps: [...moveSteps, placeStep]`, `moveSteps` = `|Δx|` cosmetic left/right moves)
  - `src/ai/search.ts:72-89` (v1 execution = `[...path, { kind: "drop" }]`)
- **What is wrong:** The controller executes exactly one queued step per `stepIntervalMs`; a piece is only locked when the plan reaches its lock step (`drop`/`placeAt`). Because each fighter builds its own plan, each fighter locks pieces at a different rate. DeepSeek v2 uses a **single** `placeAt` step (locks in ~1 interval), while the Hoiko replica emits `|Δx|+1` steps (locks in ~`|Δx|+1` intervals, typically 3–7× slower). Both sides share the same `VERSUS_DEFAULTS.stepIntervalMs` (120 ms), so the step budget acts as an APM handicap, not a neutral clock.
- **Evidence:**
  - `controller.ts:367-373` — `while (side.queue.length > 0 && ... side.acc >= options.stepIntervalMs && locked === 0) { ... side.acc -= options.stepIntervalMs; const [head, ...rest] = side.queue; ... }`
  - `deepseek-v2.ts:182` — `steps: [{ kind: "placeAt", rotation, x, topRow, lastSrs: tspin ? 1 : 0 }]`
  - `hoiko-rust-core.ts:480-483, 536-547` — `moveSteps` pushes one `left`/`right` per column, then the `placeAt`.
  - `gate-v2.ts:166` / `hoiko-gate.ts:138` / `fitness.ts:147` / `tuner/match.ts:129` all construct the controller with the same default options for both sides.
- **Impact:** The measured results (`32-0`, `64-0`, `80-0`, `23-9`, `12-0` sweeps) compare a 1-step fighter against a multi-step fighter. The wins may be largely an artifact of faster locking, not stronger play. Every documented strength number is suspect until the step model is equalized (e.g. charge cost by actual key/rotation operations for both, or make `placeAt` cost the same as the equivalent explicit replay for both).
- **Suggested fix:** Make execution cost symmetric — either (a) charge both fighters the number of real actions implied by their plan (rotations + horizontal moves + drop), computed the same way; or (b) give both a single-step direct-placement API. Add a regression test asserting the two fighters consume the same total steps per locked piece for a fixed seed.
- **Filed as:** issue (see "Filed issues").

## F2 — App runs a different garbage configuration than every measurement harness

- **Severity:** P0 (config / measurement validity)
- **Where:** `src/main.ts:451` vs `scripts/gate-v2.ts:166`, `scripts/hoiko-gate.ts:138`, `src/ai/fitness.ts:147`, `src/tuner/match.ts:129`, `scripts/render.ts:99`.
- **What is wrong:** The app creates the controller with `{ garbageAligned: true }` (all rows of a garbage chunk share one hole; PPT-style). Every gate/tuner/fitness/render harness calls `createVersusController(...)` with **no config**, so `garbageAligned` is `undefined` → falsy → per-row holes (TEC-style). `src/core/engine.ts:274-285` branches on this. The app is also mirrored (Hoiko left / DeepSeek right, DeepSeek stepped second) while the gates put DeepSeek left (stepped first).
- **Evidence:**
  - `main.ts:442-452` — `createVersusController(hoiko, {...deepseek...}, nextSeed(), { garbageAligned: true })`
  - `gate-v2.ts:166` — `createVersusController(ourFighter, hoikoFighter, seed)` (no config)
  - `engine.ts:273-285` — `options.garbageAligned ? genGarbageHoles(1, …) : genGarbageHoles(count, …)`
- **Impact:** The number that is supposed to certify the app's opponent does not reproduce the app's rules. Any garbage-defense tuning (a v2 headline feature) is measured on a different game than the one shipped.
- **Suggested fix:** Centralize the versus config in one exported constant and use it in the app and all harnesses; add a test that the app's and gate's `createVersusController` options are deep-equal.
- **Filed as:** issue (see "Filed issues").

---

# P1

## F3 — `bun test` is red and flaky (default 5 s timeout is too tight for two heavy tests)

- **Severity:** P1 (broken required gate)
- **Where:** `tests/deepseek-rust-parity.test.ts:143` (no per-test timeout) and `tests/tuner.test.ts:90` (no per-test timeout).
- **What is wrong:** Both tests run heavy searches. The wasm-parity test at `:110` correctly sets `120000` ms, but the second test in the same file (`:143`) has no timeout and inherits bun's 5 s default. In a full `bun test` run it timed out (`[5079.56ms] ... timed out after 5000ms`); the agent's run saw `tests/tuner.test.ts:90` (`is deterministic for a fixed seed`, two 240-piece depth-6 matches) time out at ~5.6 s. Under CPU contention either test can exceed 5 s, so the suite is red/flaky, which means the CI `bun test` step (`ci.yml:21`) would fail even if Actions were restored.
- **Evidence:**
  - `bun test` → `(fail) deepseek v2 wasm parity > wasm fighter reproduces the recorded TS fixture ... [5079.56ms] this test timed out after 5000ms` / `100 pass, 1 fail`.
  - `tests/deepseek-rust-parity.test.ts:141` has `, 120000);` but `:168` has no timeout.
  - `tests/tuner.test.ts:90` runs two full matches (`:92-93`) with no `{ timeout }`.
- **Suggested fix:** Add explicit timeouts (`test(..., { timeout: 30000 }, ...)`) to both tests (or raise the global `--timeout`), then re-baseline. Do not weaken the assertions.
- **Filed as:** issue — folded into the test-suite reliability issue.

## F4 — AI attack estimate counts every T-spin as a full T-spin; engine mini-T-spin B2B rule is internally inconsistent; combo bonus appears off-by-one

- **Severity:** P1 (correctness / attack table vs PPT)
- **Where:**
  - AI scorers omit the spin kind: `src/ai/deepseek-v2.ts:233-239`, `src/ai/deepseek.ts:109-115`, `src/tuner/tuned-deepseek.ts:73-79`.
  - Engine mini handling: `src/core/engine.ts:176-177`, `:184-204`; `src/core/garbage.ts:45-67`.
  - Fixtures that freeze the AI behaviour: `tools/deepseek-v2-fixture.ts:331-360`, `tools/deepseek-fixture.ts`, consumed by `rust/hoiko-deepseek/tests/{parity.rs,v2_parity.rs}`.
- **What is wrong:**
  1. **Mini T-spins are valued as full.** Callers pass only `tspinLines: tspin ? lines : 0` with no `tspinKind`. `garbage.ts:56` then falls back to `info.tspinLines > 0 ? "full" : "none"`, so a mini T-spin double is estimated at 4 attack instead of 1. The Rust v2 port is then forced by the recorded parity fixture to reproduce the same over-valuation.
  2. **Mini T-spins never get the B2B bonus in the engine, but do advance `nativeBtb`.** `engine.ts:176` sets `tspinLines = tspin === "full" ? cleared : 0`, and `garbage.ts:63` grants B2B only when `lines === 4 || tspinLines > 0`, so mini → no B2B attack. Yet `engine.ts:177` treats mini as a difficult clear and `:200-203` increments `nativeBtb`. The documented T-spin rule says mini counts as difficult.
  3. **Combo bonus appears off by one.** `comboBonus` boundaries (`<=1→0, <=3→1, <=5→2, <=7→3, <=10→4, else 5`, `garbage.ts:45-52`) are the standard 1-based PPT combo table, but `engine.ts:181-184` passes the 0-based post-clear `combo`, so a 2-chain gets `comboBonus(1)=0` instead of the standard `+1`; the AI scorer (`deepseek-v2.ts:232`) mirrors the same 0-based value, so the AI is internally consistent but both lag the standard.
  4. **Divergence with the Rust port:** `rust/hoiko-deepseek/src/scorer.rs:77-99` has no mini branch at all (keys only off `tspin_lines`), whereas `src/core/garbage.ts:38-43` does — the same logical table exists twice with different semantics.
- **Evidence:** see the exact call sites and `garbage.ts:56,63` / `engine.ts:176-177,181-204` quoted above; `tests/garbage-mini-attack.test.ts:5` pins `combo: 0, b2bActive: false` only, so none of this is covered.
- **Suggested fix:** Thread the classification (`isV2Tspin` already distinguishes mini/full) into every `attackForClear` call, decide the mini-B2B rule and align the Rust port, then regenerate parity fixtures. Add attack-table tests for combo/b2b/PC/mini boundaries.
- **Filed as:** issue (see "Filed issues").

## F5 — CI is inert and never verifies the checked-in wasm artifacts

- **Severity:** P1 (guardrail / source↔binary drift)
- **Where:** `.github/workflows/ci.yml:3-8` (dispatch-only), `:25-34` (rust job runs only `cargo test`); binaries at `src/ai/wasm/hoiko_core.wasm` (104 227 B) and `src/ai/wasm/deepseek_v2.wasm` (100 466 B); builders `rust/build.sh`, `rust/build-deepseek.sh`.
- **What is wrong:** The app ships committed `.wasm` binaries, but CI never installs the `wasm32-unknown-unknown` target or runs `build:wasm`. A Rust change can pass `cargo test` while the shipped wasm stays stale. Separately, the one historical run (`gh run view 34628200401`) shows both jobs never started — GitHub's annotation is *"The job was not started because recent account payments have failed…"*, which also means there are no required checks on `main`.
- **Evidence:** `ci.yml:7-8` `on: workflow_dispatch:` only; `ci.yml:29-34` has checkout/toolchain/cache/`cargo test` but no wasm step; `.gitignore` states the built wasm is checked in; `git ls-files` tracks both `.wasm` files.
- **Impact:** Undetectable Rust↔wasm drift; zero automated enforcement. (The billing restore is already tracked as issue #20; the **wasm verification gap** is the new, distinct problem.)
- **Suggested fix:** Add a CI step that builds both wasm targets and asserts `git diff --exit-code -- src/ai/wasm` (or stop committing binaries and publish them).
- **Filed as:** issue (see "Filed issues").

## F6 — Doc/reality drift: unsupported 80-0 claim, wrong artifact paths, contradictory "current gate", stale verification docs

- **Severity:** P1 (documentation trust)
- **Where / evidence:**
  1. **Unbacked 80-0 / 16-0 / 64-0.** `AGENTS.md:10` and `docs/BEAT_HOIKO.md:76-79` claim *"16-0 … 64-0 … 80-0 on fresh seeds total"*, but no evidence artifact for those matches exists under `evidence/` (only the 12-seed `evidence/strength/sweep.jsonl` and `evidence/opening-book/gate.jsonl`).
  2. **Wrong path.** `docs/BEAT_HOIKO.md:99` says `Full record in evidence/strength/sweep.json`; the file is `sweep.jsonl`.
  3. **Contradictory scoreboard.** `docs/BEAT_HOIKO.md:63` calls `bun scripts/hoiko-gate.ts` "the scoreboard", but that script uses DeepSeek **v1** (`hoiko-gate.ts:14,240`), while `AGENTS.md:26` names `scripts/gate-v2.ts` (v2); the same doc later says reproduce with `gate-v2.ts` (`:85`).
  4. **Stale verification material.** `evidence/v9/verdict.md:3,10,11,26-28` references `scripts/gate.ts`, `src/ai/blueV9-score.ts`, `src/ai/redV9-score.ts`, `gate-*.log`, `render-seed1-7.log` — none exist. `evidence/v8/verdict.md:43,47,49` references `scripts/gate.ts`, `s3-summary-*.md` (actual: `ev-v8-s3-summary-*.md`) and missing `.log` files. `tools/hoiko-oracle/diff/REPORT.md:1` still says "Hoiko.exe vs TS native engine" although the harness now compares exe-vs-Rust (`MIGRATION_RUST.md:20-21`).
  5. **"Faithful port" vs the repo's own divergence list.** `AGENTS.md:9,24` and `MIGRATION_RUST.md:7` claim a verified faithful/byte-identical port, but `tools/hoiko-oracle/REFERENCE.md:105-117` still lists **D1–D8 "Divergences: current port vs binary (must fix)"**, including D6 "different child set — primary". The Rust code appears to have fixed D1 (no `correctedScore`); the section is stale and must be reconciled.
  6. **Speed claim drift.** `AGENTS.md:24` says "~2× the binary's speed"; `rust/PERF.md:21` / `rust/README.md:12-13` give ~1.5–1.6× (62–66 ms vs ~101 ms). `docs/BEAT_HOIKO.md:5` attributes the port's ~1.3 M nodes/s to the reference binary (~709 k/s per `rust/PERF.md`).
- **Impact:** The central evidence chain (claims → artifacts) is broken; a reader cannot reproduce the headline results.
- **Suggested fix:** Commit the raw 16/64-seed JSONL or label the claim local-only; fix the paths; mark v8/v9/REFERENCE §7 as superseded; align the speed multipliers.
- **Filed as:** issue (see "Filed issues").

---

# P2

## F7 — `tests/`, `scripts/`, `tools/` are never type-checked

- **Severity:** P2 (guardrail gap)
- **Where:** `tsconfig.json:27` (`"include": ["src"]`), consumed by `package.json:9` (`build: tsc --noEmit && vite build`) and `ci.yml:20`.
- **Evidence:** `tsc -p tsconfig.json --listFilesOnly` contains zero files matching `/tests/|/scripts/|/tools/`; the only tsconfig is the root one; `vite` bundles only `src/main.ts`; `bun test` strips types. That is ~39 `.ts` files with no type checking. Biome does lint them (verified: `biome check tests scripts tools` → 39 files) and currently there are no `any`/non-null assertions there, but unchecked casts exist (`scripts/tuner/eval-worker.ts:32` `JSON.parse(raw) as EvalJob`, `scripts/freeze.ts:86`, `scripts/bench.ts:59`).
- **Suggested fix:** Add a `tsconfig.all.json` extending the root with `include: ["src","tests","scripts","tools"]` and wire it into `build`/CI. (Issue #7 claimed this; it was closed without the change.)
- **Filed as:** issue (see "Filed issues").

## F8 — Test suite is largely a mirror, not an oracle (self-recorded fixtures + copied constants + big coverage holes)

- **Severity:** P2 (test quality)
- **Where / evidence:**
  1. **Parity fixtures are recorded from the implementation.** `tools/deepseek-v2-fixture.ts:334-360` stores `fighter.findBestMove(...)` as the fixture `expected`; `tests/deepseek-rust-parity.test.ts:143-168` and `rust/hoiko-deepseek/tests/{parity.rs,v2_parity.rs}` assert against it. A bug shared by TS and Rust passes.
  2. **Geometry test copies the implementation constant.** `tests/hoiko-geometry.test.ts:6-171` is a verbatim copy of `src/core/pieces.ts:12-177`; it can only fail if one copy is edited.
  3. **Genome baseline test is misnamed/self-referential.** `tests/tuner.test.ts:28-57` compares `decodeGenome(BASELINE_GENOME)` against a literal copy of `GENE_SPECS` values (`src/tuner/genome.ts:42-64`); it never reads `src/ai/deepseek.ts`.
  4. **Wrapper-vs-wrapper test.** `tests/v13-lock-transition.test.ts:60-89` compares `computeLockAfterstate` to `lockAndClear`, which both call the same `lockAndClearInPlace` (`src/core/board.ts:125,135`).
  5. **Coverage holes:** `src/core/garbage.ts:76-139` (`pushIncoming`/`cancelPending`/`tickPending`/`genGarbageHoles`/`pendingTotal`) has **no tests**; `src/ui/renderer.ts` (419 LOC), `src/tuner/job.ts`, `src/ai/hoiko-rust.ts`, `src/ai/deepseek-rust.ts` have none; controller `MAX_TICK_MS` clamp / `planSteps` / KO+rematch / `exchangeGarbage` are untested; `rust/hoiko-wasm` has zero tests and most of `rust/hoiko-deepseek/src` and `rust/hoiko-core/src` have no direct tests.
- **Suggested fix:** Add independent oracles (hand-counted T-spin/clear cases, known best moves), unit-test the garbage economy and controller edges, regenerate fixtures only after fixing F4, and add Rust unit tests for the eval/score modules.
- **Filed as:** issue (see "Filed issues").

## F9 — `scripts/hoiko-solo.ts` imports hardcoded `/home/s0u7a/browser-tetris` absolute paths

- **Severity:** P2 (portability / dead script)
- **Where:** `scripts/hoiko-solo.ts:3-4`.
- **Evidence:** `import { createEngine } from "/home/s0u7a/browser-tetris/src/core/engine.js";` and `import { createRustHoiko } from "/home/s0u7a/browser-tetris/tools/hoiko-rust/loader.js";`. The script is referenced by no doc/package.json/CI and bypasses this worktree entirely (it silently reads the main checkout).
- **Suggested fix:** Convert to relative imports (`../src/core/engine.js`) or delete the script.
- **Filed as:** issue — folded into the dead-code/repo-hygiene issue.

## F10 — `package.json` hardcodes ephemeral `/tmp/opencode` toolchain paths

- **Severity:** P2 (portability)
- **Where:** `package.json:14-17` (`test:rust`, `bench:rust`, `build:wasm`, `build:wasm:deepseek`).
- **Evidence:** Every Rust script sets `PATH=/tmp/opencode/cargo/bin:$PATH CARGO_HOME=/tmp/opencode/cargo RUSTUP_HOME=/tmp/opencode/rustup`. Those exist only on this sandbox (`/tmp` is wiped on reboot) and are absent from `rust/README.md`, which uses plain `cargo`. On any other machine or CI the four scripts fail.
- **Suggested fix:** Drop the `/tmp` overrides and rely on ambient `cargo`/rustup (optionally read a cache dir from an env var).
- **Filed as:** issue — folded into the dead-code/repo-hygiene issue.

---

# P3 — lower-severity findings (reported, not all filed)

## Doc drift (remaining)

- `scripts/shards.ts:11` usage example calls `bun scripts/shards.ts scripts/gate.ts 6`, but `scripts/gate.ts` does not exist.
- `evidence/hoiko/analysis.md:16` references `evidence/hoiko/weights/*.txt` ("complete") — the directory is absent and gitignored; `:27` still plans `src/ai/hoiko.ts`, deleted per `MIGRATION_RUST.md:10`.
- `rust/PERF.md:81` says the rebuilt wasm is 103 071 B; the committed file is 104 227 B. `rust/PERF.md:23` cites ephemeral `/tmp/opencode/re/bench_wasm.ts`.
- `docs/BEAT_HOIKO.md:90` implies the gate runs Rust; `gate-v2.ts:49` defaults `DSV2_RUST` to `false`.
- `MIGRATION_RUST.md:5` "md5-equal probe output for exe/TS/Rust" is unreproducible now that the TS engine is deleted.
- No root `README.md` exists.
- `biome.jsonc` + `.gitignore`: `evidence/` and `freeze/` are not ignored, so `biome check .` formats/checks committed evidence JSON (3 files). Low churn risk.
- `bun.lock:6` package name is `browser-tetris` while `package.json:2` is `deepseek-tetris` (frozen-lockfile still passes; stale-worktree signal).
- Tracked non-ASCII filename `evidence/notes/⚠️_MUST-READ__BASE-CHANGED__KICK-PLACEMENTS.md` (cross-platform hazard).

## Dead code / unused exports

- TS: `src/ui/types.ts:136` `AiPort`; `src/ai/types.ts:26` `Placement`, `:40` `BestMove`; `scripts/bench.ts:38` `AgentWeights`; `src/ai/hoiko-weights.ts:448` `HOIKO_DEFAULT_PRESET` (shadowed by a private redefinition in `src/ai/hoiko-rust-core.ts:30`); `tools/hoiko-oracle/diff/positions.ts:9` `MINO`.
- Rust: `rust/hoiko-core/src/weight_index.rs:20,21,51,53` (`WI_COLUMN`, `WI_PC_STACK`, `WI_COMBO_ATK`, `WI_NEXUS`); `mino.rs:152,179`; `gamepack.rs:130`; `evaluate.rs:25,26`; `board.rs:378`; `srs.rs:33,34,36`; `rust/hoiko-deepseek/src/beam.rs:26`; `pieces.rs:13,36`.
- `rust/hoiko-deepseek/src/api.rs` (v1 API) is only used by examples/tests, not the shipped wasm.

## TS↔Rust duplication (drift risk)

- SRS kick tables triplicated: `src/core/srs.ts:8-130`, `rust/hoiko-deepseek/src/kick.rs:22-89`, `rust/hoiko-core/src/srs.rs:39-65` (values currently match).
- ~50 v2 score constants duplicated 1:1 (`src/ai/deepseek-v2.ts:58-118` vs `rust/hoiko-deepseek/src/v2.rs:24-83`), and duplicated again inside Rust in `scorer.rs:12-59`.
- Eval helpers duplicated: `src/ai/deepseek-score.ts` vs `rust/hoiko-deepseek/src/deepseek_score.rs`; `src/ai/deepseek-v2-score.ts:86-89` vs `v2_score.rs:81-84`.
- Attack/garbage tables duplicated with a semantic divergence (`garbage.ts:38-43` mini table vs `scorer.rs:77-99` no mini branch) — see F4.
- Piece/mino codes exist in 7 tables across two orderings (native `I0 J1 L2 O3 T4 S5 Z6` in `src/ai/mino-codes.ts`, `rust/hoiko-core/src/shapes.rs`, `tools/hoiko-oracle/diff/positions.ts`; SRS `I0 O1 T2 S3 Z4 J5 L6` in `src/ai/deepseek-rust-core.ts:32-40`, `rust/deepseek-wasm/src/abi.rs:44-53`, `rust/hoiko-deepseek/src/pieces.rs:48-58`, `rust/hoiko-core/src/srs.rs:30-36`). A silent order swap compiles and only surfaces as wrong moves.

## Security / hygiene (clean, informational)

- No committed secrets/tokens/keys found (`git grep` for `ghp_|gho_|sk-|AKIA|PRIVATE KEY|Bearer`, plus `git log --all -p`); no `.env`/`.pem`/`.key` tracked.
- No `eval` / `new Function`; no `innerHTML`/`document.write` in `src/` (the `innerHTML` hits are only in inert `freeze/v8/*.snap`).
- Committed generated/binary files: `src/ai/opening-book-data.ts` (147 103 B, 3 368 lines, auto-generated), the two `.wasm` (~205 KB); total tracked ~1.68 MB. Recommend Git LFS or CI rebuild-diff for the wasm (F5).

---

# Filed issues

(URLs recorded after creation; one well-scoped issue per root cause, highest severity first. Checked `gh issue list --state all` first; the only overlapping existing issue is #20 "Restore GitHub Actions", which covers billing restore, not the wasm-verification gap in F5.)

1. F1 — fairness: step-count asymmetry in the match harness (bug) — https://github.com/souta-lab/deepseek-tetris/issues/24
2. F2 — app vs gate garbage config mismatch (bug) — https://github.com/souta-lab/deepseek-tetris/issues/25
3. F3 — `bun test` red/flaky timeouts (bug) — https://github.com/souta-lab/deepseek-tetris/issues/26
4. F4 — T-spin/combo attack-table correctness (bug) — https://github.com/souta-lab/deepseek-tetris/issues/27
5. F5 — CI never verifies checked-in wasm (bug) — https://github.com/souta-lab/deepseek-tetris/issues/28
6. F6 — doc/reality drift and unsupported 80-0 claim (documentation) — https://github.com/souta-lab/deepseek-tetris/issues/29
7. F7 — tests/scripts/tools not typechecked (enhancement) — https://github.com/souta-lab/deepseek-tetris/issues/30
8. F8 — test suite is a mirror, not an oracle; coverage holes (enhancement) — https://github.com/souta-lab/deepseek-tetris/issues/31
9. F9/F10 + dead code + duplication — repo hygiene/portability cluster (enhancement) — https://github.com/souta-lab/deepseek-tetris/issues/32

---

# Verification notes

- No source files were modified: `git status` was clean before writing this report; only `evidence/scan/findings.md` is added.
- `bunx tsc --noEmit`, `bun run lint`, `bun run build`, and `cargo test` were re-run and pass. `bun test` was red before the scan and is unchanged (not caused by this work).
- The positive checks that passed: `freeze/v8` verifies (`bun scripts/freeze.ts verify v8` → `OK (28 files verified)`); `docs/BEAT_HOIKO.md` strength table matches `evidence/strength/sweep.jsonl`; `evidence/opening-book/findings.md` matches `gate.jsonl`; `src/ai/opening-book-data.ts` has 3360 keys (matches "3360/5040"); `MIGRATION_RUST.md`'s deleted-file list is accurate.
