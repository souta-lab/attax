# SPEC — Hoiko `SearchAI` control flow + data model (from `Hoiko.all.cs`)

Status: reconstructed from the decompiled .NET/C++-CLI assembly (`/tmp/opencode/re/Hoiko.all.cs`, 28170 lines).
Cross-checked against the older/simplified C++ source (`/home/s0u7a/hoiko-src/`) and the current TS port
(`/home/s0u7a/browser-tetris/src/ai/hoiko-search.ts`). Where the binary and the C++ src diverge, the
**binary is authoritative** and the divergence is called out. Undetermined facts are listed in §11.

All line numbers refer to `Hoiko.all.cs` unless prefixed `src:` (C++).

---

## 0. TL;DR — the five facts that explain the port's solo self-destruct

1. **Final selection is by RAW accumulated `score` at Node+308.** The binary has **no `CorrectScore` /
   `pcScore` / `EvalPrePcBoard` correction** (grep: zero hits for `CorrectScore`; `MaxElement` 15746
   compares only `+308`; the eval wrapper zeroes `pcScore` at 15484 and never writes it). The port's
   `correctedScore = score - comboDebt - pcScore` is a C++-src artifact and is **wrong for the binary**.
2. **`SetTrustRate` flips to 0.9 at `depth > ViewNext()+2`** (11057–11064). With `viewNext=2`
   that is `depth >= 5`. The port uses `ply >= 7`.
3. **Generation 1 is NOT beam-capped.** Native expands **all** gen-1 children with `EvaluateFirst`,
   then expands all of them into gen 2; the cap only kicks in for the following generations.
   The port caps gen 1 at `min(100, N)`.
4. **The per-generation parent cap is `beamSizeLimit`, not `beamSize`.** With the config it starts at
   **150** (`min(1500, threadCount*beamSize*3)`), halved to **75** for `depth>7`; `beamSize=50` is only
   the adaptive `maxBeamSize` used to derive it, and `speed=25` does not touch the search timer.
5. **`moveDelay` is accumulated while commands are emitted; there is no `CorrectDelay` in the binary.**
   `HardDrop` adds **112** (not 116, 6728). `GetFinalAction` uses `moveDelay >> 4` (13101–13103), so the
   port's 116-vs-112 and its `min(rotation,4-rotation)` estimate change the score.

---

## 1. Symbol → semantic-name → binary-offset map

### 1.1 Statics

| Decompiled symbol | Meaning | Definition |
|---|---|---|
| `?tree@SearchAI@@0PEAVTree@1@EA` | fixed node arena | allocated `new(56580000)` @15546 |
| `?multiEvaluator@SearchAI@@…` | thread pool (40 B) | 15547 |
| `?maxBeamSize@SearchAI@@0HA` | **`basicBeamSize`** (adaptive) | 708; set 15587 |
| `?beamSizeLimit@SearchAI@@0HA` | **`correctedBeamSize`** (per-gen parent cap) | 722; set 15592 |
| `?depthLimit@SearchAI@@0HA` | `upperDepthLimit` | 706; set 15593 |
| `?minDepth@SearchAI@@0HA` | `lowerDepthLimit` | 710; set 15589 |
| `?threadCount@SearchAI@@0HA` | threads | 716; set 15588 |
| `?timer@SearchAI@@0VTimer@@A` | timer: `+0` start ticks `long`, `+8` limit `double` ms | 15586, 15616 |
| `?A0xf01c7b54.MAX_DEPTH` | **14** (`0E 00 00 00`) | 448 |
| `?A0xf01c7b54.MAX_BEAMSIZE` | **500** (`F4 01 00 00`) | 512 |
| `?A0x1b9e76ac.MAX_BEAMSIZE` | **500** | 718 |
| `?A0xd017b33d.MAX_CHILDREN` | **100** (`64 00 00 00`) | 704 |
| `?trustRate@EvaluateAI@@0NA` | eval trust multiplier | set 11059–11063 |
| `?weight@EvaluateAI@@0PEAVEvalWeight@1@EA` | active weight row | set by TransitionWeight / EvenOrOdd |
| `?weightList@EvaluateAI@@0PEAVevalWeight@1@EA` | 4 rows × 272 B (alloc 1088) | 11035 |

### 1.2 `Node` (size **328**; arena stride 328)

| Off | Field | Notes |
|---|---|---|
| +0 | `GamePack game` | 304 bytes (§1.4) |
| +304 | `int childCount` | set by `ExpandNode` into `parent+304` |
| +308 | `int score` | sort key for `Node.Cmp`; final selection key |
| +312 | `int familyScore` | accumulated path value |
| +316 | `int pcScore` | zeroed by wrapper (15484); never written → always 0 |
| +320 | `Node* parentNode` | 8-byte pointer |

No `parentIndex` exists in the binary. `Node.Cmp` (inlined in `partial_sort` 16257, `_Make_heap`):
`a.score > b.score` ⇒ **descending by +308**.

### 1.3 `RootNode` (size 968)

