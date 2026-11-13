# Imported external measurements

These matches used external rigs, **not** this repository's benchmark harness. They
are retained under `bench-results/` so `bun run results` can produce every displayed
result from checked-in records. No engine, search, arena, audit or replay code changed.

## Origins and identities

- `intetrigence/final-5001-5050.jsonl.gz`: lossless gzip of
  `~/workspace/intetrigence-vs/runs/final-5001-5050.jsonl`; gunzip restores the original
  bytes. Full start/move/result records, including both seats. Imported
  `intetrigence/summary.json` is that rig's `runs/final-5001-5050.summary.json`, unchanged.
  `intetrigence/REPORT.md` is its original report. Host/referee intetrigence commit
  `e8169134ad7cc3681864a7a978e7e725ba6c7385`; Attax fighter commit `4b2c724`.
  **The replay's hard-coded `cold_clear_2` agent means the external Attax client**:
  start headers identify `./attax-tbp.sh`. The converter uses the header agent array
  to identify the seat, never progress-counter labels.
- `intetrigence/published-eval.json`: unchanged copy of
  `~/workspace/intetrigence-vs/intetrigence/results/comparisons/cold-clear2/external-retained-100ms-5pps-100.json`.
  This is the published official-opponent comparison cited by Block C, not a new
  Attax match. Its game count and score feed the prose.
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
rendered on this English page). `copy-template.json` transcribes Blocks B–E, replacing
all numerical claims with named bindings. It is editorial copy, **not a score source**.
The tagline and index meta description are generated directly from matchup rows.

Prose bindings come from:

- Hoiko seed bounds: existing benchmark JSONL; preset/beam/depth/preview and executable
  parity counts/seeds: existing `evidence/hoiko-fullgame/summary-verify2-seed1-cap500.jsonl`,
  `summary-chase-seed2-postfix.jsonl`, `summary-chase-seed7-postfix.jsonl`.
- intetrigence seed bounds/counts, nominal ms/PPS and opponent median think time:
  replay start/result/move records (`stats.elapsed_us`, rounded to whole milliseconds).
  Attax median and completed-search log count: imported `intetrigence/summary.json`
  (`attax_think_ms.median`, `attax_log_entries`). These log-only facts cannot be
  recovered from the replay alone, which is why the original summary is retained.
- clys seed bounds/counts, seat wins and both line totals: per-seed result records;
  ms/PPS: the shard's settings fields.
- `conditions.json`: a report-derived condition summary, not a new measurement.
  Hoiko pace is extracted from `hoiko-conditions-excerpt.md` (from
  `~/workspace/tetris-speed/REPORT.md`); clys width/depth/branch/thread count,
  previews, board views and turn cap are transcribed from the retained
  `clys/conditions-excerpt.md`. Named bindings keep these settings out of UI code.

Generate with `bun run results`, then `bun run build`. The imported records remain
outside the deployable bundle; the page ships only the generated aggregate and prose.
