# Hoiko v0-beta1 — Canonical Reference (1-page digest)

Target: `Hoiko.exe` (C++/CLI .NET assembly, symbols intact) at
`/tmp/opencode/hoiko-bin/extracted/Hoiko_PPT_v0-beta1/Hoiko_PPT_v0-beta1/`.
Full decompile: `Hoiko.all.cs` (28170 lines). Specs: `SPEC_Search.md`, `SPEC_ExpandAI.md`, `SPEC_EvaluateAI.md`.
The provided `/home/s0u7a/hoiko-src` is an OLDER/SIMPLIFIED revision; **the binary is authoritative.**

---

## 1. Runtime config (`config.dll`, exact)

```
player,1 viewNext,2 useHold,true beamSize,50 useTDOpeners,false speed,25 autoSelect,true
playStyle,0 useOffsetOff,false usePCstack,false useS4W,false loopTemplate,false
threadCount,1 minDepth,10 lifespan,1440 takeOverTime,5
```
Derived: multiEvaluation=false; TemplateAI/OpSearch OFF; ExpandNode picks by `IsSafe`, not config.

## 2. Constants

| Name | Value | Note |
|---|---|---|
| MAX_DEPTH / depthLimit | 14 | |
| MAX_BEAMSIZE / maxBeamSize init | 50 | `ConfigAI.BeamSize()` |
| BEAMSIZE_MIN / MAX | 50 / 500 | clamp of maxBeamSize |
| `beamSizeLimit` (=correctedBeamSize) init | **150** = min(1500, threadCount*50*3) | per-gen parent cap |
| parent cap | `min(beamSizeLimit, children)`; **halved when depth>7** | => 150 / 75 |
| gen-1 cap | **none** | all gen-1 expanded into gen 2 |
| minDepth / lowerDepthLimit | 10 | |
| timer limit (Search) | 1000 ms | time-based; we run to depth 14 deterministically |
| MAX_CHILDREN | 100 | per node |
| trustRate | 0.9 iff `depth > viewNext+2` = **depth>4** (viewNext=2), 1-based gen | |
| trustEnd (fresh bag) | `(viewNext-1)+trustRange`; bag.remains=6 => trustRange 2 => **3** | |
| HardDrop delay | **112** | C++ src says 116 — use 112 |
| move / rotate / softdrop-row / hold delay | 30 / 16 / 33 / 16 | |
| base-prune threshold | childCount > **34** => keep 1 per (r,x) bucket | |
| weight layout | int weight[50]@0, column[10]@200, comboTable[5]@240, double nexus@264 | |

## 3. Board / shapes / SRS

- `Board.line[32]` int, bottom-up; bit `(9-col)` = column `col`; FULL=0x3FF; stackHeight@+128; lockedBottom@+132.
- Shapes/anchors: IDENTICAL to port `src/core/pieces.ts`.
- SRS: IDENTICAL to port `src/core/srs.ts` (native srsA=CW, srsB=CCW; `ny = y - kick.dy`).
- `Bit.Log2(b) = 9 - PopCount(b-1)`; single bit `1<<k` -> column `9-k`.
- MinoType: I0 J1 L2 O3 T4 S5 Z6 None7. ClearAct: None0 Single1 Double2 Triple3 Quad4 Tss5 Tsd6 Tst7 Tsm8 Pc9.

## 4. Search loop (deterministic completion mode)

```
gen1 = ExpandNode(root.game)                       # <=100 children, UNCAPPED
TransitionWeight(root)
for i in gen1: EvaluateFirst(gen1[i]); gen1[i].score = gen1[i].familyScore
depth=1; parentBeam=gen1; nextBeam=len(gen1)
loop:
  depth+=1; SetTrustRate(depth)
  children=[]
  for p in parentBeam[:nextBeam]:
     kids = ExpandNode(p.game)        # <=100 each
     for c in kids: Evaluate(c); c.familyScore += p.familyScore; c.score += p.familyScore
     children += kids
  if depth>=14: break
  if len(children)==0: break
  cap = (depth>7) ? beamSizeLimit>>1 : beamSizeLimit
  nextBeam = min(cap, len(children))
  partial_sort(children, by score desc); parentBeam = children[:nextBeam]
result = argmax(children, raw score)                # MaxElement, NO correction
WriteResult -> first move = plans.mino[0]/act[0]
```
- Evaluate: `familyScore = trunc((actionScore + trunc(boardScore*nexus))*trustRate)`;
  `score = trunc((actionScore+boardScore)*trustRate)`; then wrapper adds parent.familyScore to BOTH.
- **No `pcScore`, no `CorrectScore`** anywhere in the binary.