| Off | Field | Notes |
|---|---|---|
| +0 | `NextMino next` | 120 bytes (§1.5) |
| +120 | `GamePack game` | 304 bytes |
| +424 | `int childCount` | `Search` passes `root+424` as `totalChildCount` (15643) |
| +432 | `SearchResult result` | 528 bytes (§1.6) |
| +960 | `int gameover` | `RootNode.End` sets 1 (6998) |

### 1.4 `GamePack` (base = RootNode+120 = Node+0; size 304)

| Off | Field | Notes |
|---|---|---|
| +0 | `NextIterator nextIt { MinoType* m; MinoType* trustEnd; }` | 16 B. `SetNewCurrent` 7119–7120: `m=&next.m[0]`, `trustEnd=&next.m[next.trustEnd]`. `SwapHold` does `*(long*)nxIt += 4` (6885) |
| +16 | `HoldMino hold { MinoType m; int swappedHold; int abnormalHold; }` | `hold.m` = +16 |
| +32 | `FallMino fallingMino` | `p.x`+0, `p.y`+4, `r`+8, `m`+12, `lastSrs`+16, `bugGravity`+20, `shape`+24 (8 B) |
| +64 | `FallMino lockedMino` | `lockedMino.m` = +76 |
| +96 | `Board` (136 B) | `line[32]` ints +0..127, `stackHeight`+128, `lockedBottom`+132 |
| +232 | `Command` (56 B) | `s[48]`+0, `moveDelay`+48, `len`+52 |
| +288 | `Others { int combo; int btb; ClearAct act; }` | combo+0, btb+4, act+8 |
| +300 | pad | |

Derived: board `stackHeight` = GamePack+224 = RootNode+344; `fallingMino.m` = GamePack+44;
`commands.moveDelay` = GamePack+280.

### 1.5 `NextMino` (size 120) — see §4

| Off | Field |
|---|---|
| +0 | `MinoType m[28]` (so `m[27]` = +108) |
| +112 | `int trustEnd` |
| +116 | `int bag.remains` |

### 1.6 `SearchResult` (RootNode+432)

| Off | Field |
|---|---|
| +0 (+432) | `double overTime` = elapsed − timerLimit (set 15888) |
| +8 (+440) | `int node` (total expanded) |
| +12 (+444) | `int depth` |
| +16 (+448) | `int ren` |
| +20 (+452) | `int correctedBeamSize` (= `beamSizeLimit` used, 15889) |
| +24 (+456) | `Plans`: `FallMino mino[14]` (32 B each → +456..903); `ClearAct act[14]` (+904..959) |

`Plans.Clear` semantics: `mino[i].m = None(7)` (init loop 15800, stride 32 at +468 = mino[i].m) and
`act[i] = None(0)` (init loop 15801, stride 4 at +904). There is **no separate `drawingBreak` int**;
the binary encodes it inside `mino[i].lastSrs` (see §11.1).

`MinoType` (src Tetriz_Common.h 7–17): `I=0,J=1,L=2,O=3,T=4,S=5,Z=6,None=7,Garbage=8`.
`ClearAct` (src 33–57): `None=0,Single=1,Double=2,Triple=3,Quad=4,Tss=5,Tsd=6,Tst=7,Tsm=8,Pc=9`.

---

## 2. Initialization

### 2.1 `ConfigAI.ReadConfig` (7293) — value parsing + clamps

Reads `config.dll` (comma text, 16 rows expected). Row → field with clamp:

| row | field | clamp | config value |
|---|---|---|---|
| player | playerNo | [0,3] | 1 |
| viewNext | viewNext | **[2,12]** (7620) | 2 |
| useHold | useHold | !=0 | true |
| beamSize | beamSize | **[50,500]** (7625) | 50 |
| useTDOpeners | useTDOpeners | !=0 | false |
| speed | speed | ∈{25,33,50,100} else 100 (7627) | 25 |
| autoSelect | autoCharSelect | !=0 | true |
| playStyle | playStyle | ∈{0,1,2} else 0 (7637) | 0 = Vs |
| useTimingOffset | useOffsetOff | !=0 | false |
| usePCstack | usePCstack | !=0 | false |
| useS4W | useS4W | !=0 | false |
| loopTemplate | loopTemplate | !=0 | false |
| **minDepth** | **minDepth** | **[0,14]** (7659) | 10 |
| threadCount | threadCount | **[1,2]** (7656) | 1 |
| lifespan | lifespan | ∈{1,3,5,10,30,60,1440} else 1440 | 1440 |
| takeOverTime | takeOverTime | **[0,20]** (7680) | 5 |

Fallback defaults if the file is missing/malformed (7769–7802): viewNext=5, useHold=true,
beamSize=250→clamped, useTDOpeners=false, threadCount=2, minDepth=10, takeOverTime=5 … (note:
the file present, so the table above wins).

`ConfigAI.UseTDOpeners()` (8011) = `viewNext>=5 && useHold && useTDOpeners`. **With viewNext=2 this is
always false**, so `TemplateAI`/`OpSearch` is disabled and plain `Search` runs.

### 2.2 `SearchAI.ReadConfig` (15581) — search globals

