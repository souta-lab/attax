# Divergence characterization (multiple seeds)

The exe-driven full-game differential (`tools/hoiko-oracle/diff/fullgame.ts`) diverges on
every seed tried, at different moves, always as a **move-selection** difference (child
generation is identical — see `expand-turn183/REPORT.md`).

| Seed | First divergence | exe | replica |
|---|---|---|---|
| 1 | turn 183 (cap 200) | x=7 rot=2 m=2 (L) | x=7 rot=0 m=2 |
| 2 | turn 132 (cap 250) | x=0 rot=3 m=4 (T, hold used) | x=5 rot=1 m=5 (S) |
| 7 | turn 135 (cap 250) | x=7 rot=1 m=0 (I) | x=3 rot=1 m=0 |

Raw records: `seed1-cap200.jsonl`, `summary-seed1-cap200.jsonl`, `char-seed2.jsonl`,
`summary-char-seed2.jsonl`, `char-seed7.jsonl`, `summary-char-seed7.jsonl`.

E3 (`diff/expand.ts`) proved the exe and replica produce identical child sets at every
generation along the exe's chosen path and across 48 synthetic states, so the divergence is
in beam scoring/selection, not child generation.