`Evaluate` boardScore terms (in order):
`Height + WellColumn + UpDown + Underground + Ground + Resource + Tsd + Tst + PcBoard + ContBonus`.
`EvaluateFirst` boardScore terms: `Height + PcBoard + ContBonus` ONLY; familyScore only (no trustRate).

## 5. Expansion (ExpandNode)

```
if IsSafe(parent)  -> ExpandTemplateNode   # stackHeight < fallingMino.y - 3
else               -> ExpandBaseNode       # BFS L,R,B,A with OverrideSameNode dedup
then ExpandDeriveNode ; then RegistChildNode (= LockDown + DeleteSameNode dedup)
if fallingMino.m != hold.m && useHold: repeat with Command.SwapHold, append; total=min(prev+n,100)
```
- `IsSafe = stackHeight < fallingMino.p.y - 3`. At spawn y=20 => template path on any stackHeight<17 (essentially always).
- **ExpandTemplateNode tables** (generated, exact): `native-tables.ts` (childI 33, childSZTJL 33, childO 8).
  Equivalent set = { all hard-drop placements over all rotations × valid columns } ∪ { root spawn (r0,x3) }.
  Entries carry `cmds`, `delay`, `x`, `r`; return value = entries+1 (root included).
- `OverrideSameNode` (baby dedup): key `(r, x, y)`; tie-break keep **lower `commands.moveDelay`**.
- `DeleteSameNode` (node dedup): bucket `(board.lockedBottom, lockedMino.r&1)`; compare
  `board.line[lockedBottom..+3]` and `others.act`; tie-break lower moveDelay.
- `GetAboveCell` = 1 iff some piece cell is strictly below its column height (buried/tucked).
- Derive (tucks) only when `fallingMino.m==4 (T)` OR board has overhang below the min column height.
- `GamePack.LockDown`: HardDrop; LockMino(-1=>fail); Others.CalcAtk; ClearLine; hold.swapped=0;
  lockedMino=fallingMino; nextIt += 1 piece; Spawn (fail=>child rejected).

## 6. NextMino (viewNext=2)

- `m[28]` = deterministic repeating bag `Z,S,T,O,J,L,I`; `bag.remains` 6..0 reset to 6.
- `Compare(0, realNext)` pins `m[0..1]` to the real next 2; `trustEnd = 1 + trustRange(remains)` (3 fresh).
- `IsTrustNext(i) = m + i*4 <= trustEnd`.
- `SearchPcBoard` reads lookahead of 4 pieces from the iterator; gated by `isEvenBoard`;
  `Evaluate`/`EvaluateFirst` call with `minHeight = garbageHeight`.

## 7. Divergences: current port vs binary (must fix)

| # | Binary | Port | Effect |
|---|---|---|---|
| D1 | raw score, no correction | `correctedScore = score - comboDebt - pcScore` | wrong final pick |
| D2 | trust 0.9 at depth>viewNext+2 (=5), viewNext=2 | `ply>=7`, viewNext modeled 5 | over-trust 3 gens |
| D3 | gen-1 uncapped | `min(100,N)` | truncated breadth |
| D4 | cap 150/75 adaptive | fixed `width*3` | width mismatch |
| D5 | moveDelay real, HardDrop 112 | heuristic, 116 | score drift |
| D6 | template expansion (fixed table) | kick BFS | **different child set — primary** |
| D7 | ground/tsd/tst/dtcannon/pcboard eval | stubbed 0 | undervalues T-spin/PC |
| D8 | EvaluateFirst = Height+PcBoard+ContBonus | other | eval mismatch |

## 8. Verification plan (blackbox-equivalence)

Because Hoiko.exe is C++/CLI (cannot run under Mono; Wine lacks .NET here), verification is:
1. Golden unit tests from binary-derived values: Bit.PopCount/Log2, GetColumnHeight, template tables
   (`native-tables.ts`), OverrideSameNode/DeleteSameNode dedup, GetFinalAction values.
2. Deterministic same-input => same-move invariants on `nativeBestMove`.
3. Behavioral metrics: solo (seeds 1,7,42) lines/holes/maxHeight; 32-seed versus gate win-loss.
4. Optional oracle: Wine + dotnet48 (not pursued — uncertain, heavy).

## 9. Undetermined (flagged in specs)

- `Others.CalcAtk` exact combo/btb transitions (partially).
- `SearchTsd/SearchTst/SearchDTCannon/SearchPcBoard` some internal masks.
- `GetFilteredCount` semantics (>34 base placements).
- `drawingBreak` encoding (display-only).
- `std::partial_sort` tie order (MSVC implementation detail) — affects ties at beam boundary only.