```
ExpandAI.ReadConfig(); EvaluateAI.ReadConfig();
timer.limit = 1000.0                            // ms (15586)
maxBeamSize  = ConfigAI.BeamSize()              // 50
threadCount  = ConfigAI.ThreadCount()           // 1
minDepth     = ConfigAI.MinDepth()              // 10
beamSizeLimit = min(1500, threadCount*maxBeamSize*3)   // 15590-15592 = 150
depthLimit    = 14                              // 15593
parallel      = (threadCount > 1)               // 15594
MultiEvaluator.ThreadStart(parallel)
```

For config `beamSize=50, threadCount=1`:
- `maxBeamSize = 50`
- **`beamSizeLimit = 150`** (not 50!)
- `depthLimit = 14`, `minDepth = 10`, timer limit 1000 ms, single-threaded.

### 2.3 `EvaluateAI.ReadConfig` (11038)

`ReadEvalWeight()` (reads `we/wo/wd/wr.dll` → 4×272-byte `weightList`), `TemplateAI.ReadConfig()`,
`isEvenBoard=true`, `multiEvaluation=false`, `useS4W=ConfigAI.UseS4W()`, opponent flags false.

### 2.4 `SearchAI.IsSearching(true)` (15613)

`isSearching=true; timer.start = _Xtime_get_ticks()`. `Timer.Elapsed` (15533) =
`(_Xtime_get_ticks() - timer.start)/10000` → **milliseconds**.

---

## 3. `SearchAI.Search` — exact reconstruction (15619–15744)

`tree` = fixed arena: `gen(d) = tree + (d-1)*1500*328` (stride 1500 nodes, 492000 bytes). 1500 is
`maxBeamSizeLimit`-scale upper bound; the arena holds 115 generations (`56580000 = 328*1500*115`).

```
Search(root):
  if TemplateAI.UseTemplate() && OpSearch(root): return      // 15639 (false for this config)
  C1 = ExpandNode(root.game, gen(1))        // 15644; gen(1)=tree+0; child count written to root+424
  if C1 <= 0:                               // 15646
      RootNode.End(root); isSearching=false; return
  total = C1                                // 15652 (called num2)
  TransitionWeight(root)                    // 15653  (§7)
  // ---- generation 1: EvaluateFirst, NO beam cap ----
  for i in 0 .. C1-1:                       // 15656-15672
      gen(1)[i].parentNode = gen(1)[i]      // 15663 (self; never used for gen1)
      EvaluateFirst(gen(1)[i])              // 15665: writes familyScore at +312
      gen(1)[i].score = gen(1)[i].familyScore   // 15666: +308 = +312
  // ---- beam expansion loop ----
  depth      = 1
  parentGen  = gen(1)                       // ptr3
  childGen   = gen(2)                       // ptr2 = tree+492000
  nextBeam   = C1                           // num5
  loop:
      num = 0                               // 15680
      depth += 1                            // 15681
      SetTrustRate(depth)                   // 15683  (§7)
      for i in 0 .. nextBeam-1:             // 15685-15706
          p   = parentGen[i]
          buf = childGen + num
          ExpandNode(p.game, buf, &p.childCount)   // 15692
          MultiEvaluator.Evaluate(buf, p)          // 15693 (evaluates p.childCount children)
          num += p.childCount                      // 15694
          if depth >= minDepth+1 && timer.Elapsed > timer.limit: break   // 15695-15702
      // (join worker threads if threadCount>1: 15708-15715)
      total += num                          // 15716
      if depth >= depthLimit: break         // 15717
      if depth >= minDepth && timer.Elapsed > timer.limit: break   // 15721-15727
      if num <= 0: break                    // 15729
      cap       = (depth > 7) ? beamSizeLimit/2 : beamSizeLimit    // 15733
      nextBeam  = min(cap, num)             // 15735
      partial_sort(childGen, childGen+nextBeam, childGen+num, byScoreDesc)  // 15736
      parentGen = gen(depth)                // 15737  (tree + (num6-1500)*328)
      childGen  = gen(depth+1)              // 15738
  result = MaxElement(parentGen, childGen, num)   // 15740 (§6)
  WriteResult(root, result, total, depth)         // 15741 (§5)
  SetNextOption(root)                             // 15742 (§8)
  isSearching = false                             // 15743
```

Notes the port must honor:
- `SetTrustRate(0)` is **not** called before gen 1. `EvaluateFirst` (11098) ignores `trustRate`
  entirely, so gen-1 scores are never scaled.
- The `for i` loop can be aborted mid-way by the timer (only when `depth >= minDepth+1`), leaving a
  **partial** `num`; the enclosing break checks then finalize.
- `timer.Elapsed > timer.limit` is written as `timer.limit < elapsed` at 15698/15724/16136/16162.
- `depthLimit` is 14, so `depth` never exceeds 14; `depth>7` halves the cap from depth 8 onward.
- On the very first iteration `nextBeam = C1` ⇒ **all gen-1 children are expanded into gen 2**
  (they are only capped *after* that expansion, for the depth-3 parent set).

### 3.1 `MultiEvaluator.Evaluate` (15471) — where path accumulation happens

