# attax vs Hoiko — night of 2026-11-24 (lane attax-hoiko-night)

Protocol for every run: PC (OptiPlex, RX 6400), pfserve GPU engine via tbp/attax-tbp.ts,
guideline profile, G=96, referee = gauntlet rig intetrigence
`external-arena --rules guideline --no-swap --ms 100 --pps 5 --turns 1000`,
attax = player 0 fixed, Hoiko = adapter @3af221e, HOIKO_TBP_ADAPT=0, delivered
strongest config (we / beam 300 / depth 14 / viewNext 12 / PC stack OFF).
All runs: replay verify exit 0, sequence-match 30/30 (one run had a single
attax fallback: dev2-base-w4). Audit JSONLs: ../attax-vs-hoiko-night-*.jsonl.

Shipped tables (config O) sha256: 07b87df1819985e8c49ee09b826d7906b089711296722c3a6924578e0f95f5e9
Shipped SPV sha256: b24bfd3f7d252d42db992a00b54bf9d8b9126927d0910f69cc24e076e5d9b087

## Results (attax W-L, 30 games each)

| band | role | config | score | atk/line A vs H |
|---|---|---|---|---|
| 830001-30 | dev | shipped, ROWS=20 (baseline) | 11-19 | 0.935 / 1.307 |
| 830001-30 | dev | shipped, ROWS=40 | 15-15 | 0.916 / 1.277 |
| 830001-30 | dev | W1 = ROWS40 + tabf165 90->140 | 12-18 | 0.834 / 1.329 |
| 830001-30 | dev | W2 = ROWS40 + clear-spread | 15-15 | 1.004 / 1.303 |
| 830001-30 | dev | W3 = ROWS40 + tabf155 60->150 | 14-16 | 0.955 / 1.311 |
| 830001-30 | dev | W4 = W2 + W3 | 17-13 | 1.090 / 1.266* |
| 830001-30 | dev | W6 = W4 + B2B-state shader (tabf172=100) | 12-18 | — |
| 840001-30 | CONFIRM | W4 | 13-17 | 1.090 / 1.266 |
| 850001-30 | dev2 | W4 (baseline for cycle 2) | 17-13 | 1.081 / 1.282 |
| 850001-30 | dev2 | W7 = W4 + surface (150:-8->-14, 151:-3->-6, 152:-6->-10) | 23-7 | 1.078 / 1.262 |
| 860001-30 | CONFIRM2 | W7 | 15-15 | 1.074 / 1.269 |

*W4 dev atk/line from replay outcomes: 2977/2730=1.090; Hoiko 3157/2475=1.276 (table shows confirm values; see JSONLs).

ATTAX_GPU_G != 96 was smoke-tested (G=144): play collapses (state layout is
width-96 end-to-end) — not a usable lever in the TBP path.

## Kept changes (candidate configuration "W7", not landed in the repo)

1. ATTAX_TBP_ROWS=40 — the TBP adapter must show the engine the full 40-row
   board (default 20 hid everything above row 19: the engine played blind
   whenever its stack grew past 20 rows).
2. tables-w7.bin (sha256 783225aba27efffb524d812fedc79655a44353e91525981d07e9b24d69dcc39e),
   deltas vs config O (index: old -> new):
   150 bump -8->-14; 151 bumpSq -3->-6; 152 rowTransitions -6->-10;
   155 tslot 60->150; 156 single -60->-160; 157 double -40->-100;
   158 triple -30->-50; 159 tetris 60->120; 160 mini -20->-60;
   161 tspin1 40->80; 162 tspin2 120->200; 163 tspin3 160->260.
   (tabf165 attack weight unchanged at 90; tables-w4.bin = W7 minus the
   three surface weights.)

## Honest bottom line

Neither confirmation band was won (W4: 13-17; W7: 15-15). The shipped
config's unbiased record tonight: 9-21 (820 band) and 11-19 (830 band).
W7's unbiased estimate is its confirmation band: 15-15 — parity with the
strongest Hoiko, up from a clear losing record, but not a win.
