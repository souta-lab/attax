# Differential oracle report — shipping `Hoiko.exe` vs TS native engine

Scope: `/home/s0u7a/browser-tetris/src/ai/native/*` vs the working Wine runtime oracle
(`/tmp/opencode/oracle/`, real `SearchAI.Search` on a synthetic `RootNode`).
Harnesses: `/tmp/opencode/re/diff/{diff.ts,twosearch.ts,positions.ts}`.

---

## 0. TL;DR

1. **The stated first-move "divergence" is a harness artifact, not an engine bug.**
   `oracle_input.txt` with `board=0x0` does **not** produce an empty board: the stub's
   `LoadInput` overrides only `board[0]`, leaving its built-in defaults
   `line[1]=line[2]=line[3]=0x001` (3-high stack at column 9). The TS side was fed
   `board: []` (truly empty). With the **same** board, oracle and TS agree exactly.
2. **A real divergence was found and fixed** while verifying `GetDelay`: `SearchAI.SetNextOption`
   was fed the **leaf** node's `moveDelay`; the binary uses the **first move's** (gen-1) `moveDelay`.
   `WriteResult` (IL 15774) walks `depth-1` parents and copies the gen-1 `GamePack` to `root+120`,
   so `RootNode.GetDelay` (IL 7148) reads gen-1 `moveDelay`/`act`. This changes the adaptive
   `beamSizeLimit` used by the *next* search (e.g. 47 vs 150 on an empty board).
3. Verified against the oracle: **9/9 first-move+delay positions** and **9/9 two-search beam
   values** match; **4/4 depth-14 positions** match (timer started). All gates green.

---

## 1. Harness usage

```bash
# first-move + GetDelay comparison (timer unstarted => depth 10, matches timeLimitMs:0)
cd /tmp/opencode/re/diff && bun diff.ts                 # all positions
cd /tmp/opencode/re/diff && bun diff.ts empty flat      # subset
cd /tmp/opencode/re/diff && bun diff.ts --timer empty   # call SearchAI.IsSearching(true) => depth 14

# two-search beam-adaptation comparison (oracle 2nd search @452 vs TS post-SetNextOption state)
cd /tmp/opencode/re/diff && bun twosearch.ts
```

Each position writes `/tmp/opencode/oracle/run/oracle_input.txt` and runs
`bash /tmp/opencode/oracle/run_oracle.sh`; `diff.ts` parses `firstMove @456`,
`depth @444`, `beamLimit @452`, `GetDelay`, `moveDelay @400`, `act @416`, then runs
`searchNative(...)` with matching options (`minDepth:10`, `timeLimitMs:0` or `Infinity`,
`adapt:false/true`, `feedQueue:false`).

### Oracle stub changes (opt-in, default output unchanged)
`/tmp/opencode/oracle/ScpDriverStub.cs` gained:
- `timer=1` input key → calls `SearchAI.IsSearching(true)` (token `0x0600020d`) before
  `SearchAI.Search`, starting the 1000 ms timer (depth 14 comparison). **Used this.**
- `twosearch=1` input key → runs a **second** `RootNode.Init` + `Search` and prints its
  `beamLimit @452`, which is the global `beamSizeLimit` adapted by the first search's
  `SetNextOption` (direct observable of the delay bug).
- extra dumps: `board.stackHeight @344`, `fallingMino @152`, `moveDelay @400`, `act @416`.

Rebuild: `bash /tmp/opencode/oracle/build_oracle.sh` (`run_oracle.sh`/`build_oracle.sh` untouched).

---

## 2. The "proven divergence" is a board artifact

Minimal repro:

```
# oracle_input.txt  (this is what the task used, labelled "empty board")
board=0x0                 # overrides line[0]=0 only; defaults line[1..3]=0x001 survive
next=0,3,4,5,6,1,2,...
```

`[input] loaded ... board row 1 mask=0x001 / row 2 mask=0x001 / row 3 mask=0x001`
(see `oracle_result.txt`). So the tested board has column 9 occupied on rows 1–3.

| input | oracle `firstMove @456` | TS (`searchNative`) |
|---|---|---|
| oracle `board=0x0` (col 9 rows 1–3) | `x=6 y=2 rot=2 m=0`, GetDelay 796 | identical board ⇒ `x=6 rot=2 m=0`, moveDelay 796 |
| **truly empty** (`board=0x0,0x0,...` ×32) | `x=3 y=1 rot=0 m=0`, GetDelay 112 | `board:[]` ⇒ `x=3 rot=0 m=0`, moveDelay 112 |

The task compared **oracle-with-col9** vs **TS-truly-empty** — two different positions.
Once the boards match, so do the moves. No expansion/eval/nextmino divergence exists at
this position: `firstMove @456` = the gen-1 node's `lockedMino`, and it equals TS
`outcome.firstX/firstR/firstM` on every board tested.

---

## 3. Real root cause found: `SetNextOption` used the leaf delay

`WriteResult` (IL 15774-15845) walks `depth-1` parents from the best leaf, so
`CopyBlock(root+120, resultNode, 304)` and `CopyBlock(root+456, resultNode+64, 32)`
copy the **gen-1 node** to the root. Therefore:
- `RootNode.GetDelay` (IL 7148) = `root+400` (gen-1 `Command.moveDelay`) + `clearDelay(root+416)`.
- `SearchAI.SetNextOption` (IL 15892) computes `timer.limit = GetDelay(root) - TakeOverTime`
  and `beamSizeLimit` from it — using the **first move's** delay, never the leaf's.