For each child index `i` from `parent.childCount-1` downto 0 (note the reverse order, because it
decrements the buffer pointer):
```
child.pcScore(+316) = 0
child.parentNode(+320) = parent
Evaluate(child.game, &child.score(+308), &child.familyScore(+312))   // §7.2, local values
child.familyScore += parent.familyScore       // 15489
child.score       += parent.familyScore       // 15491
```
So the accumulations are:
`familyScore(node) = localFS(node) + familyScore(parent)` and
`score(node) = localS(node) + familyScore(parent)`.
`EvaluateFirst` sets only `familyScore`; `Search` then copies it to `score`.

---

## 4. NextMino / queue semantics (`viewNext=2`)

### 4.1 The bag and `m[28]`

`Bag.Pick` (inlined at 6536 / 6645) is a deterministic 7-cycle in the order
`Z(6), S(5), T(4), O(3), J(1), L(2), I(0)` — i.e. the values of `bag.remains` map
`6→Z, 5→S, 4→T, 3→O, 2→J, 1→L, 0→I`; anything else → `None(7)`. `bag.remains` starts at 6, is
decremented after each pick, and **resets to 6 when it goes below 0** (6547–6549, 6656–6658).

`NextMino.Init` (6529):
```
viewNext = ConfigAI.viewNext        // 2
bag.remains = 6
for i in 0..27:
    m[i] = pick(bag.remains); bag.remains -= 1; if bag.remains < 0 { bag.remains = 6 }
Compare(0, nx)                      // nx = the real next queue from the mimic
```
Result: `m` is a repeating `[Z,S,T,O,J,L,I]` bag; after 28 picks `bag.remains` is back at 6
(28 mod 7 = 0).

### 4.2 `Compare(cmpFirst, nx)` (6567)

```
for i in 0..viewNext-1:
    if m[cmpFirst+i] != nx[i]: Swap(cmpFirst+i, nx[i])
trustRange = switch(bag.remains):
    6 -> 2 ; 5 -> 1 ; 4,3,2,1 -> 0 ; 0 -> 3 ; else -> 0
trustEnd = (viewNext - 1) + trustRange          // 6598
```
`Swap(idx, x)` (6601): find the first `j>idx` with `m[j]==x`; if found, shift `m[idx..j-1]` right one
and place `x` at `idx`; otherwise overwrite `m[idx]=x`.

For the config (fresh turn, `bag.remains=6`): `trustRange=2`, **`trustEnd = 1+2 = 3`**. `m[0]`,`m[1]`
are pinned to the real next two pieces; `m[2]`,`m[3]` are bag predictions.

### 4.3 `NextIterator` and trust/visibility

The binary's `GamePack.nextIt` is the **pointer-pair** variant (`src` `#ifndef OUR` branch):
`{ MinoType* m; MinoType* trustEnd; }`. `RootNode.SetNewCurrent` (7114) sets
`m = &next.m[0]`, `trustEnd = &next.m[next.trustEnd]`. `SwapHold` advances by `m += 4` (one piece,
6885). `IsTrustNext(i)` (6682) = `m + i*4 <= trustEnd` ⇒ with `trustEnd=3`, pieces at absolute
offsets `0..3` are trusted. There is **no `IsVisibleNext`** and **no stored `predictRange`/`visibleRange`**
in the binary (grep confirms). The C++ src represents the same idea with
`predictRemains = remainder(viewNext)` (=5 for n=2), `predictRange = predictRemains+viewNext` (=7),
`visibleRange = viewNext (+1 if predictRemains==1)` (=2); `NextIterator::IsTrustNext/IsVisibleNext`
(src TetrizAI_Common.cpp 205–231). Those fields are **absent from the binary** — implement `trustEnd`
+ `IsTrustNext` instead.

`ShiftNext` (6635) (used when a piece is consumed outside the search, e.g. hold): `m[i]=m[i+1]` for
0..26, `m[27]=pick()`, decrement/reset `bag.remains`; **`trustEnd` is recomputed only by `Compare`**,
not by `ShiftNext`.

### 4.4 Feeding the search and the PC chance

- Every `ExpandNode` copies the parent `GamePack`'s `nextIt` (16 B, 14235) into the baby, and
  `RegistChildNode` copies it into `Node.game+0`. `GamePack.LockDown` then advances the child's
  iterator by one piece (6950, `*(long*)P_0 += 4`) and spawns the next piece.
- `EvaluateAI.SearchPcBoard` (11618) is gated by `isEvenBoard`. It probes whether the board can be
  made PC with `fallingMino.m` (game+44) or `hold.m` (game+16) (`lambda_888f9be…`, 11753), and with a
  lookahead over the **next 4 pieces** read straight from the iterator's `m` pointer
  (`lambda_a87b905…`, 12037–12111, loop `num7=4` reading `*(int*)num6; num6+=4`). It returns
  `weight[+60]` when a PC pattern is feasible, else `PCstack_scale(weight[+56]) * board-depth-estimate`
  when `ConfigAI.UsePCstack()` (false here), else 0.
