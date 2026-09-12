# App ↔ CLI/gate parity evidence

Date: 2026-09-12 · HEAD: `fb9ea08` (verification-only working-tree changes, uncommitted)
Method: no browser, no Playwright. Browser loaders are covered by source/AST-level
resolution against the same wasm file; behavior is compared headlessly through the
CLI loaders, which call the same `makeRustHoiko`/`makeRustDeepSeekV2` cores.

## Verdict

| Question | Result |
|---|---|
| Do the app and gate instantiate the same Hoiko engine bytes? | **Yes** — both loader sources resolve to `src/ai/wasm/hoiko_core.wasm`; sha256 `f0a59598…ed5d0`; the built asset is byte-identical (`build-check.txt`) |
| Do per-snapshot engine decisions match on identical snapshots? | **Yes** — `0 / 1256` tuple and `0 / 1256` full-output mismatches with the deterministic (fixed-beam) config across 11 seeds |
| Do the app and gate run the same opponent configuration? | **Yes** — default `createRustHoiko()` ≡ `resolveFaithfulHoikoOptions({})` (adapt, depth 14, viewNext 2, beam 50/cap 150, `we`); Rust DeepSeek defaults ≡ gate `readV2Options()` defaults |
| Does the left/right swap change match flow? | **No observable difference** — `11/11` seeds same winner, ticks, pieces, lines and sent, both with faithful adaptation and with adaptation off |
| Real differences found | Only the documented wall-clock `SetNextOption` beam adaptation: `29 / 1256` internal beam-state divergences, `1 / 1256` decision flip (seed 17). No match outcome changed. Details below. |

## Constructions compared

| | Fighter left | Fighter right | Options | Versus config |
|---|---|---|---|---|
| App (`src/main.ts` boot) | Hoiko (`createRustHoiko()`) | Rust DeepSeek (`createRustDeepSeekV2()`) | `speedOptions(1)` | `resolveVersusConfig()` |
| Gate (`scripts/gate-v2.ts`) | DeepSeek (`makeOurFighter(readV2Options())`, `DSV2_RUST=1`) | Hoiko (`createRustHoiko(resolveFaithfulHoikoOptions(process.env, preset))`) | `VERSUS_DEFAULTS` | `resolveVersusConfig()` |

`speedOptions(1)` deep-equals `VERSUS_DEFAULTS` (asserted in the test), so the only
structural difference is which side each fighter occupies.

## 1. Automated test — `tests/app-cli-parity.test.ts` (6 tests, all pass)

- `browser and CLI Hoiko loaders resolve to the same wasm bytes`: parses the browser
  `?url` specifier (`./wasm/hoiko_core.wasm?url`) and the CLI `new URL(...)` path,
  asserts both realpath to `src/ai/wasm/hoiko_core.wasm`, validates the module, checks
  the `h_*` ABI exports, and asserts a direct instantiation of those bytes and the CLI
  loader produce identical `RustOut`.
- `default app Hoiko config equals the gate resolver output`: effective engine fields
  (`adapt`, `depthLimit`, `viewNext`, `isEvenBoard`, `framesPerThink`, `offsetEnabled`,
  `searchState`) are deep-equal, and equal the faithful constant
  (`50 / 150 / 1000`, depth 14, viewNext 2, adapt on).
- `engine decisions match on identical snapshots (deterministic beam)`: 20 controller-built
  decision snapshots; `(x, firstRRaw, firstM, garbageWait)`, the full `RustOut` and the
  `AiMove` are deep-equal per snapshot.
