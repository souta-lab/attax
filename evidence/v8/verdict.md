# V8 Verdict — sealed 2026-09-10

## Seal
- `freeze/v8`: 28 files snapshotted from `src/`; manifest at `freeze/v8/manifest.json`.
- snapshotSha256: `b1134c6b195f54f452f5a3bffb3f5a9a7d1cc75b996491f23059ecd21f45dd17`.
- `bun scripts/freeze.ts verify v8` => OK (28 files; per-file + aggregate hash checked).
- Tooling: `scripts/freeze.ts` create/verify/materialize; materialize now verifies hashes and refuses on mismatch.
- Production configs: BLUE = `createFighterA({useKick:false})`, RED = `createFighterB()`.
- Shadow-only, NOT enabled: `createFighterA({placementGenerator: explicitKickGenerator})`.

## Gates
- S3 fixed corpus: 32 seeds, 6 shards, maxTicks=12000, live BLUE(left) vs live RED(right).
  - control: 8 left wins / 19 right wins / 5 caps.
  - candidate (explicit kick generator): 6 / 21 / 5 — worse, remains shadow-only.
  - executionSourceMismatches = 0; executionExpectedBoardFailures = 0 (both configs).
  - control fingerprints: a3ff3e62, 0b1f489d, 7a1c44b1, 7356b7fb, 25a63b43, f1eade3d.
- Tests: 53 pass; tsc/build green at seal time (attested in evidence).
- S1/S2: BLOCKED. `/tmp/redv7-fixed.ts` / `/tmp/bluev7-fixed.ts` were lost in a tmp wipe; local recovery exhausted (filesystem search, opencode tool-output, session diff). The current harness has no S1/S2 execution path at all (it only guards the missing v7 file). Future gates must be built from freeze seals instead.

## Oracle audit (V8)
- Seal mechanism sound; key caveat: after any src edit, `createFighterA` is no longer V8 — later gates must use the materialized frozen v8 as control.
- Loss drivers (corpus): BLUE tetris=1 vs RED=12; sent 237 vs 277; holes 92 vs 68; maxHeight sum 111 vs 87.
- Mechanism: singles send 0 attack (`garbage.ts` LINE_BASE) — BLUE's single-heavy clearing generates no pressure and cannot cancel pending.
- Asymmetries found: BLUE beam width/topK 24/16 vs RED 32/20; BLUE vetoes non-clearing placements while pending (RED never does); BLUE emergency pending>=5 vs RED >=4; BLUE opening bypass uses generic eval; BLUE FILL_PEN discourages executing a ready well while RED rewards filling it.

## Brain render (frozen v8, seeds 1 and 7, both KO losses; `evidence/v8/render-seed1-7.log`)
- Tetrises: BLUE 0 / 1; RED 2 / 4.
- T-spin singles: BLUE 13 / 18; RED 14 / 17. T-spin DOUBLES: 0 for both — the TSD machinery never converts.
- BLUE holes stay 3–9 (peak 9) and maxHeight hits 20 repeatedly; RED holds holes 0–4 and maxHeight 14–16.
- BLUE's well column is unstable (0/1/8/9 flip) — it优先s singles over Tetris-well execution.
- Death mode: top-out at H=20 with open holes; RED wins by KO.
- No Tetris-rule violations seen in renders (gravity, locks, clears, garbage exchange, T-spin detection all sane).

## V9 direction (audit + render)
1. BLUE must EXECUTE Tetrises (commit to an edge well, convert I into 4-line clears) and cut hole growth; de-prioritize non-attacking singles.
2. Align BLUE veto/emergency with RED (never veto while pending; emergency at pending>=4).
3. BLUE beam parity first (width 24->32, topK 16->20) as low-risk step.
4. Gate protocol: control = materialized frozen v8 (S2 sanity must reproduce 8/19/5 + fingerprints); S1 = candidate BLUE vs frozen v8 RED; S3 = candidate vs live RED. Pre-register acceptance: +2 wins minimum, no cap increase, zero execution failures.
5. Evidence must be sealed into `evidence/<version>/` (tmp wipes destroy everything).

## Reproduction
- Render: `bun scripts/freeze.ts materialize v8 /tmp/render-src-v8 && RENDER_BASE=/tmp/render-src-v8/src bun scripts/render.ts 1 7`
- Gates: `GATE_FREEZE=v8 bun scripts/gate.ts` (6-shard with GATE_SHARD_INDEX / GATE_SHARD_COUNT).

## Evidence files
- `evidence/v8/s3-{0..5}.log` — raw shard JSONL logs.
- `evidence/v8/s3-summary-{0..5}.md` — per-shard summaries.
- `evidence/v8/s3-aggregate.json` — aggregated totals + fingerprints.
- `evidence/v8/render-seed1-7.log` — ASCII brain render (seeds 1, 7).
- `freeze/v8/manifest.json` + `freeze/v8/src/**` — the seal itself.