- `planActs` (`result.plans.act[]`) is a different consumer: it is the reconstructed clear-act sequence
  of the chosen line, and `act[0]`,`act[1]`,`act[2]` are the first three moves' `ClearAct`s. The port's
  OffsetAI reads `act[2]` as the fallback when `act[1]==None` (`src/ai/hoiko-offset.ts:103`). Those
  values come from `WriteResult` (§5), not from NextMino.

---

## 5. `WriteResult` (15774) — first-move reconstruction

Reads `resultNode` (a node in generation `depth`) and walks `parentNode` (+320) up to generation 1:

```
root.result.node  = total            // +440
root.result.depth = depth            // +444
for i in 0..13: plans.mino[i].m = None(7); plans.act[i] = None(0)   // 15798-15806
ren = 0
k = depth-1
for ; k >= 1; k--:                   // 15810-15841
    plans.mino[k] = resultNode.game.lockedMino      // 32 B copy from node+64
    plans.act[k]  = resultNode.game.others.act      // node+296
    combo = resultNode.game.others.combo            // node+288
    if combo > 0: ren = max(ren, combo) else ren = 0
    if combo < 0: mark drawingBreak (plans.mino[k].lastSrs = 8)   // display only
    resultNode = resultNode.parentNode
root.game = resultNode.game          // 304-byte copy; resultNode is now the gen-1 node
plans.mino[0] = resultNode.game.lockedMino
plans.act[0]  = resultNode.game.others.act
// drawingBreak PC fixup (display only, 15847-15881)
ren = max(ren, resultNode.game.others.combo)
root.result.ren = (combo > 0) ? ren-1 : 0
root.result.overTime = timer.Elapsed - timer.limit     // 15888
root.result.correctedBeamSize = beamSizeLimit          // 15889
```

**No `CorrectDelay` call.** `root.game` (hence `root.game.commands.moveDelay`) is exactly the gen-1
node's `GamePack`, whose `moveDelay` was accumulated during expansion (§6.3). The first move to execute
is `plans.mino[0]` with `plans.act[0]`, and `root.game.board` is the board **after** that move.

---

## 6. Expansion + per-piece turn flow

### 6.1 `ExpandNode(parentGame, childNode, &total)` (14207)

```
columnHeight = Board.GetColumnHeight(parentGame.board)          // 14228
// build the baby from the parent
baby.fallingMino = parentGame.fallingMino (32 B, game+32)       // 14231
baby.hold        = parentGame.hold        (12 B, game+16)       // 14233
baby.nextIt      = parentGame.nextIt      (16 B, game+0)        // 14235
Command.Init(baby.commands)                                     // 14236
n = (!GamePack.IsSafe(parentGame)) ? ExpandBaseNode(baby,1,board) : ExpandTemplateNode(baby,1)
n = ExpandDeriveNode(baby, n, board, columnHeight)              // 14239 always
n = RegistChildNode(baby, n, parentGame, childNode)             // 14240
if parentGame.fallingMino.m (game+44) != parentGame.hold.m (game+16) && useHold:   // 14241
    // second baby: start from a hold-swap
    baby2 = parent baby; Command.SwapHold(baby2, hold, board, nextIt)   // 14254
    n2 = ExpandBase/ExpandTemplate(baby2); n2 = ExpandDeriveNode; n2 = RegistChildNode(...)
    total = min(MAX_CHILDREN=100, n + n2)                       // 14260
else:
    total = min(100, n)                                         // 14265
```
`ExpandBaseNode` (14595) is a BFS from spawn over `MoveLeft/MoveRight/RotateB/RotateA`, deduping via
`OverrideSameNode`; if it reaches **>34** placements it prunes with `GetFilteredCount` (14681–14702).
`ExpandDeriveNode` (14706) adds derived T-spin-style placements (TryDeriveRotateA/B, MoveL/R, FinA/B,
14529–14594). With `useTDOpeners=false`, `ExpandTemplateNode` is inert (the caller path is
`!IsSafe → ExpandBaseNode`; `Search` never calls `OpSearch`). `RegistChildNode` (14353) copies each baby
into a `Node.game`, then calls `GamePack.LockDown`; duplicates are dropped by `DeleteSameNode` (14303).

### 6.2 `GamePack.LockDown` (6928) — the child's resulting state

```
Command.HardDrop(child.commands, child.fallingMino, child.board)   // moveDelay += 112, mino drops
cleared = Board.LockMino(board, fallingMino)   // -1 => game over, returns 0
if cleared == -1: return 0
Others.Totaling(child.others, fallingMino, board, cleared)   // CalcAtk: combo/btb/act
if cleared > 0: Board.ClearLine(board)
fallingMino's field +20 (bugGravity) = 0
child.lockedMino = child.fallingMino (32 B copy)
child.nextIt.m += 4                    // consume current piece
fallingMino.Spawn(nextIt.m, board)
```
So the evaluated child has: `lockedMino` = piece just placed, `fallingMino` = next piece to place,
`hold` = hold state, `board` = after clear, `others` = updated combo/btb/act, `commands` = the emitted
command string + `moveDelay`.

### 6.3 `moveDelay` — no `CorrectDelay`

