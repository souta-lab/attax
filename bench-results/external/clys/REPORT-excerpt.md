# clys evidence excerpt


**88 W – 12 L – 0 D** over 100 games; Attax win rate **88.0%**, Wilson 95% CI **80.2%–93.0%**.

| Side | Raw attack | Locked pieces | Attack/piece | Lines |
|---|---:|---:|---:|---:|
| Attax | 7039 | 9582 | 0.7346 | 7948 |
| clys | 7406 | 9506 | 0.7791 | 6267 |

Attack/piece is pooled raw generated attack divided by successful locks, before cancellation, matching the previous report.

| Timing (ms/move) | N | Mean | Median | p95 | Max |
|---|---:|---:|---:|---:|---:|
| Attax search only | 9970 | 83.98 | 86.39 | 169.26 | 565.93 |
| Attax client exchange | 9594 | 98.25 | 92.51 | 185.63 | 601.12 |
| Opponent window + exchange | 9594 | 153.24 | 144.40 | 211.97 | 615.56 |

Attax search depths: `{6: 9415, 5: 167, 0: 388}`. Decisions with occupied cells above row 20: **107**. Turn-cap games: **0**. Attax wins from seat 0/1: **46/42**.

Opponent reported nodes per nonempty suggestion: `{'n': 9506, 'mean': 175151.256154008, 'median': 145689.5, 'p95': 219153, 'max': 1202530}`; reported depth: `{6: 3445, 8: 305, 7: 5231, 32: 403, 9: 3, 5: 119}`. These are bot-specific counters, not comparable work units.

Per-seed artefacts: `runs/clys-7001.*` through `runs/clys-7050.*`; complete summary `runs/clys-summary.json`.

Protocol audit: `{'games': 100, 'attack_and_pieces': {'attax': [7039, 9582], 'cold_clear_2': [7406, 9506]}, 'holds': {'attax': 3990, 'cold_clear_2': 2209}, 'spin_translation': {'none->none': 9765, 'full->none': 8156, 'full->full': 937, 'mini->mini': 230}, 'accepted_indices': {'0': 18260, '1': 828, 'None': 476}, 'nonempty_rejections': 0}`. Indices above zero select another supplied spin/orientation/placement candidate; these are not invented referee moves.
