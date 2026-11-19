# Bench results — posted by the orchestrator

## R1: field40-speculate (ATTAX_SPECULATE=1) vs frozen control — DONE 2026-11-14 ~01:05

Run on the user's PC (OptiPlex, gauntlet rig built on PC; opponent chouhy CC2 @ b20a92b,
identical binary lineage to the VM control batch). Seeds 2401–2410, both seats, 20 games,
all replay-verified (replay_tally.py over the run dir).

| arm | W-L-D | APP attax | APP cc2 |
|---|---|---|---|
| speculate (SPECULATE=1) | 16-4-0 | 0.9010 (3842/4264) | 0.7921 (3368/4252) |
| control (frozen, existing batch) | 17-1-2 | 0.879 | 0.761 |

Paired primary (wins, draws non-wins): speculate 16 vs control 17 → behind by 1 win.
Per the pre-registered rule, behind-by-1 does NOT rule speculation out → R2 proceeds.
Notes: zero draws under speculation (control had 2) but losses rose 1 → 4; both sides'
APP rose (games were sharper). Raw evidence: PC ~/attax-tbp-pack/tools/cc2-rematch/runs/field40-speculate/
(summaries to be committed; raw replays stay on the PC disk).

## R2: field40-control-2601 / field40-speculate-2601 — DONE 2026-11-14 (finished 15:04, tallied 17:36)

Seeds 2601–2620, both seats, 40 games per arm, PC, 4 lanes, all replay-verified
(replay_tally.py over both run dirs).

| arm | W-L-D | APP attax | APP cc2 |
|---|---|---|---|
| control (frozen, SPECULATE=0) | 19-21-0 | 0.8883 (10540/11866) | 0.8091 (9602/11868) |
| speculate (SPECULATE=1) | 26-13-1 | 0.9124 (11198/12273) | 0.8219 (10076/12260) |

Pooled adoption test (R1 20 games/arm + R2 40 games/arm = 60/arm), per the pre-registered rule:
- Pooled wins: speculate 42 vs control 36 → **+6** (needed ≥ +3) ✓
- Pooled losses: speculate 17 vs control 22 → **−5** (needed ≤ control+1) ✓
- Pooled APP (attax): speculate 0.9086 vs control 0.8852 → margin better, not worse ✓

**VERDICT: SPECULATE ADOPTED.** All three criteria pass. The new competition profile is
field40 + `ATTAX_SPECULATE=1` (ROWS=40 GUIDELINE=1 WIDTH=96 DIVERSE=0 EXPOSURE=0 SPECULATE=1).
Note the R1 texture reversed in R2: the losses that rose in R1 fell below control in R2
(13 vs 21), and control itself went 19-21 on these seeds — single-batch variance is real,
which is why the pooled rule existed. Raw evidence: PC
~/attax-tbp-pack/tools/cc2-rematch/runs/field40-{control,speculate}-2601/.

## Timing split: per-decision search cost on recorded boards — 2026-11-14 ~17:50

Harness: tools/cc2-rematch/timing-split.ts (check-recorded.ts reconstruction),
final-gate replays 12001–12010, both games, every 7th turn, n=1626 decisions,
in-process `search()` timing (no adapter/IPC), first 20 calls discarded as warmup.

| bucket | n | control med | control p90 | speculate med | speculate p90 |
|---|---|---|---|---|---|
| ALL | 1626 | 64.2 ms | 98.7 | 135.8 ms | 211.9 |
| turns 1–60 | 146 | 63.5 | 97.1 | 134.4 | 199.1 |
| turns 61–150 | 211 | 65.0 | 98.1 | 136.2 | 217.0 |
| turns 151–300 | 314 | 64.9 | 102.4 | 138.3 | 217.6 |
| turns 301+ | 955 | 63.9 | 98.4 | 135.3 | 210.1 |
| stack height ≤6 | 708 | 63.8 | 98.5 | 134.4 | 217.0 |
| height 7–12 | 814 | 64.5 | 98.9 | 136.7 | 210.2 |
| height 13–18 | 104 | 64.9 | 95.2 | 136.8 | 210.9 |

Findings:
- Width-96 search cost is **flat** (~64 ms median) across game phase and stack height.
  The "heavy late-game boards blow up the search" hypothesis is NOT supported; the
  ~245 ms/move wall-clock seen in gauntlet matches is therefore mostly **pipeline
  overhead outside search()** (adapter/IPC/referee accounting), not node cost.
- SPECULATE costs ≈2.1× the base search (median 135.8 ms) — the chance ply is the
  single largest in-search cost. Any Rust port aimed at the 100 ms budget must treat
  the speculate ply and the adapter pipeline as first-class targets, not just movegen.

## Caution recorded for all future PC runs

The PC's pre-existing intetrigence build was the UNMODIFIED upstream referee: without the
gauntlet ATTAX_EXTERNAL support it silently falls back to its internal bot when the env var
is absent (agents ["intetrigence","cold_clear_2"], 6-piece games). The first PC attempt at
R1 was invalid for this reason and was discarded. Always check the replay's agents field
equals ["attax","cold_clear_2"] before trusting a batch. PC rig is now the gauntlet build
(~/attax-gauntlet-rig, source: private repo souta-lab/attax-gauntlet-rig).

## Official CC2 (upstream MinusKelvin ed8b193) — 100 games, 2026-11-14
- Profile: field40 + SPECULATE (ATTAX_ROWS=40 GUIDELINE=1 WIDTH=96 DIVERSE=0 EXPOSURE=0 SPECULATE=1), seeds 13001–13050 both seats, PC rig `official-spec-13001`, replay tally.
- **Result: attax 79W–21L–0D.** APP attax 0.8951 (8112/9063) vs cc2 0.9279 (8367/9017) — attax wins the match decisively despite lower attack-per-piece.
- Replay agents field verified: ["attax","cold_clear_2"] (official upstream binary, not the fork).