The binary accumulates delay **at emission time** (Command methods, 6687–6920):
`HardDrop +112` (6728), `MoveLeft/MoveRight +30` (6778/6800), `RotateA/RotateB +16` (6825/6851),
`SoftDrop +33/row` (6749), `SwapHold +16` (6880/6891). There is **no `Command.CorrectDelay`** and no
`MoveLeftMost/MoveRightMost` in the binary (grep of `Command.*` returns only Init, AddCommands,
AddCommandSoftDrop, HardDrop, SoftDrop, SoftDropOnce, MoveLeft, MoveRight, RotateA, RotateB, SwapHold,
IsFirstHold). `RootNode.GetDelay` (7148) = `commands.moveDelay + clearDelay*16` where `clearDelay`
is `RootNode.GetClearDelay` (7124): act {0→0; 1,5,8→36; 2,3,6,7→41; 4→46; 9→1}.

`GetFinalAction` (13099) reads: `moveDelay (game+280) >> 4` × `weight+116` (MoveDelay), then a switch on
`others.act (game+296)` and `lockedMino.m (game+76)`, with `combo (game+288)`/`btb (game+292)`;
`Pc` adds `weight+168 - (moveDelay>>5)*MoveDelay`; `Tsm(8)` adds `Single+WasteT-Btb`. The port must feed
the **real accumulated** `moveDelay`, not `116 + min(rot,4-rot)*16 + |x-3|*30`.

### 6.4 Per-piece turn flow (caller view)

`RootNode.Init` (6971): `Board.Init`, `HoldMino.Init`, `NextMino.Init(nx)`, `SetNewCurrent`
(`nextIt={&m[0],&m[trustEnd]}`, spawn `m[0]`), `Command.Init`, `Others.Init`, `gameover=0`,
`result.Clear`. Each turn the caller (`RootNode.ResetPPTData`/`SetPPTData`, 7057/7045) realigns
`board`/`hold`/`next` with the observable game (calling `NextMino.Compare(1, realNext)` and
`ShiftNext`), then `SearchAI.Search(root)`. `WriteResult` replaces `root.game` with the chosen gen-1
state, so the game executes `plans.mino[0]`/`plans.act[0]` and the board advances by one piece.

---

## 7. Evaluation entry points and weight selection

### 7.1 `TransitionWeight(root)` (13533)

Called once per search, immediately after gen 1 is expanded (15653). Sets the global `weight` row using
`playStyle`:
- `playStyle=0 (Vs)` → `transitVs` lambda (13571): computes `center4Height = max(columnHeight[3..6])`;
  if `center4Height+1 <= transitionHeight` (`15`, or `13` if the current row ≥ `weightList[2]`) and
  `stackHeight+1 >= 11` → `weightList[0]`; else the `isEvenBoard`/multiEvaluation logic chooses
  `weightList[0|1|2|3]`; if `center4Height+1 > transitionHeight` → `weightList[2]` (or `[3]` when
  `multiEvaluation && opponentsCombo>8`). `multiEvaluation` is **false** in 1v1-free/solo play.
- `playStyle=1/2 (Ultra/Sprint)` → `transitSolo` (not in binary decompile as separate fn; binary
  13655–13663 handles style 0 default and 1/2 by height): `stackHeight+1 <= 10 → weightList[0]`,
  else `weightList[1]` — but the binary's cases 1/2 at 13546/13556 use **stackHeight+1 <= 10 ? row0 :
  row2** (the `+272` row), not row1. Treat as authoritative binary behavior.

`EvaluateAI.EvenOrOdd` (13654) sets `isEvenBoard = (~Board.PopCount(board) & 1) != 0` and
`weight = weightList[2]`; in the normal path this is **only called from `QuickSearch`** (15603), not
from `Search`, so a plain `Search` uses the `isEvenBoard` from `ReadConfig` (true) unless the caller
set it otherwise.

### 7.2 `Evaluate` / `EvaluateFirst`

`Evaluate(game, &score, &familyScore)` (11066):
```
boardScore = GetHeight + GetWellColumn + GetUpDown + GetUnderground + GetGround
           + GetResource + SearchTsd + SearchTst + SearchPcBoard + GetContBonus
actionScore = GetFinalAction(game)
familyScore = trunc( (trunc(boardScore * weight[+264]) + actionScore) * trustRate )
score       = trunc( (boardScore + actionScore) * trustRate )
```
`EvaluateFirst(game, &familyScore)` (11098): same board terms but only
`GetHeight + SearchPcBoard + GetContBonus`, and
`familyScore = GetFinalAction + trunc(sum * weight[+264])` — **no trustRate**, no `score`.
`weight[+264]` is the “nexus” weight (partially discounted board score).

The wrapper (§3.1) then adds `parent.familyScore` to both accumulators. **No `pcScore` term exists in
the binary.**

---

## 8. `MaxElement` (15746) and `SetNextOption` (15892)

### 8.1 `MaxElement(parentGen, childGen, n)`

If `n <= 0`: write `childGen.score=-2147483647`, `+316=0`, `+76=7`, `parentNode=parentGen`; return it.
Otherwise linearly scan `childGen[0..n-1]` and return the node with the **largest `+308`** (ties → the
earlier). Raw score; no correction.