- `app Rust DeepSeek path equals the gate's DSV2_RUST=1 option set`: engine options and
  full decisions on the same 20 snapshots are deep-equal (gate defaults read through the
  gate's own resolver with `DSV2_*` cleared).
- `app 1x speed options equal the gate/controller defaults`: `speedOptions(1)` ≡
  `VERSUS_DEFAULTS`; `speedOptions(2)` halves both intervals; `isSpeed` guards the set.
- `app and gate call sites construct the same fighters, config and speed`: source locks
  the wiring (app `createRustHoiko()` + `speedOptions` + `resolveVersusConfig()`; gate
  `resolveFaithfulHoikoOptions(process.env, preset)` + Hoiko right + same config).

Helpers live in `tests/support/app-cli-parity-fixtures.ts`.

## 2. Headless behavioral comparison — `tools/hoiko-oracle/diff/app-vs-cli.ts`

Run: `DSV2_RUST=1 bun tools/hoiko-oracle/diff/app-vs-cli.ts --seeds=1,5555,13,37,61,89,7,9001,17,41,42`
(11 seeds; `MAX_REPLAY_SNAPSHOTS = 120` per seed; raw JSONL in
`app-vs-cli-adapt-on.jsonl`).

### Match flow (faithful adaptation)

| seed | app winner | gate winner | same | app ticks/pieces | gate ticks/pieces |
|---|---|---|---|---|---|
| 1 | HOIKO | HOIKO | yes | 443/88 | 443/88 |
| 5555 | HOIKO | HOIKO | yes | 915/185 | 915/185 |
| 13 | DEEPSEEK | DEEPSEEK | yes | 668/135 | 668/135 |
| 37 | HOIKO | HOIKO | yes | 908/187 | 908/187 |
| 61 | DEEPSEEK | DEEPSEEK | yes | 810/167 | 810/167 |
| 89 | DEEPSEEK | DEEPSEEK | yes | 803/169 | 803/169 |
| 7 | DEEPSEEK | DEEPSEEK | yes | 968/201 | 968/201 |
| 9001 | DEEPSEEK | DEEPSEEK | yes | 338/64 | 338/64 |
| 17 | DEEPSEEK | DEEPSEEK | yes | 998/204 | 998/204 |
| 41 | DEEPSEEK | DEEPSEEK | yes | 330/72 | 330/72 |
| 42 | DEEPSEEK | DEEPSEEK | yes | 585/125 | 585/125 |

`11/11` also identical on ticks, pieces, per-fighter lines and per-fighter sent
(deltas all 0). The same is true for the deterministic (adapt off) construction
(`app-cli-deterministic` records). The independent gate smoke run
(`gate-smoke.jsonl`, DeepSeek left) reproduces the same winners/ticks/pieces for
seeds 1/7/42, confirming the identity is not an artifact of the comparison script.

### Engine decision parity on identical snapshots

Snapshots are the exact controller decision snapshots captured from both matches and
replayed through **fresh** fighters built from the app path and the gate path.

| Config | Replayed decisions | Tuple mismatches `(x, rot, m, garbageWait)` | Full `RustOut` mismatches | State mismatches |
|---|---|---|---|---|
| Fixed beam (`adapt:false`) | 1256 | **0** | **0** | 0 |
| Faithful (`adapt` on, app default) | 1256 | 1 | 29 | 29 |
| Fresh faithful replay vs in-match app decisions | 1256 | 1 | — | — |

The only mismatching fields in the faithful pair are `beamSizeLimit`, `maxBeamSize` and
`node` — i.e., the two fresh engines took different `SetNextOption` beam trajectories
because that adaptation is driven by **real elapsed search time**, not by the snapshot.
At seed 17, index 7 one trajectory crossed a beam threshold and flipped the chosen move
(`x`, `score`, `planActs`, `moveDelay`, `timerLimitMs` also differ there); the fixed-beam
replay at the same index is identical. This is a property of the shared engine (also
documented in `docs/BEAT_HOIKO.md`), present identically in the app and the gate — not a
configuration or adapter difference. Effect on match outcomes in this corpus: none.

## 3. Build-artifact check

`bun run build` emits `dist/assets/hoiko_core-VAND_EWZ.wasm` and
`dist/assets/deepseek_v2-CYKTukME.wasm`. `sha256sum` and `cmp` show both are
**byte-identical** to `src/ai/wasm/*.wasm` (see `build-check.txt`). The JS bundle
embeds the same engine code path (`bundle-check.txt`): the main chunk references
`hoiko_core-VAND_EWZ.wasm` and contains `h_search`, `h_alloc`, `h_search_input_size`,
`input layout`, `h_search failed`; the lazy `deepseek-rust-VCI4TDI6.js` chunk references
`deepseek_v2-CYKTukME.wasm` and contains `ds_best_move`/`ds_alloc`.

## 4. Gates

`gates.txt`: `bunx tsc --noEmit` OK · `bun test` **119 pass / 0 fail** (113 prior + 6
new; `+ fixtures`) · `bun run lint` clean · `cargo test --manifest-path rust/Cargo.toml`
all pass · `bun run build` OK.

## Interpretation

- **Engine-decision parity is exact** whenever the beam configuration is the same
  (fixed-beam pair: 0 mismatches in 1256 decisions). The app side and the gate side run
  the same wasm bytes, the same adapter, and the same faithful options.
- **The left/right swap is not a fidelity problem.** `tickVersus` steps left before
  right, but both sides are seeded identically and the swap changed nothing observable on
  11 seeds (winner, ticks, pieces, lines, sent — all identical), in both the faithful and
  the deterministic ablation. The app's Hoiko-on-the-left ordering is behaviorally
  indistinguishable from the gate's DeepSeek-on-the-left ordering.
- **The only real difference is wall-clock beam adaptation**, an inherent property of
  the faithful `SetNextOption` model that affects both sides equally; it produced one
  decision flip in 1256 replays and zero outcome changes. This matches the caveat already
  recorded in `docs/BEAT_HOIKO.md`.
- Conclusion: the browser app runs the same verified Hoiko opponent as
  `scripts/gate-v2.ts`, so the 24-8 scoreboard transfers to the app's construction.

## Changes made (verification only, uncommitted)

| File | Change |
|---|---|
| `tests/app-cli-parity.test.ts` (new) | 6 parity assertions (wasm identity, Hoiko/DeepSeek config + decisions, speedOptions(1), call sites) |
| `tests/support/app-cli-parity-fixtures.ts` (new) | shared snapshot/config helpers for the test |
| `tools/hoiko-oracle/diff/app-vs-cli.ts` (new) | headless app-vs-gate match + engine replay comparison |
| `src/versus/speed.ts` (new) | `SPEEDS`/`isSpeed`/`speedOptions` extracted verbatim from `src/main.ts` so the app's 1x options can be asserted without booting the DOM; `src/main.ts` imports it (no behavior change) |
| `scripts/gate-v2.ts` | `if (import.meta.main) main()` + exports (`FIXED_SEEDS`, `makeOurFighter`, `readPreset`, `readV2Options`) so tests/tools use the gate's real option resolver instead of a copy; CLI behavior unchanged (entrypoint verified via `gate-smoke.jsonl`) |

No engine code changed; nothing committed or pushed.

## Raw artifacts

- `app-vs-cli-adapt-on.jsonl` — 35 JSONL records (config, 11 × match/engine/deterministic, summary)
- `app-vs-cli-adapt-on.stderr.log` — empty (clean run)
- `gate-smoke.jsonl` — gate entrypoint smoke run, seeds 1/7/42
- `build-check.txt` — src vs dist wasm sha256 + `cmp`
- `bundle-check.txt` — engine markers and asset references in the dist bundles
- `gates.txt` — tsc / bun test / lint / cargo / build output
