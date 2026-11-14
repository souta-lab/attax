# Imported external measurements

These matches used external rigs, **not** this repository's benchmark harness. They
are retained under `bench-results/` so `bun run results` can produce every displayed
result from checked-in records. No engine, search, arena, audit or replay code changed.

## Origins and identities

- `clys/clys-7001.json` through `clys/clys-7050.json`: unchanged per-seed result
  records from `~/workspace/attax-gauntlet/runs/`, each containing both seat games.
  `clys/summary.json` is unchanged `runs/clys-summary.json` from that rig.
  `clys/REPORT-excerpt.md` retains only the clys results section of its report;
  `clys/conditions-excerpt.md` retains the shared conditions and Attax/clys settings.
  Referee: the rig's patched copy of intetrigence commit
  `e8169134ad7cc3681864a7a978e7e725ba6c7385` (external Attax backend).
  clys: `ccae45fc3e30c3d3432af2b06d5b4f7f2e8dfbcc`. Attax checkout `c4c2435`,
  with relevant AI/core source identical to `4b2c724`. Unswapped Attax is seat zero;
  swapped Attax is seat one. Discarded runs are not imported.
- `cc2/cc2-13001.json` through `cc2/cc2-13050.json`: per-seed arena records from the
  `official-spec-13001` run of the `tools/cc2-rematch` rig, each containing both seat
  games; only seeds whose replay read "verified 2 complete matches" were imported
  (all 50). `cc2/summary.json` was generated from the imported records, and the
  generator asserts it against them. Opponent: the official upstream Cold Clear 2
  (MinusKelvin) at `ed8b19327b6bd1410ddd873d8611485bd45d8fae`. Attax played its
  field-40 profile with exact bag speculation (SPECULATE), over TBP under guideline
  rules, 100 ms window, 5 PPS paired turns. Unswapped Attax is seat zero; swapped
  Attax is seat one.
- `cc2-fork/cc2fork-2701.json` through `cc2-fork/cc2fork-2720.json`: the same rig's
  `field40-spec-2701` run against chouhy's Cold Clear 2 fork (built from the same
  upstream base), imported the same way (all 20 seeds replay-verified).
  `cc2-fork/summary.json` likewise generated and asserted.

## Conversion and numerical provenance

`scripts/external-results.ts` converts per-game `attack`, `lines`, `pieces`, winner
and seat into the same `Oriented` shape consumed by `summarize` in
`scripts/build-results.ts`. These external matches keep **both** games per seed.
Games, wins, losses, draws, Wilson intervals, APP, line totals and seat wins are
computed from the records. Summary assertions catch mismatched imports. External APP
is pooled **generated attack before cancellation** divided by locked pieces; Hoiko
APP remains garbage **sent after cancellation** per piece. The table labels this in
its row details. The game-level Wilson intervals for external matches are descriptive;
seed pairs, not individual games, are the independent units.

The original approved English Blocks A–E are archived in `page-copy.md`, copied from
`~/workspace/attax-promo/attax-page-copy.md` (the optional Japanese appendix is not
rendered on this English page). The intetrigence matchup was later withdrawn: the owner
judged intetrigence not a valid benchmark opponent (defective guideline-profile behaviour),
so its records were removed from this directory and its copy from `page-copy.md` and
`copy-template.json` (Block D, which was intetrigence-only, is gone entirely). The TBP
interop write-up stays in `tbp/intetrigence-match.md`. `copy-template.json` transcribes
Blocks B–E, replacing all numerical claims with named bindings. It is editorial copy, **not a score source**.
The tagline and index meta description are generated directly from matchup rows.

Prose bindings come from:

- Hoiko seed bounds: existing benchmark JSONL; preset/beam/depth/preview and executable
  parity counts/seeds: existing `evidence/hoiko-fullgame/summary-verify2-seed1-cap500.jsonl`,
  `summary-chase-seed2-postfix.jsonl`, `summary-chase-seed7-postfix.jsonl`.
- clys seed bounds/counts, seat wins and both line totals: per-seed result records;
  ms/PPS: the shard's settings fields.
- Cold Clear 2 seed bounds, seat wins, line totals, APP values and win-rate interval:
  per-seed arena records; ms/PPS and the upstream commit: each run's `summary.json`
  settings, transcribed from the rig's per-seed records.
- `conditions.json`: a report-derived condition summary, not a new measurement.
  Hoiko pace is extracted from `hoiko-conditions-excerpt.md` (from
  `~/workspace/tetris-speed/REPORT.md`); clys width/depth/branch/thread count,
  previews, board views and turn cap are transcribed from the retained
  `clys/conditions-excerpt.md`. Named bindings keep these settings out of UI code.

Generate with `bun run results`, then `bun run build`. The imported records remain
outside the deployable bundle; the page ships only the generated aggregate and prose.