### 8.2 `SetNextOption(root)` ≡ C++ `SearchParams::AdjustParams`

```
overTime = root.result.overTime                 // +432 = elapsed - limit
if overTime > 0:
    maxBeamSize += (depth - 14) * 10            // depth <= 14 ⇒ shrinks
    maxBeamSize = clamp(maxBeamSize, 50, 500)
else if overTime < -33.0 && timer.limit < 336.0:
    maxBeamSize += trunc((overTime + 16.0) * 0.06) * -10   // grows
    maxBeamSize = clamp(maxBeamSize, 50, 500)
timeLimit = RootNode.GetDelay(root) - ConfigAI.TakeOverTime()   // ms; also written to timer.limit
beamSizeLimit = trunc( maxBeamSize * timeLimit * (1.0/112.0) )
beamSizeLimit = min(beamSizeLimit, maxBeamSize * 3)
if !GamePack.IsSafe(root.game): beamSizeLimit = trunc(beamSizeLimit * 0.8)
depthLimit = 14
```
Constants: `MAX_DEPTH=14`, `BEAMSIZE_MIN=50`, `MAX_BEAMSIZE=500`, `1/112` scale (the C++ src used
`1/(F*7) = 1/116.67`; the binary uses **112** — authoritative). This function readies the globals for
the *next* `Search`.

---

## 9. `OpSearch` (15920) — template path (disabled for this config)

`Search` calls `OpSearch` only when `TemplateAI.UseTemplate()` is true (15639). `UseTemplate` inherits
`ConfigAI.UseTDOpeners()`, which requires `viewNext>=5` (8011). With `viewNext=2` it is always false, so
**`OpSearch` is dead code for the target config**. For completeness, `OpSearch` mirrors `Search` but:
- picks `OpExpandNode` vs `ExpandNode` by `TemplateAI.OpDropCount() <= 20` (16029/16035);
- uses `TemplateAI.OpEvaluateFirst` (16057) and `MultiEvaluator.OpEvaluate` (16131);
- overrides `depthLimit`/`beamSizeLimit`/timer from `OpDropCount()` buckets (15969–16024), including
  `beamSizeLimit` values 1500/50/500 and `depthLimit` 6..14;
- partitions scored nodes and re-selects on `BeamTemplate` (16071–16203);
- same `MaxElement` + `WriteResult` + `SetNextOption` tail (16207–16212).

If the port ever enables TD openers, this is where the extra branching lives.

---

## 10. Effective numbers for the target config

`viewNext=2, useHold=true, beamSize=50, useTDOpeners=false, speed=25, playStyle=0,
threadCount=1, minDepth=10, lifespan=1440, takeOverTime=5`.

| Quantity | Value | Source |
|---|---|---|
| `maxBeamSize` init | 50 | 15587 |
| `beamSizeLimit` init | `min(1500, 1*50*3)` = **150** | 15590–15592 |
| parent cap, `depth ≤ 7` | `min(150, numChildren)` | 15733 |
| parent cap, `depth > 7` | `min(75, numChildren)` | 15733 |
| gen-1 cap | **none** (all `C1` expanded into gen 2) | 15656–15738 |
| `depthLimit` | 14 | 15593 |
| `minDepth` | 10 | 15589 |
| timer limit (normal `Search`) | 1000 ms | 15586 |
| timer limit (`QuickSearch`) | 56 ms, plus `beamSizeLimit = maxBeamSize*0.5 = 25` | 15600–15601 |
| `trustRate` | 1.0 for `depth ≤ 4`; 0.9 for `depth ≥ 5` | 11060 |
| `trustEnd` (fresh bag) | 3 | 6598 |
| `beamSizeLimit` after a turn | `min(trunc(50*(GetDelay−5)/112), 150)` (×0.8 if unsafe) | 15908–15915 |
| children per parent | ≤ 100 (`MAX_CHILDREN`) | 14260 |
| `speed=25` effect on search | **none** (only drives the outer game poll at 3636) | 3636 |

`beamSize=50` is therefore *not* the beam width you observe; it is the adaptive coefficient behind a
150/75 per-generation parent cap at all times except the first gen-1 expansion.

---

## 11. Binary vs C++ src vs current TS port — divergences that matter

