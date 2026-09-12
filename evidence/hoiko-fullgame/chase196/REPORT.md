# Second replica-vs-exe divergence — turn 196 (seed 1), root cause and fix

**Result:** the remaining divergence was **not** beam selection. It was a bug in
`Board::is_tspin` (`rust/hoiko-core/src/board.rs`): the mino's own board row `l0` was
gated on `y - 2 >= 0`, so every T-spin evaluation with a locked T at `y < 2` mis-read
its front corners. Fixed, the replica's search at turn 196 is **byte-identical to the
shipping binary's search arena at every generation** (move, score, node count, beam
membership/order, board/combo/btb/hold/iterator state), and the full-game
differential on the three previously divergent seeds now reaches its cap with
**zero move mismatches** (seed 1: 500/500, seeds 2 and 7: 200/200).

## 1. Discrimination — is the partial_sort port wrong?

With the `std_partial_sort` fix in place, turn 196 (seed 1, cap 500) diverged:

```
exe      : x=7 rot=2 m=1   nodeCount=62409
replica  : x=2 rot=0 m=1   nodeCount=62446
```

`eval_dump trace_std` on the replay-reconstructed snapshot
(`snapshot-turn196.json`) shows the reference trace (`probe_trace.rs`
`select_mode=1`, the IL-transcribed `std::partial_sort`) and `search.rs` are
**identical** — but both differ from the exe:

```
CANON x=2 r=0 m=1 hold=0 score=2451 depth=14 nodes=62446
TRACE x=2 r=0 m=1 hold=0 score=2451 depth=14 nodes=62446
TRACE_MATCH 1
TERM idx=0  score=2451 max=1 x=2 r=0 m=1 act=0 hold=0
TERM idx=26 score=2451 max=1 x=7 r=2 m=1 act=0 hold=0
```

So the port matches the reference; the reference fails to reproduce the exe at
196. The divergence is **not** the cut-off algorithm.

## 2. E3/E4 at turn 196 — generation and evaluation are identical

- `expand.ts --snapshot=snapshot-turn196.json`: gens 0..14 along the exe's chosen
  line and all 34 depth-1 states (depth-2 breadth) match count/set/order.
- `eval.ts --snapshot=snapshot-turn196.json`: **zero eval mismatch containers**
  along the exe path (`exe nodes=594 replica nodes=594`), the replica path
  (`595/595`) and the depth-2 breadth (`1819/1819`).

Ruled out: partial_sort cut-off, and everything on E3's placement key
(`x,rot,m,rows`) and E4's sampled lines/BFS. The divergence therefore had to be an
off-line property at depth ≥ 3; the arena diff in §3 identifies it as `act`/`btb`
from the T-spin classification (which E3's key does not include and E4's depth-2
breadth cannot reach).

## 3. Instrumenting the exe's beam (`tree_dump`)

The stub got a native-arena dump (`ScpDriverStub.cs`, `tree_dump=1`): it reads the
`?tree@SearchAI@@0PEAVTree@1@EA` static (RVA `0x663D8`) and writes the 56,580,000-byte
arena to `oracle_tree.bin`. Generation `d`'s child array starts at node index
`(d-1)*1500` (stride 328); the first `keep` nodes are the post-`partial_sort` beam,
gen 14 is the `MaxElement` input list. `rust/hoiko-core` got a matching `beams` dump
(`eval_dump beams`, arena in `probe_trace.rs`), and `tree_diff.py` compares them on
`(score, first move, own placement, act, combo, btb, hold, next-base, board rows)`.

Before the fix, the first divergence is at **generation 5** (gens 2-4 match all 150
nodes exactly):

```
gen  2: MATCH (150)
gen  3: MATCH (150)
gen  4: MATCH (150)
gen  5: DIFF idx=58 multiset=4    <- first divergence
...
VERDICT: FAIL
```

The gen-5 multiset difference is exactly two node pairs. All four nodes share
`own=(5,1,r0,m4)`, board `[1007,391,0,...]`, `hold=5`, `base=4`, `last_srs=3` and
the A/B first-move ancestors — the only difference is the clear classification:

```
EXE-ONLY  score=215 first=(7,2,1)/(2,0,1) own=(5,1,r0,m4) act=8 (TSM)  combo=2 btb=27
REP-ONLY  score=125 first=(7,2,1)/(2,0,1) own=(5,1,r0,m4) act=1 (Single) combo=2 btb=0
```

The exe's arena nodes are children of gen-4 beam parents 0 and 1; the replica's
pre-sort dump (`P` lines) shows that for those same parents it generates the same
placement as a plain Single:

```
P 6 1 125 5 1 0 4 1 3 1007,391,0,...     (replica child, parent slot 1)
P 7 0 125 5 1 0 4 1 3 1007,391,0,...     (replica child, parent slot 0)
exe gen5[4] act=8 last_srs=3  score=215   (parent slot 1)
exe gen5[5] act=8 last_srs=3  score=215   (parent slot 0)
```

Same board, same locked placement, same piece, same `last_srs` → the T-spin
classification itself differs.

## 4. Cause: `is_tspin` read the wrong row when `y < 2`

`rust/hoiko-core/src/board.rs:392` (pre-fix):

```rust
let l0 = if y - 2 >= 0 { self.row_at(y) } else { 0 };
```

Corner 0 and corner 1 of the native rule read `bd.line[y]` (the mino's own row), which
is independent of `y - 2`. The `y - 2 >= 0` gate is bogus; with `y = 1` it zeroed `l0`,
so only two corners counted (`fill = 2 < 3`) and the lock was scored as a non-spin.
The spec (`tools/hoiko-oracle/SPEC_CalcAtk_IsTspin.md` §2) and the exe arena both
require `line[y]`: corners 0/1 at `(x, y)`, `(x+2, y)`; corners 2/3 at
`(x+2, y-2)`, `(x, y-2)`.

Witness arithmetic: board rows `line[1]=391`, `line[0]=1007`, T at `x=5 y=1 r=0
lastSrs=3` → corner0 `(5,1)`: empty; corner1 `(7,1)`: 391&4≠0 filled; corners 2/3
below the floor → occupied. `fill=3`, `corners[0]=0 != corners[1]=1`,
`lastSrs != 5` → **mini** (2) → `act=8` (TSM), `btb+=1`. The pre-fix port read
`l0=0` → `fill=2` → 0 → `act=1` (Single), `btb=0`.

## 5. Fix and verification

```
rust/hoiko-core/src/board.rs
-        let l0 = if y - 2 >= 0 { self.row_at(y) } else { 0 };
+        let l0 = self.row_at(y);
```

Regression test `board::tests::is_tspin_reads_mino_row_when_lower_corners_pass_the_floor`
locks the witness (`is_tspin(...) == 2`; red before the fix: 0).

Post-fix, on the same exe arena dump:

```
tree-diff-postfix.txt
gen 2..14: MATCH                    (all generations, all fields)
VERDICT: all generations match
```

Replica search at turn 196 after the fix:

```
CANON x=7 r=2 m=1 hold=0 score=2451 depth=14 nodes=62409
exe   x=7 rot=2 m=1              nodeCount=62409
```

## 6. Golden tests — exe-confirmed

Both `search::tests` goldens were updated only after direct exe verification:

- `search_golden_empty_d14_with_hold`: exe run on the same empty position
  (`empty-d14/exe-empty-d14.log`) → `nodeCount @440 = 71624`, firstMove
  `x=3 rot=0 m=0`, so the new value **71624** is correct (the committed 71600 was
  recorded under the old selection and was wrong).
- `search_golden_empty_d10_no_hold`: the exe has no depth-10 regime from config, so
  the stub got native search-global overrides (`depthlimit=10` writes
  `SearchAI.depthLimit` RVA `0x663F4`; `usehold=0` writes `ExpandAI.useHold` RVA
  `0x663D0`). Exe run (`empty-d14/exe-empty-d10-nohold.log`) →
  `[override] depthLimit=10 useHold=0`, `nodeCount @440 = 27439`, `depth @444 = 10`,
  `firstMove x=0 rot=0 m=0`, `moveDelay=202` — matching the new expectation **27439**.

## 7. Full-game differential after the fix

`fullgame.ts` (fresh-process exe per move, primary `adapt:false` beam-150 d14):

| seed | before          | after                            |
|-----:|:----------------|:---------------------------------|
| 1    | divergence 196  | **500/500 matched** (`N/500`)    |
| 2    | divergence 132  | **200/200 matched** (`N/200`)    |
| 7    | divergence 135  | **200/200 matched** (`N/200`)    |

Secondary counters on the seed-1 run: `actMismatches=0 stateMismatches=0`
(`rustAdaptMoveMismatches=87` is the expected persistent `adapt:true` regime
difference, recorded but not part of the verdict).

## 8. Regression gates

- `cargo test --manifest-path rust/Cargo.toml`: all green (49 hoiko-core tests incl.
  the updated goldens, the turn-183 `beam_cutoff_matches_exe_on_turn183_divergence`
  test at 64174, and the new `is_tspin` witness).
- `bunx tsc --noEmit`, `bun test` (113 pass), `bun run build`, `bun run lint`: green.
- Oracle differentials: `diff.ts` **9/9** depth-10, `diff.ts --timer` **9/9**
  depth-14, `twosearch.ts` **9/9** beam adaptation.

## 9. DeepSeek-v2 gate with the corrected opponent

`DSV2_RUST=1 bun scripts/gate-v2.ts` (32 fixed seeds; raw records in this directory):

| Run | Result | Fingerprint | Notes |
|:----|:-------|:------------|:------|
| faithful (beam 150 + adaptation, old buggy engine) | 25-7 | `6170045b` | previous evidence |
| faithful (beam 150 + adaptation, fixed engine) | **24-8** | `0e5bbd8c` | wall-clock-dependent adaptation (`247.3` vs `239.7` ms/decision); 9 seeds flipped |
| beam 150, no adaptation (old buggy engine) | 22-10 | `ffb04fe2` | previous baseline |
| beam 150, no adaptation (fixed engine) | **26-6** | `677395de` | deterministic regime: +4 wins |

DeepSeek still wins every measured row. The deterministic (no-adaptation) gate improves
22-10 → 26-6; the adaptive gate moves 25-7 → 24-8 under a slightly different wall clock,
which is the documented behaviour of `SetNextOption` (real elapsed time drives the beam).


## 10. Files

Engine/harness:

- `rust/hoiko-core/src/board.rs` — the fix + witness test.
- `rust/hoiko-core/src/search.rs` — the (kept) `std_partial_sort` port.
- `rust/hoiko-core/src/search/tests.rs` — goldens 27439/71624 (exe-verified) +
  turn-183 test.
- `rust/hoiko-core/src/probe_trace.rs`, `rust/hoiko-core/examples/eval_dump.rs` —
  harness-only beam/terminal/pre dumps.
- `src/ai/wasm/hoiko_core.wasm` — rebuilt (87392 bytes).
- `tools/hoiko-oracle/ScpDriverStub.cs` — `tree_dump`, `depthlimit`, `usehold`.
- `tools/hoiko-oracle/diff/replay-turn.ts`, `tree_diff.py` — new tools.
- `tools/hoiko-oracle/diff/expand.ts`, `eval.ts` — `--snapshot` parameterization,
  `--allow-h3-fail`.
- `biome.jsonc` — ignores for the new generated evidence dirs.

Evidence:

- `snapshot-turn196.json`, `eval-input-turn196*.txt` — reconstructed position.
- `replica-beams.txt` / `replica-beams-postfix.txt`, `tree-diff-prefix.txt` /
  `tree-diff-postfix.txt` — exe-arena vs replica beam diffs.
- `exe-tree-dump-turn196.log` (tree pointer + search result), `exe-search-turn196.log`.
- `empty-d14/exe-empty-d14.log`, `empty-d14/exe-empty-d10-nohold.log` — golden
  verification.
- `../chase196-postfix.jsonl`, `../summary-chase196-postfix.jsonl`; seeds 2/7 as
  `../chase-seed{2,7}-postfix.jsonl`.
- `gate-v2-faithful-postfix.jsonl`, `gate-v2-noadapt-postfix.jsonl` — 32-seed gate
  runs with the fixed opponent.