TS `runSearch` returned `moveDelay: best.game.commands.moveDelay` (the **leaf**), and
`index.ts` fed that to `setNextOption`. The resulting beam was wrong.

### Observable proof (two-search oracle, `beamLimit @452` of search 2)

| position | oracle GetDelay₁ | oracle beam₂ | TS pre-fix beam (leaf) | TS post-fix beam |
|---|---|---|---|---|
| empty | 112 | **47** | 150 (leafGetDelay 738) | **47** |
| well9 | 202 | **87** | 74 (leafGetDelay 172) | **87** |
| repro-asrun | 796 | 150 | 74 (leafGetDelay 172) | **150** |
| flat | 688 | 150 | 150 | 150 (coincidental) |
| well0 | 794 | 150 | — | **150** |
| overhang | 1355 | 150 | — | **150** |
| midgame | 248 | **108** | — | **108** |
| flat-I | 688 | 150 | — | **150** |
| midgame-O | 232 | **101** | — | **101** |

Pre-fix values captured before the edit; post-fix all 9 match the oracle.

---

## 4. Exact fix

`src/ai/native/search.ts`:

```diff
 interface NodeState {
   ...
   firstAct: ClearAct;
+  firstMoveDelay: number;
 }

     firstAct: genOne || parent === null ? child.act : parent.firstAct,
+    firstMoveDelay:
+      genOne || parent === null ? child.game.commands.moveDelay : parent.firstMoveDelay,
   };

     firstAct: best.firstAct,
     score: best.score,
     depth,
     node: total,
     overTime,
-    moveDelay: best.game.commands.moveDelay,   // leaf
+    moveDelay: best.firstMoveDelay,             // gen-1 (WriteResult parent walk)
   };
```

Regression tests added to `tests/native-search.test.ts` (values from the oracle):
`outcome.moveDelay === 112` and `setNextOption` ⇒ `timerLimitMs === 107`,
`beamSizeLimit === 47` for the empty-board repro.

---

## 5. Position table — first move + delay (post-fix, `diff.ts`)

| position | oracle (x,rot,m) | oracle depth | oracle GetDelay | TS (x,rot,m) | TS moveDelay | TS outcomeGetDelay | match |
|---|---|---|---|---|---|---|---|
| repro-asrun | 6,2,0 | 10 | 796 | 6,2,0 | 796 | 796 | ✅ |
| empty | 3,0,0 | 10 | 112 | 3,0,0 | 112 | 112 | ✅ |
| flat | 3,0,0 | 10 | 688 | 3,0,0 | 112 | 688 | ✅ |
| well9 | 0,0,0 | 10 | 202 | 0,0,0 | 202 | 202 | ✅ |
| well0 | 0,0,3 | 10 | 794 | 0,0,3 | 218 | 794 | ✅ |
| overhang | 2,0,0 | 10 | 1355 | 2,0,0 | 699 | 1355 | ✅ |
| midgame | -1,3,0 | 10 | 248 | -1,3,0 | 248 | 248 | ✅ |
| flat-I | 3,0,0 | 10 | 688 | 3,0,0 | 112 | 688 | ✅ |
| midgame-O | -1,0,3 | 10 | 232 | -1,0,3 | 232 | 232 | ✅ |

**9/9** first-move match. `outcomeGetDelay == oracle GetDelay` in all 9.

### Depth-14 (timer started via `timer=1` / `SearchAI.IsSearching(true)`)

| position | oracle (x,rot,m) | oracle depth | oracle GetDelay | TS (x,rot,m) | match |
|---|---|---|---|---|---|
| empty | 3,0,0 | 14 | 112 | 3,0,0 | ✅ |
| flat | 3,0,0 | 14 | 688 | 3,0,0 | ✅ |
| repro-asrun | -1,0,3 | 14 | 248 | -1,0,3 | ✅ |
| well9 | 0,0,0 | 14 | 202 | 0,0,0 | ✅ |

**4/4** match. The oracle reaches depth 14 (62k nodes ≪ 1000 ms), so TS `timeLimitMs:Infinity`
is the correct comparison.

---

## 6. Remaining unexplained differences

- **First move / delay / beam: none.** All tested positions agree at depth 10 and depth 14.
- `firstMove @456`'s `y` field is not compared (it is the native `FallMino.y`; `x`,`rot`,`m`
  are the authoritative move and all match). Its value (`y=2` at depth 10) is the resting
  anchor of the gen-1 `lockedMino`, not tracked by TS `SearchOutcome`.
- The oracle `seq[]` dump at `+468` is **misaligned 20 bytes** from the real per-depth records
  (`WriteResult` writes them at `456+32k`); only `@456` was used, as the task instructs.
- The `twosearch` comparison relies on the unstarted-timer artifact making the binary's
  `overTime` a large positive (so `maxBeamSize` clamps to 50). Both sides clamp to 50, so the
  comparison isolates `RootNode.GetDelay`; the `overTime`-driven `maxBeamSize` branch itself was
  not exercised (it needs a started timer and a real wall-clock budget).

---

## 7. Gates

```
bunx tsc --noEmit   -> exit 0 (clean)
bun test            -> 77 pass, 0 fail (221 expect() calls)
bun run build       -> tsc --noEmit && vite build OK (built in 467ms)
```