| # | Binary (authoritative) | C++ src | Port (`hoiko-search.ts`) | Impact |
|---|---|---|---|---|
| D1 | final pick = max raw `+308`; no correction | `CorrectScore` subtracts `combo*ComboDebt` and `pcScore` at `MaxElement` (TetrizAI_Search.cpp 69–84, 260–272) | `correctedScore = score - comboDebt - pcScore` (549–552) | over-penalizes; prime solo self-destruct suspect |
| D2 | trust 0.9 at `depth ≥ viewNext+3` = 5 | same (viewNext+2) | `ply >= 7`, and viewNext modelled as 5 | 3 generations of over-trusted evals |
| D3 | gen-1 never capped | gen-1 never capped | `min(100,N)` then `max(limit, width)` (518–522) | truncates breadth before gen 2 |
| D4 | `beamSizeLimit` = 150/75, adapted from GetDelay/112 | `correctedBeamSize=basic*3`, `MIN_DELAY=1/116.67` | `correctedWidth = width*3` fixed; no per-turn adapt | width/adaptation mismatch |
| D5 | `HardDrop +112`; real command accumulation | `HardDrop +116` + `CorrectDelay` | `116 + min(rot,4-rot)*16 + abs(x-3)*30` (127–157) | `moveDelay>>4` differs → score drift |
| D6 | 28-piece repeating bag; `trustEnd`/pointer iterator | same + predictRange/visibleRange | `queue.slice`, depth clamped to queue length (456, 464) | lookahead shorter than native |
| D7 | `speed` unused by search | `lowerDepthLimit` private config | n/a | none if port fixed depth 14 |
| D8 | `EvaluateFirst` ignores trustRate | same | passes `trustRate` (1.0 at ply 0, harmless) | benign |
| D9 | expansion uses full SRS BFS every ply | same | kick placements only at ply 0 (`isFirst`) | placement set narrower |

---

## 12. Undetermined / partially reversed (explicit)

1. **`Plans.drawingBreak` encoding in the binary** (15831–15881): stored as `mino[i].lastSrs == 8`
   plus a `mino[i].m` toggle, not a standalone int. This only drives the PC rendering annotation; the
   search result (`node`,`depth`,`ren`,`act[]`,`mino[]`) is unaffected. Exact display semantics
   undetermined. *Line 15831–15881.*
2. **`GetFilteredCount` pruning rule** when a piece has >34 base placements (14681–14702): the
   filter predicate (`lambda_61179e73…` / `std.partition` on BabyNode) was not reversed; only the
   threshold (>34) and the fact that it keeps `num7` entries is known. Needed for exact child sets.
   *Lines 14681–14702.*
3. **`ExpandDeriveNode` full placement set** (14706–14951): the derived T-spin placements
   (TryDeriveRotateA/B, TryDeriveMoveL/R, TryDeriveFinA/B) were not transcribed move-by-move; the
   gate conditions visible at 14450/14464/14545 use `GetAboveCell` and the “3-column full” mask
   (`==1023`). Needed for exact child sets. *Lines 14443–14594, 14706–14951.*
4. **`SearchPcBoard` internal feasibility checks** (11618–12111): the exact board-pattern match masks
   per mino type (e.g. `I` 960/512, `J` 896, the 4-piece count loop) were only partly read. Inputs and
   return weighting (`weight[+60]`, `weight[+56]`) are known; the per-piece geometry is not fully
   enumerated. *Lines 11618–12111.*
5. **`ExpandTemplateNode` / `TemplateAI` gating** (14872–14951): assumed inert because
   `UseTDOpeners()` requires `viewNext>=5`; if the port models a different `viewNext`, re-verify
   `TemplateAI.UseTemplate`. *Lines 14872, 16526, 8011–8015.*
6. **`Spawn`/`Board.LockMino` exact line-clear and top-out layout** (Board 20699–21100): mapped from
   offsets and the C++ src; not step-verified in the binary.
7. **`Others.Totaling` (CalcAtk)** exact combo/btb transitions (21211–21310): the port reimplements
   them (`sourceOthers`); binary-level verification pending.

---

## 13. Implementable TS checklist

1. Model `NextMino` with `m[28]`, `trustEnd`, `bagRemains`; `Init` builds the 7-bag and
   `Compare(0, realNext)` pins `m[0..viewNext-1]`; `trustEnd = viewNext-1 + trustRange(bagRemains)`.
   Expose a pointer-like iterator supplying `IsTrustNext(i) = i <= trustEnd` and lookahead of 4 pieces.
2. `Search(root)`:
   - gen 1: `ExpandNode` all children (≤100), `TransitionWeight`, then `EvaluateFirst` each and set
     `score = familyScore`. **No cap.**
   - loop with `depth` from 2; `SetTrustRate(depth)` = 0.9 iff `depth > viewNext+2`.
   - expand `nextBeam` parents, `Evaluate` each child, accumulate `parent.familyScore` into both
     `familyScore` and `score`.
   - break on `depth>=14`, `depth>=10 && elapsed>limit`, or `children==0`.
   - cap = `beamSizeLimit` (or its half when `depth>7`); sort desc by `score`; keep the top `cap`.
3. `MaxElement` = max raw `score` (do **not** subtract comboDebt/pcScore).
4. `WriteResult`: walk parents from the result to gen 1, fill `mino[k]/act[k]`, copy the gen-1 game to
   `root.game`, set `mino[0]/act[0]` and `ren`; `first move = mino[0]/act[0]`.
5. `SetNextOption`: recompute `maxBeamSize` (±10 per depth/16ms) and
   `beamSizeLimit = min(trunc(maxBeamSize*timeLimit/112), maxBeamSize*3)`, ×0.8 if unsafe;
   `timeLimit = moveDelay + clearDelay*16 - takeOverTime`.
6. Emit `moveDelay` from the real command sequence (hardDrop 112, move 30, rotate 16, hold 16).

---

*Generated from `/tmp/opencode/re/Hoiko.all.cs`; no files under `/home/s0u7a/browser-tetris` were modified.*
