# SPEC — Reconstructed native `Hoiko v0-beta1` `EvaluateAI`

Authoritative target: `Hoiko.exe` (`.NET/C++/CLI` managed wrapper over native `EvaluateAI`, symbols intact),
decompiled at `/tmp/opencode/re/Hoiko.all.cs`.
Runtime config: `config.dll` (`playStyle=0` VS, `useTDOpeners=false`, `useOffsetOff=false`,
`usePCstack=false`, `useS4W=false`, `viewNext=2`, `threadCount=1`).

This document reconstructs the five `EvaluateAI` entry points that the provided C++ source
(`/home/s0u7a/hoiko-src/TetrizAI_Evaluate.cpp`) **stubs to `return 0`**, plus their lambdas:

| Binary method | IL range (Hoiko.all.cs) | CPP stub |
|---|---|---|
| `EvaluateAI.GetGround` | 11273–11346 | `EvalGround` (cpp:373–376) |
| `EvaluateAI.SearchPcBoard` (+ 4 lambdas) | 11618–12111 | `EvalPcBoard` (cpp:599–616) |
| `EvaluateAI.SearchTsd` | 12113–12419 | `EvalTsd` (cpp:576–579) |
| `EvaluateAI.SearchTst` (+ 4 lambdas) | 12421–12827 | `EvalTst` (cpp:581–591) |
| `EvaluateAI.SearchDTCannon` (+ 2 lambdas) | 12829–13078 | `EvalDTCannon` (cpp:593–596) |

Everything below is transcribed from the decompiled IL. Where the IL is ambiguous or a constant
is suspicious it is flagged with a **UNDETERMINED** note (exact IL line + why) rather than guessed.

---

## 0. Ground rules / naming used in this spec

Pseudocode operates on a `GamePack g` whose fields are named (no pointer math):

```
g.line[y]         int 10-bit row mask, y = 0 is bottom row, y grows upward
g.stackHeight     int, highest non-zero row (Board+128); -1 iff empty board
g.holdM           MinoType (GamePack+16)
g.fallingM        MinoType (GamePack+44; FallMino.m at GamePack+32+12)
g.lockedM         MinoType (GamePack+76; lockedMino FallMino copy m at GamePack+64+12)
g.lockedX         int (GamePack+64; lockedMino FallMino .x — column of last lock)
g.lockedY         int (GamePack+68), g.lockedR int (GamePack+72)
g.next(i)         MinoType at *(GamePack+0) + i*4   (NextIterator array base)
g.trustEnd        pointer (GamePack+8); IsTrustNext(i): &g.next(i) <= g.trustEnd
g.moveDelay       int (GamePack+280; Command.moveDelay = Command+48)
g.combo           int (GamePack+288; Others.combo)
g.btb             int (GamePack+292; Others.btb)
g.act             ClearAct (GamePack+296; Others.act)
ch[x]             columnHeight[x] (produced by GetColumnHeight)
```

### 0.1 MinoType encoding (proved, not assumed)

From `SearchPcBoard.<lambda_888…>` (11660/11753) matched against CPP `EvalPrePcBoard::searchPc`,
and `GetContBonus`/`GetFinalAction`:

| MinoType | value |
|---|---|
| I | 0 |
| J | 1 |
| L | 2 |
| O | 3 |
| T | 4 |
| S | 5 |
| Z | 6 |
| (none) | 7 |

Proof points: `GetContBonus` (13080) maps `g.holdM==4 → HoldT(+124)`, `==0 → HoldI(+120)`;
`SearchPcBoard` case 0 = I-shape (960), case 4 = T-shape (896/256), case 5 = S (384/768), case 6 = Z
(768/384). `HoldMino.Init` sets `hold.m = 7` (none).

### 0.2 ClearAct encoding (proved)

`GetFinalAction` switch at 13105 on `g.act`; values line up with CPP `ClearAct`:

| ClearAct | value |
|---|---|
| None | 0 |
| Single | 1 |
| Double | 2 |
| Triple | 3 |
| Quad | 4 |
| Tss | 5 |
| Tsd | 6 |
| Tst | 7 |
| Tsm | 8 |
| Pc | 9 |

### 0.3 Board bit orientation + helpers

* `Board.line[y]` bit `(9-x)` = column `x` (bit 9 = column 0, bit 0 = column 9). Proven by
  `Board.GetColumnHeight` (21122–21179): `(num>>9)&1 → ch[0] … num&1 → ch[9]`.
* `Bit.PopCount(b)` (20607) = popcount of a 10-bit value.
* `Bit.Log2(b)` (20612) = `9 - PopCount(b-1)`; for a single bit `1<<k` this is `9-k` = column index.
* `Board.PopCount(B)` (21094) sums popcount over `line[0..stackHeight]`.
* `Board.IsEvenPop`/`EvaluateAI.EvenOrOdd` (13654): `(~Board.PopCount & 1) != 0` → even filled count.
* `Board.GetColumnHeight(B, ch)` (21122): returns `minHeight` = row index of the highest full row (the
  lowest row `y` such that `line[y..stackHeight]` OR to `0x3FF`), or `-1` if no full row. It also fills
  `ch[x]` with the filled-cell count in column `x` plus `(y+1)` if a full-row base was found. This is
  the `garbageHeight`/`minHeight` value passed to all the functions below. **The port's
  `getColumnHeight` (hoiko-eval.ts:135–152) reproduces this exactly.**
* `Board.UpdateMaxHeight` (21077) sets `stackHeight` = highest non-zero row, `-1` if empty.

### 0.4 `GamePack+64` is `lockedMino` (FallMino copy) — determined

`GamePack.LockDown` (6928–6953) does
`memcpy(GamePack+64, GamePack+32 /*fallingMino*/, 32)`. Therefore `GamePack+64` = last locked
`FallMino` (x,+0 y,+4 r,+8 m,+12), so `GamePack+76 = lockedMino.m` and `GamePack+64 = lockedMino.x`.
This is why `GetFinalAction` reads `g.lockedM` at +76 and `SearchPcBoard` lambda3 reads a piece
column at +64.

### 0.5 `NextIterator` / `IsTrustNext` (6682)

```
IsTrustNext(nextIt, i) = ( nextIt.next + i*4 <= nextIt.trustEnd )
```
`RootNode.SetNewCurrent` (7114) sets `GamePack+0 = &m[0]` and `GamePack+8 = &m[trustIndex]`.
With `viewNext=2` the trust window is small (see SetTrustRate, 11057: `depth > viewNext+2 ⇒ 0.9`).

---

## 1. `EvalWeight` layout → `W` index → `we.dll` value (EXACT)

`EvalWeight` = 272 bytes (`EvaluateAI.EvalWeight`, Size=272):
`int weight[50]` @0, `int column[10]` @200, `int comboTable[5]` @240, `double nexus` @264.
`weight[index]` sits at byte `index*4`; `column[x]` at `(x+50)*4` = `200+x*4`; `comboTable[r]` at
`(r+60)*4` = `240+r*4`. All IL offsets below corroborate this.

`config playStyle=0` loads `weightList = [we, wo, wd, wr]` and starts at `weight = weightList[0] = we`.
Values are from `we.dll` (read positionally by line index == `W` index, per `ReadWeight` 10671 and the
port's parser hoiko-weights.ts:45).

| W idx | W name | byte | `we.dll` | `wo.dll` | `wd.dll` | `wr.dll` |
|---|---|---|---|---|---|---|
| 0 | MaxHeight | 0 | -15 | -15 | -15 | -50 |
| 1 | Over10 | 4 | -30 | -30 | -30 | -100 |
| 2 | Over15 | 8 | -100 | -100 | -100 | -0 |
| 3 | UpDown2 | 12 | -4 | -4 | -4 | -4 |
| 4 | DonateCover | 16 | -25 | -25 | -25 | -25 |
| 5 | Cover | 20 | -10 | -10 | -10 | -10 |
| 6 | Roof | 24 | -15 | -15 | -15 | -15 |
| 7 | BadRoof | 28 | -50 | -50 | -50 | -50 |
| 8 | Pierce | 32 | -120 | -120 | -120 | -120 |
| 9 | Anabara | 36 | -70 | -70 | -70 | -70 |
| 10 | WellHint | 40 | 10 | 10 | 10 | 10 |
| 11 | WellDepth | 44 | 10 | 10 | 10 | 10 |
| 12 | WellPeak | 48 | 5 | 5 | 7 | 7 |
| 13 | *(Column → `column[]`)* | 52 | — | — | — | — |
| 14 | PcStack | 56 | 30 | 30 | 30 | 30 |
| 15 | PcChance | 60 | 1000 | 300 | 1000 | 1000 |
| 16 | Resource | 64 | 2 | 2 | 2 | 2 |
| 17 | ResourceMax | 68 | 30 | 50 | 30 | 30 |
| 18 | TsdHole | 72 | 5 | 5 | 5 | 5 |
| 19 | TsdSpinable | 76 | 5 | 5 | 0 | 0 |
| 20 | TsdClearable | 80 | 35 | 35 | 15 | 15 |
| 21 | TsdOffensive | 84 | -30 | -30 | -30 | -30 |
| 22 | TstHole | 88 | 15 | 15 | 10 | 10 |
| 23 | TstSpinable | 92 | 15 | 15 | 10 | 10 |
| 24 | TstClearable | 96 | 35 | 35 | 15 | 15 |
| 25 | TstHint | 100 | 10 | 10 | 0 | 0 |
| 26 | TstOffensive | 104 | -100 | -100 | -100 | -100 |
| 27 | TDHole | 108 | 60 | 60 | 35 | 35 |
| 28 | TDHint | 112 | 20 | 20 | 10 | 10 |
| 29 | MoveDelay | 116 | -3 | -3 | -3 | -3 |
| 30 | HoldI | 120 | 10 | 10 | 10 | 10 |
| 31 | HoldT | 124 | 10 | 10 | 10 | 10 |
| 32 | WasteI | 128 | -100 | -50 | -150 | -150 |
| 33 | WasteT | 132 | -100 | -150 | -100 | -100 |
| 34 | Single | 136 | -350 | -350 | -350 | -350 |
| 35 | Double | 140 | -300 | -300 | -250 | -250 |
| 36 | Triple | 144 | -250 | -250 | -200 | -200 |
| 37 | Quad | 148 | 200 | 100 | 200 | 200 |
| 38 | Tss | 152 | 50 | 50 | 50 | 50 |
| 39 | Tsd | 156 | 300 | 300 | 300 | 300 |
| 40 | Tst | 160 | 500 | 500 | 400 | 400 |
| 41 | Btb | 164 | 50 | 50 | 50 | 50 |
| 42 | Pc | 168 | 1500 | 1000 | 1500 | 1500 |
| 43 | ComboBtb | 172 | 50 | 50 | 50 | 50 |
| 44 | *(ComboAtk → `comboTable[]`)* | 176 | — | — | — | — |
| 45 | ComboDebt | 180 | 250 | 250 | 250 | 250 |
| 46 | *(Nexus scalar)* | 184 | 50 | 50 | 50 | 50 |

`column[]` @200: `we/wo = [-50,-70,-10,0,0,0,0,-10,-70,-50]`, `wd/wr = [0,-15,0,0,0,0,0,0,-15,0]`.
`comboTable[]` @240: all VS presets `[180,360,540,900,1080]`.
`nexus` @264 (double): `clamp(weight[46],0,100)*0.01 = 0.5` for `we/wo/wd/wr`.

Offsets explicitly requested: `+4 → W[1] Over10`, `+8 → W[2] Over15`, `+56 → W[14] PcStack`,
`+60 → W[15] PcChance`, `+72 → W[18] TsdHole`, `+76 → W[19] TsdSpinable`,
`+80 → W[20] TsdClearable`, `+84 → W[21] TsdOffensive`, `+264 → nexus double`. **All confirmed.**
Additional offsets used by the reconstructed code: `+88 W[22] TstHole`, `+92 W[23] TstSpinable`,
`+96 W[24] TstClearable`, `+100 W[25] TstHint`, `+104 W[26] TstOffensive`, `+108 W[27] TDHole`,
`+112 W[28] TDHint`, `+24 W[6] Roof`, `+28 W[7] BadRoof`, `+32 W[8] Pierce`, `+36 W[9] Anabara`,
`+16 W[4] DonateCover`.

**Parser note.** `ReadWeight` (10671) parses positionally; the port's `parseHoikoWeights`
(hoiko-weights.ts:45–109) is byte-equivalent (line index == `W` index, line 13 = Column,
line 44 = ComboAtk with the `comboTable[r]=comboTable[0]*(r+1)` fill-in, line 46 = Nexus,
zero the whole struct if `i != correct`).

### 1.1 Mask/constant reference

All masks are 32-bit ints; `line` only ever has bits 0–9 set.

| hex | dec | meaning (source orientation) |
|---|---|---|
| 0x3FF | 1023 | all 10 columns full (FULL) |
| 0x3C0 | 960 | cols 0–3 |
| 0x380 | 896 | cols 0–2 |
| 0x300 | 768 | cols 0–1 |
| 0x2C0 | 704 | cols 0,1,3 |
| 0x280 | 640 | cols 0,2 |
| 0x200 | 512 | col 0 |
| 0x1E0 | 480 | cols 1–4 |
| 0x1C0 | 448 | cols 1–3 |
| 0x180 | 384 | cols 1–2 |
| 0x140 | 320 | cols 1,3 |
| 0x120 | 288 | cols 1,4 |
| 0x100 | 256 | col 1 |
| 0x0F0 | 240 | cols 2–5 |
| 0x0E0 | 224 | cols 2–4 |
| 0x0C0 | 192 | cols 2–3 |
| 0x0A0 | 160 | cols 2,4 |
| 0x080 | 128 | col 2 |
| 0x07 & 7 | 7 | cols 7–9 |
| 0x780 | 1920 | bits 7–10 (bit10 always 0 ⇒ effectively 0x380) |
| 0x3E0 | 992 | cols 0–4 |
| 0x1F | 31 | cols 5–9 |
| 0xF | 15 | cols 6–9 |
| 0xE | 14 | cols 6–8 |
| 0x5 | 5 | cols 7,9 |
| 0x2 | 2 | col 8 |

---

## 2. `GetGround` (binary 11273–11346)

Called from `Evaluate` as `GetGround(g, ch, y0 = wellDepth + garbageHeight)`
(IL 11087). Runs **unconditionally** — it is not gated by `usePCstack`/`useS4W`/`useOffsetOff`.
The CPP stub (cpp:373–376) returns 0; the real function is below.

`y0 = minHeight + wellDepth` where `wellDepth` is the value written by `GetWellColumn`. On a board
with no full row, `minHeight = -1`. Semantics: it scans the region from just under the top row down
to `y0+1`, finds empty cells that are covered by the stack above, and classifies them as
*Roof* (a 2-wide floor), *BadRoof* (partially supported), or *Pierce* (an isolated overhang).

```
int GetGround(g, ch, y0):
    roof     = 0     // IL "num"
    roofCnt  = 0     // "num2"
    badRoof  = 0     // "num3"
    pierce   = 0     // "num4"
    scratch  = 0     // "num5", only used in max(0,stackHeight)

    // seed mask: top occupied row, or row 0 if the stack is empty/negative
    topRow = (0 >= g.stackHeight) ? 0 : g.stackHeight
    cover = g.line[topRow]           // "num6": union of filled cells seen above

    y = g.stackHeight - 1            // "num7"
    if (y > y0) {
        count = y - y0
        do {
            empty = (~g.line[y]) & cover     // cells empty at y, filled somewhere above
            rowMax = 0                        // "num12"
            while (empty != 0) {
                x = Bit.Log2(empty & -empty)  // column of lowest set bit
                depth = ch[x] - y
                if (x < 8 && ch[x+1] < y) {
                    if (ch[x+2] < y) { roof += depth; roofCnt += 1; }
                    else             { badRoof += depth; }
                } else if (x > 1 && ch[x-1] < y) {
                    if (ch[x-2] < y) { roof += depth; roofCnt += 1; }
                    else             { badRoof += depth; }
                } else {
                    rowMax = max(rowMax, depth)   // isolated overhang => pierce candidate
                }
                empty &= ~(512 >> x)              // clear this column
            }
            pierce += rowMax
            cover |= g.line[y]
            y -= 1
            count -= 1
        } while (count != 0)

        if (roofCnt == 1) roof = 1       // IL 11343: single roof cell collapses to 1
    }
    return W[8]·Pierce·pierce + W[7]·BadRoof·badRoof + W[6]·Roof·roof
    // IL 11345 uses offsets +32, +28, +24 exactly
```

Notes:
* `x` is a **column index in source orientation** (0 = bit 9 = leftmost).
* `roofCnt == 1 ⇒ roof = 1` means a lone roof cell contributes only one Roof unit, not its depth.
* Rows processed: `stackHeight-1` down to `y0+1` inclusive.
* On an empty board `y = -2 <= y0` (y0 ≥ -1) ⇒ loop skipped, score 0.

---

## 3. `SearchPcBoard` (binary 11618–12111) + lambdas

Signature: `SearchPcBoard(GamePack* g, int minHeight)`. `minHeight` is the **garbage height**
(`GetColumnHeight` result). `Evaluate`/`EvaluateFirst` call it with `minHeight = garbageHeight`
(IL 11091, 11114). The `usePCstack=false` config only disables the `lambda1` branch; **the
`minHeight == -1` PcChance branch always runs.**

```
int SearchPcBoard(g, minHeight):
    if (!isEvenBoard) return 0                    // IL 11623; global set by EvenOrOdd
    if (minHeight == -1) {
        if (lambda2_searchPc(g, g.fallingM)) return W[15]·PcChance        // IL 11635
        if (g.fallingM != g.holdM && lambda2_searchPc(g, g.holdM))
            return W[15]·PcChance                                      // IL 11640
        if (lambda3_pcSetup(g)) return W[15]·PcChance                  // IL 11644
    }
    if (ConfigAI.UsePCstack()) {
        w = W[14]·PcStack                          // IL 11651
        if (w != 0) return lambda1_pcStack(g) * w  // IL 11654
    }
    return 0
```

### 3.1 `lambda1_pcStack` (11660–11694)

```
int lambda1_pcStack(g):
    if (g.stackHeight > 3) return 0
    goalH = ((Board.PopCount(g) & 3) == 0) ? 3 : 2      // IL 11667
    if (goalH > g.stackHeight) return 1                  // IL 11670
    if (!lambda1b_valid(g, goalH)) return 0              // IL 11672 (inner lambda 11697)
    full = 0x3FF
    for (i = 0; i <= g.stackHeight; i++) full &= g.line[i]
    return Bit.PopCount(full) + 1                        // IL 11691
```

### 3.2 `lambda1b_valid(goalH)` (11697–11750) — inner lambda `<lambda_f819…>`

```
bool lambda1b_valid(g, goalH):
    full = 0x3FF
    for (i = 0; i <= goalH; i++) full &= g.line[i]       // cols full through goalH
    acc = 0
    for (col = 0; col < 10; col++) {
        bit = 512 >> col                                  // source bit for this column
        if ((full & bit) != 0) {
            if (acc == 0) continue                        // IL 11720 goto skip
            holes = 0
            for (i = 0; i <= goalH; i++)
                holes += Bit.PopCount((~g.line[i]) & acc) // IL 11731
            if ((holes & 3) != 0) return false            // IL 11737
            acc = 0
            acc |= bit                                    // IL 11741-11743
        } else {
            acc |= bit
        }
    }
    return true
```
Transcribed exactly, including the asymmetry that a full column *leading* the scan (`acc==0`) is
skipped (does not seed `acc`), while a full column after an accumulated run resets `acc` and then
re-seeds it with its own bit.

### 3.3 `lambda2_searchPc(g, m)` (11753–12034)

Bit-exact port of CPP `EvalPrePcBoard::searchPc` (cpp:623–735) but with the native MinoType codes.
Returns true iff the current board plus piece `m` forms a single-piece perfect clear.

```
bool lambda2_searchPc(g, m):
  switch (m):
    case I (0):
      if (g.stackHeight == 0)
        for (x = 0; x < 7; x++)
          if ((g.line[0] ^ (960 >> x)) == 0x3FF) return true
      else if (g.stackHeight == 3)
        for (x = 0; x < 10; x++)
          if ((g.line[3] ^ (512 >> x)) == 0x3FF) {
            t = g.line[3]
            if (g.line[2] != t || g.line[1] != t || g.line[0] != t) break
            return true
          }
    case J (1):
      if (g.stackHeight == 1) {
        for (x = 0; x < 8; x++) if ((g.line[1] ^ (896 >> x)) == 0x3FF) {
            if ((g.line[0] ^ (128 >> x)) != 0x3FF) break; return true }
        for (x = 0; x < 8; x++) if ((g.line[0] ^ (896 >> x)) == 0x3FF) {
            if ((g.line[1] ^ (512 >> x)) != 0x3FF) break; return true }
      } else if (g.stackHeight == 2)
        for (x = 0; x < 9; x++) if ((g.line[2] ^ (768 >> x)) == 0x3FF) {
            if ((g.line[1] ^ (512 >> x)) != 0x3FF) break
            if ((g.line[0] ^ (512 >> x)) != 0x3FF) break
            return true }
    case L (2):
      if (g.stackHeight == 1) {
        for (x = 0; x < 8; x++) if ((g.line[1] ^ (896 >> x)) == 0x3FF) {
            if ((g.line[0] ^ (512 >> x)) != 0x3FF) break; return true }
        for (x = 0; x < 8; x++) if ((g.line[0] ^ (896 >> x)) == 0x3FF) {
            if ((g.line[1] ^ (256 >> x)) != 0x3FF) break; return true }
      } else if (g.stackHeight == 2)
        for (x = 0; x < 9; x++) if ((g.line[2] ^ (768 >> x)) == 0x3FF) {
            if ((g.line[1] ^ (256 >> x)) != 0x3FF) break
            if ((g.line[0] ^ (256 >> x)) != 0x3FF) break
            return true }
    case O (3):
      if (g.stackHeight == 1)
        for (x = 0; x < 9; x++) if ((g.line[1] ^ (768 >> x)) == 0x3FF) {
            if ((g.line[0] ^ (768 >> x)) != 0x3FF) break; return true }
    case T (4):
      if (g.stackHeight == 1)
        for (x = 0; x < 8; x++) if ((g.line[1] ^ (896 >> x)) == 0x3FF) {
            if ((g.line[0] ^ (256 >> x)) != 0x3FF) break; return true }
    case S (5):
      if (g.stackHeight == 1)
        for (x = 0; x < 8; x++) if ((g.line[1] ^ (384 >> x)) == 0x3FF) {
            if ((g.line[0] ^ (768 >> x)) != 0x3FF) break; return true }
    case Z (6):
      if (g.stackHeight == 1)
        for (x = 0; x < 8; x++) if ((g.line[1] ^ (768 >> x)) == 0x3FF) {
            if ((g.line[0] ^ (384 >> x)) != 0x3FF) break; return true }
  return false
```
(Verified case-by-case against the binary at 11753–12034. This exactly matches the port's
`searchPc` in `evalPrePcBoard`, hoiko-eval.ts:558–659.)

### 3.4 `lambda3_pcSetup` (12037–12111) — **missing from the CPP source and the port**

```
bool lambda3_pcSetup(g):
    if (g.stackHeight > 1) return false                 // IL 12040
    if (g.lockedM != O /*3*/) return false              // IL 12044
    cI = 0; cJ = 0; cL = 0; cO = 1
    switch (g.holdM):                                   // IL 12052
        case O (3): cO = 2; break
        case L (2): cL = 1; break
        case J (1): cJ = 1; break
        case I (0): cI = 1; break
    p = g.nextArray()                                   // *(GamePack+0)
    for (i = 0; i < 4; i++) {                          // IL 12069: 4 next pieces
        switch (p[i]):
            case O (3): cO += 1; break
            case L (2): cL += 1; break
            case J (1): cJ += 1; break
            case I (0): cI += 1; break
    }
    if (cI >= 1 && cJ >= 1 && cL >= 1 && cO >= 2) {     // IL 12090
        v = g.lockedX                                   // IL 12092 (GamePack+64)
        if (v != 2 && v != 3 && v != 4)
            return g.line[0] == (768 >> (v + 1))        // IL 12096
        return false
    }
    if ((cI >= 2 && (cJ >= 2 || cL >= 2)) || (cJ >= 2 && cL >= 2)) {  // IL 12100
        v = g.lockedX
        if (v != 2 && v != 3 && v != 4)
            return g.line[0] == (768 >> (v + 1))        // IL 12106
        return false
    }
    return false
```
Confirms `GamePack+64` is the locked piece **column** (`lockedMino.x`), via §0.4.
It trades on the last lock being an O and the hold+next[0..3] inventory.

---

## 4. `SearchTsd` (binary 12113–12419)

Called from `Evaluate` as `SearchTsd(g, ch, y0 = wellDepth + garbageHeight)` (IL 11089).
`y0` is the *base row below which the well starts*. It scans three families of 3-wide
"TSD notch" shapes (cols 0-1-2; cols k+1..k+3 for k=0..5; cols 7-8-9) and returns a weighted score.
At the end it halves the score if no T is available in hold/next (IL 12388–12418).

```
int SearchTsd(g, ch, y0):
    score = 0

    // ---------- Section 1: notch at cols 0,1,2 (left edge) ----------
    lim = min(ch[0], ch[2]) + 1                    // IL 12129
    start = max(y0, ch[1] + 1)                     // IL 12132
    for (y = start; y < lim; y++) {
        off = y - y0
        if ((g.line[y] & 0x380) == 0x280) {        // cols 0,2 set; col 1 empty
            if ((g.line[y+1] & 0x380) == 0) {
                score += W[18]·TsdHole                                   // IL 12148
                if ((g.line[y+2] & 0x380) == 0x080) score += W[19]·TsdSpinable   // IL 12151
                if (y > 0 && (g.line[y-1] & 0x280) == 0x200) score += W[21]·TsdOffensive // IL 12155
                clearable = 0
                if ((g.line[y]   | 0x100) == 0x3FF) clearable = 1
                if ((g.line[y+1] | 0x380) == 0x3FF) clearable += 1
                if (clearable > 0) {
                    score += W[20]·TsdClearable * clearable                   // IL 12165
                    if (y > 0 && y != y0) {
                        m = g.line[y-1] | 0x380
                        if (m != 0x3FF) {
                            m ^= 0x3FF
                            mx = 0
                            while (m != 0) {
                                b = m & -m
                                mx = max(mx, ch[Bit.Log2(b)] - y + 1)          // IL 12178
                                m &= ~b
                            }
                            if (off < 2) mx -= 1
                            if (mx > 2) mx = 4 - mx
                            if (mx > 0) score -= W[8]·Pierce * mx             // IL 12194
                        }
                    }
                }
            }
        }
    }

    // ---------- Section 2: notch at cols 7,8,9 (right edge) ----------
    lim2 = min(ch[9], ch[7]) + 1                   // IL 12210
    start2 = max(y0, ch[8] + 1)                    // IL 12212
    for (y = start2; y < lim2; y++) {
        off = y - y0
        if ((g.line[y] & 7) == 5) {                 // cols 7,9 set; col 8 empty
            if ((g.line[y+1] & 7) == 0) {
                score += W[18]·TsdHole
                if ((g.line[y+2] & 7) == 4) score += W[19]·TsdSpinable         // IL 12229
                if (y > 0 && (g.line[y-1] & 5) == 1) score += W[21]·TsdOffensive // IL 12233
                clearable = 0
                if ((g.line[y]   | 2) == 0x3FF) clearable = 1
                if ((g.line[y+1] | 7) == 0x3FF) clearable += 1
                if (clearable > 0) {
                    score += W[20]·TsdClearable * clearable
                    if (y > 0 && y != y0) {
                        m = g.line[y-1] | 7
                        if (m != 0x3FF) {
                            m ^= 0x3FF
                            mx = 0
                            while (m != 0) {
                                b = m & -m
                                mx = max(mx, ch[Bit.Log2(b)] - y + 1)
                                m &= ~b
                            }
                            if (off < 2) mx -= 1
                            if (mx > 2) mx = 4 - mx
                            if (mx > 0) score -= W[8]·Pierce * mx
                        }
                    }
                }
            }
        }
    }

    // ---------- Section 3: notches at cols (k+1,k+2,k+3), k = 0..5 ----------
    for (k = 0; k < 6; k++) {
        left  = ch[k+1]                             // IL 12210 loop ptr7
        right = ch[k+3]                             // ptr7 + 2 ints
        mid   = ch[k+2]                             // ptr7 + 1 int
        limK   = min(left, right) + 1
        startK = max(y0, mid + 1)
        for (y = startK; y < limK; y++) {
            off = y - y0
            mA   = 320 >> k                          // cols k+1, k+3
            mABC = 448 >> k                          // cols k+1,k+2,k+3
            if ((g.line[y] & mABC) == mA) {           // mid column empty
                if ((g.line[y+1] & mABC) == 0) {
                    score += W[18]·TsdHole
                    v = g.line[y+2] & mABC
                    if (v == (256 >> k)) {
                        score += W[19]·TsdSpinable                       // IL 12319
                        if (y > 0 && (g.line[y-1] & mA) == (64 >> k))
                            score += W[21]·TsdOffensive                  // IL 12322
                    } else if (v == (64 >> k)) {
                        score += W[19]·TsdSpinable                       // IL 12327
                        if (y > 0 && (g.line[y-1] & mA) == (256 >> k))
                            score += W[21]·TsdOffensive                  // IL 12330
                    }
                    clearable = 0
                    if (((128 >> k) | g.line[y])   == 0x3FF) clearable = 1   // IL 12334
                    if ((g.line[y+1] | mABC) == 0x3FF) clearable += 1        // IL 12335
                    if (clearable > 0) {
                        score += W[20]·TsdClearable * clearable              // IL 12341
                        if (y > 0 && y != y0) {
                            m = g.line[y-1] | mABC
                            if (m != 0x3FF) {
                                m ^= 0x3FF
                                mx = 0
                                while (m != 0) {
                                    b = m & -m
                                    mx = max(mx, ch[Bit.Log2(b)] - y + 1)    // IL 12354
                                    m &= ~b
                                }
                                if (off < 2) mx -= 1
                                if (mx > 2) mx = 4 - mx
                                if (mx > 0) score -= W[8]·Pierce * mx        // IL 12370
                            }
                        }
                    }
                }
            }
        }
    }

    // ---------- T-availability gate (IL 12388–12418) ----------
    if (score != 0) {
        if (g.holdM == T) return score
        for (i = 0; i < 7; i++) if (g.next(i) == T) return score
        return score >> 1
    }
    return score
```

**Weight terms used:** `TsdHole(+72)`, `TsdSpinable(+76)`, `TsdClearable(+80)`,
`TsdOffensive(+84)`, `Pierce(+32)`. (No use of `Tsd` +156 in this function.)

---

## 5. `SearchTst` (binary 12421–12827) + lambdas

Called from `Evaluate` as `SearchTst(g, ch, y0 = wellDepth + garbageHeight, minHeight = garbageHeight)`
(IL 11090). It first delegates to `SearchDTCannon`; if that returns nonzero it returns it. Otherwise
it scans three more TST families. It uses the shared `trustNext` lambda (`lambda_d6e`, 12706) and
four small shape lambdas.

### 5.1 shared `trustNext(g)` (12706–12763) — `<lambda_d6e…>` and `<lambda_1c3a…>` (12995) are identical

```
int trustNext(g):
    if (g.holdM == T) {                       // IL 12711 (GamePack+16)
        result = 1
        for (i = 0; i < 7; i++) if (g.next(i) == T) { result = 2; break; }
        return result
    }
    i = 0
    while (g.next(i) != T) {                  // IL 12732
        i++
        if (i >= 6) return 0
    }
    if (!IsTrustNext(g, i)) return 0          // IL 12743
    result = 1
    for (j = i+1; j < i+1+6; j++) if (g.next(j) == T) { result = 2; break; }  // IL 12750
    return result
```
Returns 0 = no T available, 1 = T available (hold or trust-window next), 2 = T is also the immediate
next. `trustNext` is the binary's trust gate; the CPP/port has no equivalent.

### 5.2 Top-level

```
int SearchTst(g, ch, y0, minHeight):
    n = SearchDTCannon(g, ch, y0)
    if (n != 0) return n

    // ---------- Loop 1: idx = 0..6 (left TST family) ----------
    for (idx = 0; idx < 7; idx++) {
        row = ch[idx+2] - 2                          // IL 12436
        if (row < 0) continue
        r = g.line[row]
        if (((r >> (7 - idx)) & 7) == 5) {           // IL 12441
            if ((g.line[row+1] & (896>>idx)) == (512>>idx) &&
                (g.line[row+2] & (384>>idx)) == (128>>idx)) {           // IL 12443
                x = g.line[row+3] & (480>>idx)       // IL 12445
                if (x != 0) {
                    t = 32>>idx
                    if (x != t || (g.line[row+4] & (224>>idx)) != t) continue
                }
                n = W[22]·TstHole                                     // IL 12454
                if (lambda0dc(g, row, idx)) {                        // §5.3
                    n += W[23]·TstSpinable                           // IL 12460
                    lo = max(row-1, y0)
                    d = row - lo + 2
                    if (d <= 0) n -= (ch[idx+1] - row) * W[4]·DonateCover   // IL 12464
                    else n -= (((1 << (d-1)) + (ch[idx+1] - row - 2)*d - 1)) * W[8]·Pierce
                    if ((g.line[row+3] & (960>>idx)) == 0)
                        n -= (ch[idx] - row - 3) * W[8]·Pierce         // IL 12467
                }
                bits = 0
                c = 256>>idx
                if ((g.line[row]   | c) == 0x3FF) { n += W[24]·TstClearable; bits  = 1; }
                if ((g.line[row+1] | (384>>idx)) == 0x3FF) { n += W[24]·TstClearable; bits |= 2; }
                if ((g.line[row+2] | c) == 0x3FF) { n += W[24]·TstClearable - W[9]·Anabara; bits |= 4; }
                tr = trustNext(g)                    // IL 12487
                bits++
                if (tr > 1 && (bits - (-bits & bits)) == 0) {   // bits is a power of two
                    if (row <= 0) return n >> ((tr<=0)?1:0)
                    if ((g.line[row-1] | (128>>idx)) == 0x3FF) n += W[27]·TDHole   // IL 12500
                }
                if (row > 0 && (g.line[row-1] & (256>>idx)) == 0) n += W[26]·TstOffensive
                return n >> ((tr <= 0) ? 1 : 0)      // IL 12543
            }
        } else if (idx == 6 && row > 0                            // IL 12511
                   && (g.line[row+1] ^ 6) == 0x3FF
                   && (g.line[row-1] | 2) == 0x3FF
                   && (r & 0xE) == 8
                   && (g.line[row+2] & 6) == 2
                   && (g.line[row+3] & 7) == 0) {
            n = W[22]·TstHole
            if (lambda6695(g, row, idx)) {                        // §5.4
                n += W[23]·TstSpinable
                lo = max(row-1, y0); d = row - lo + 2
                if (d <= 0) n -= (ch[idx+1] - row) * W[4]·DonateCover
                else n -= (((1 << (d-1)) + (ch[idx+1]-row-2)*d - 1)) * W[8]·Pierce
            } else {
                n += W[7]·BadRoof * -2                            // IL 12527
            }
            tr = trustNext(g)
            if ((g.line[row] | (384>>idx)) == 0x3FF && tr > 1) n += W[24]·TstClearable
            if ((g.line[row+2] | (256>>idx)) == 0x3FF) n += W[24]·TstClearable - W[9]·Anabara
            return n >> ((tr <= 0) ? 1 : 0)
        }
    }

    // ---------- Loop 2: idx = 0..6 (right TST family) ----------
    for (idx = 0; idx < 7; idx++) {
        row = ch[idx+1] - 2                          // IL 12556
        if (row < 0) continue
        r = g.line[row]
        if (((r >> (6 - idx)) & 7) == 5) {           // IL 12561
            if ((g.line[row+1] & (448>>idx)) == (64>>idx) &&
                (g.line[row+2] & (384>>idx)) == (256>>idx)) {           // IL 12563
                x = g.line[row+3] & (1920>>idx)      // IL 12565
                if (x != 0) {
                    t = 1024>>idx
                    if (x != t || (g.line[row+4] & (1792>>idx)) != t) continue
                }
                n = W[22]·TstHole
                if (lambda_a670(g, row, idx)) {                       // §5.5
                    n += W[23]·TstSpinable
                    lo = max(row-1, y0); d = row - lo + 2
                    if (d <= 0) n -= (ch[idx+2] - row) * W[4]·DonateCover
                    else n -= (((1 << (d-1)) + (ch[idx+2]-row-2)*d - 1)) * W[8]·Pierce
                    if ((g.line[row+3] & (960>>idx)) == 0)
                        n -= (ch[idx+3] - row - 3) * W[8]·Pierce
                }
                bits = 0
                c = 128>>idx
                if ((g.line[row]   | c) == 0x3FF) { n += W[24]·TstClearable; bits  = 1; }
                if ((g.line[row+1] | (384>>idx)) == 0x3FF) { n += W[24]·TstClearable; bits |= 2; }
                if ((g.line[row+2] | c) == 0x3FF) { n += W[24]·TstClearable - W[9]·Anabara; bits |= 4; }
                tr = trustNext(g)
                bits++
                if (tr > 1 && (bits - (-bits & bits)) == 0) {
                    if (row <= 0) return n >> ((tr<=0)?1:0)
                    if ((g.line[row-1] | (256>>idx)) == 0x3FF) n += W[27]·TDHole
                }
                if (row > 0 && (g.line[row-1] & (128>>idx)) == 0) n += W[26]·TstOffensive
                return n >> ((tr <= 0) ? 1 : 0)      // IL 12663
            }
        } else if (idx == 0 && row > 0                            // IL 12631
                   && (g.line[row+1] ^ 0x180) == 0x3FF
                   && (g.line[row-1] | 0x100) == 0x3FF
                   && (r & 0x1C0) == 64
                   && (g.line[row+2] & 0x180) == 256
                   && (g.line[row+3] & 0x780) == 0) {
            n = W[22]·TstHole
            if (lambda_0efe(g, row, idx)) {                        // §5.6
                n += W[23]·TstSpinable
                lo = max(row-1, y0); d = row - lo + 2
                if (d <= 0) n -= (ch[idx+2] - row) * W[4]·DonateCover
                else n -= (((1 << (d-1)) + (ch[idx+2]-row-2)*d - 1)) * W[8]·Pierce
            } else {
                n += W[7]·BadRoof * -2
            }
            tr = trustNext(g)
            if ((g.line[row] | (384>>idx)) == 0x3FF && tr > 1) n += W[24]·TstClearable
            if ((g.line[row+2] | (128>>idx)) == 0x3FF) n += W[24]·TstClearable - W[9]·Anabara
            return n >> ((tr <= 0) ? 1 : 0)
        }
    }

    // ---------- Final: 4-row pattern anchored at minHeight (IL 12670–12703) ----------
    r2 = g.line[minHeight + 2]                       // IL 12670
    for (i = 0; i < 7; i++) {
        if (((r2 >> (6 - i)) & 0xF) == 9) {          // IL 12676
            v = g.line[minHeight + 1] & (960 >> i)   // IL 12678
            if (i < 6 && v == (704 >> i)) {
                if ((g.line[minHeight + 3] & (224 >> i)) == 0) {
                    if (minHeight >= 0 &&
                        (g.line[minHeight] & (960 >> i)) == (832 >> i))
                        return W[28]·TDHint                       // IL 12685
                    return W[25]·TstHint                          // IL 12687
                }
            } else if (i > 0 && v == (832 >> i) &&
                       (g.line[minHeight + 3] & (1792 >> i)) == 0) {
                if (minHeight >= 0 &&
                    (g.line[minHeight] & (960 >> i)) == (704 >> i))
                    return W[28]·TDHint                          // IL 12694
                return W[25]·TstHint                              // IL 12696
            }
        }
    }
    return 0
```

### 5.3 `lambda0dc` (12765–12782)

```
bool lambda0dc(g, row, idx):
    m   = 480 >> idx
    x   = g.line[row+3] & m
    if (x == 0 && (g.line[row+4] & (448>>idx)) == (256>>idx)) return true
    if (x == (32>>idx) && (g.line[row+4] & m) == (288>>idx))  return true
    return false
```

### 5.4 `lambda6695` (12784–12795)

```
bool lambda6695(g, row, idx):
    return (g.line[row+3] & (480>>idx)) == 0 &&
           (g.line[row+4] & (448>>idx)) == (256>>idx)
```

### 5.5 `lambda_a670` (12797–12814)

```
bool lambda_a670(g, row, idx):
    m = 1920 >> idx
    x = g.line[row+3] & m
    if (x == 0 && (g.line[row+4] & (896>>idx)) == (128>>idx)) return true
    if (x == (1024>>idx) && (g.line[row+4] & m) == (1152>>idx)) return true
    return false
```

### 5.6 `lambda_0efe` (12816–12827)

```
bool lambda_0efe(g, row, idx):
    return (g.line[row+3] & (1920>>idx)) == 0 &&
           (g.line[row+4] & (896>>idx)) == (128>>idx)
```

**Weight terms used:** `TstHole(+88)`, `TstSpinable(+92)`, `TstClearable(+96)`, `TstHint(+100)`,
`TstOffensive(+104)`, `TDHole(+108)`, `TDHint(+112)`, `Anabara(+36)`, `BadRoof(+28)`,
`Pierce(+32)`, `DonateCover(+16)`.

**UNDETERMINED (mask width):** `lambda_a670` uses `1920`/`1152`/`1024` (bits reach 10), but
`Board.line` only ever has bits 0–9 set (see `Board.GetColumnHeight`, 21122). For `idx==0`
`(x == 1024)` is therefore unreachable; the masks are transcribed verbatim (IL 12801, 12805,
12809). Implementers may mask with `0x3FF` with identical results.

---

## 6. `SearchDTCannon` (binary 12829–13078) + lambdas

Called only from `SearchTst`. Detects the two mirror-image "DT cannon" shapes and returns a weighted
score. If neither shape matches it returns 0.

```
int SearchDTCannon(g, ch, y0):
    trust = shared trustNext(g)                       // lambda_1c3a (12995), identical to §5.1

    // ---------- Pattern A (left, cols 5..9) ----------
    b = ch[8] - 4                                     // IL 12835
    if (b >= 0
        && (g.line[b]   | 4) == 0x3FF
        && (g.line[b+1] | 4) == 0x3FF
        && (g.line[b+2] & 0x1F) == 17
        && (g.line[b+3] & 0xF) == 9
        && (g.line[b+4] & 7) == 3) {
        if ((g.line[b+5] & 7) != 0) return 0
        n = W[22]·TstHole                                          // IL 12840
        if (lambda23b(g, b, 5)) {                                  // §6.1
            n += W[23]·TstSpinable                                 // IL 12847
            lo = max(b-1, y0)
            d = b - lo + 4
            if (d <= 2) n -= (ch[7] - (b+2)*2 + ch[6]) * W[4]·DonateCover   // IL 12853
            if (d > 0) {
                dd = min(3, d)
                dd = (1 << (dd-1)) + (ch[7] - b - 4) * dd - 1
                n -= W[8]·Pierce * dd                              // IL 12860
            }
            if ((g.line[b+3] & 0xF) == 0)
                n -= (ch[6] - b - 3) * W[8]·Pierce                 // IL 12864
        }
        t = trust()
        if (b > 0) {
            r = g.line[b-1]
            if ((r | 2) == 0x3FF && t > 1) n += W[27]·TDHole       // IL 12873
            if ((r & 4) == 0) n += W[26]·TstOffensive              // IL 12877
        }
        if ((g.line[b]   | 4)   == 0x3FF && t > 1) n += W[24]·TstClearable
        if ((g.line[b+1] | 4)   == 0x3FF)          n += W[24]·TstClearable
        if ((g.line[b+2] | 0xE) == 0x3FF)          n += W[24]·TstClearable
        if ((g.line[b+3] | 6)   == 0x3FF) { if (t>1) n += W[24]·TstClearable; n -= W[9]·Anabara }
        if ((g.line[b+4] | 4)   == 0x3FF) { if (t>1) n += W[24]·TstClearable; n -= W[9]·Anabara }
        return n >> ((t <= 0) ? 1 : 0)                             // IL 12909
    }

    // ---------- Pattern B (right, cols 0..4) ----------
    b = ch[1] - 4                                     // IL 12914
    if (b >= 0
        && (g.line[b]   | 0x80)  == 0x3FF
        && (g.line[b+1] | 0x80)  == 0x3FF
        && (g.line[b+2] & 0x3E0) == 544
        && (g.line[b+3] & 0x3C0) == 576
        && (g.line[b+4] & 0x380) == 768) {
        if ((g.line[b+5] & 0x780) != 0) return 0
        n = W[22]·TstHole                                          // IL 12919
        if (lambda_e8ff(g, b, 0)) {                                // §6.2
            n += W[23]·TstSpinable
            lo = max(b-1, y0)
            d = b - lo + 4
            if (d <= 2) n -= (ch[3] - (b+2)*2 + ch[2]) * W[4]·DonateCover   // IL 12932
            if (d > 0) {
                dd = min(3, d)
                dd = (1 << (dd-1)) + (ch[3] - b - 4) * dd - 1
                n -= W[8]·Pierce * dd
            }
            if ((g.line[b+3] & 0x3C0) == 0)
                n -= (ch[3] - b - 3) * W[8]·Pierce
        }
        t = trust()
        if (b > 0) {
            r = g.line[b-1]
            if ((r | 0x100) == 0x3FF && t > 1) n += W[27]·TDHole   // IL 12952
            if ((r & 0x80) == 0) n += W[26]·TstOffensive            // IL 12956
        }
        if ((g.line[b]   | 0x80)  == 0x3FF && t > 1) n += W[24]·TstClearable
        if ((g.line[b+1] | 0x80)  == 0x3FF)          n += W[24]·TstClearable
        if ((g.line[b+2] | 0x1C0) == 0x3FF)          n += W[24]·TstClearable
        if ((g.line[b+3] | 0x180) == 0x3FF) { if (t>1) n += W[24]·TstClearable; n -= W[9]·Anabara }
        if ((g.line[b+4] | 0x80)  == 0x3FF) { if (t>1) n += W[24]·TstClearable; n -= W[9]·Anabara }
        return n >> ((t <= 0) ? 1 : 0)                             // IL 12987
    }
    return 0
```

### 6.1 `lambda23b` (13054–13065) — Pattern A shape check, `idx = 5`

```
bool lambda23b(g, base, idx):     // idx is the 5 passed by Pattern A
    return (g.line[base+5] & (240 >> idx)) == 0 &&
           (g.line[base+6] & (224 >> idx)) == (128 >> idx)
```

### 6.2 `lambda_e8ff` (13067–13078) — Pattern B shape check, `idx = 0`

```
bool lambda_e8ff(g, base, idx):   // idx is the 0 passed by Pattern B
    return (g.line[base+5] & (1920 >> idx)) == 0 &&
           (g.line[base+6] & (896 >> idx))  == (128 >> idx)
```

**Weight terms used:** `TstHole(+88)`, `TstSpinable(+92)`, `TstClearable(+96)`,
`TstOffensive(+104)`, `TDHole(+108)`, `Anabara(+36)`, `Pierce(+32)`, `DonateCover(+16)`.

---

## 7. Binary `Evaluate` / `EvaluateFirst` shapes (for wiring the searches correctly)

### 7.1 `EvaluateAI.Evaluate` (11066–11096)

```
Evaluate(g, int* score, int* familyScore):
    ch = [-1]*10
    minHeight = GetColumnHeight(g.board, ch)
    board = 0
    board += GetHeight(g, ch)
    board += GetWellColumn(g, ch, minHeight, &wellColumn, &wellDepth)
    board += GetUpDown(g, ch, wellColumn, wellDepth)
    board += GetUnderground(g, ch, minHeight)
    board += GetGround(g, ch, wellDepth + minHeight)
    board += GetResource(g, ch, minHeight)
    board += SearchTsd(g, ch, wellDepth + minHeight)
    board += SearchTst(g, ch, wellDepth + minHeight, minHeight)
    board += SearchPcBoard(g, minHeight)
    board += GetContBonus(g)
    action = GetFinalAction(g)
    *familyScore = trunc( (trunc(nexus * board) + action) * trustRate )
    *score       = trunc( (action + board) * trustRate )
```
**No `parentPcScore` subtraction and no `EvalPrePcBoard` term.** Accumulation onto the parent is done
by the caller (`SearchAI.MultiEvaluator.Evaluate`, 15487–15491):
`node.score += parent.familyScore; node.familyScore += parent.familyScore;`.

### 7.2 `EvaluateAI.EvaluateFirst` (11098–11118)

```
EvaluateFirst(g, int* familyScore):
    ch = [-1]*10
    minHeight = GetColumnHeight(g.board, ch)
    board = GetHeight(g, ch)
    board += SearchPcBoard(g, minHeight)
    board += GetContBonus(g)
    *familyScore = GetFinalAction(g) + trunc(board * nexus)
```
Only three board terms. **No trustRate factor.** Called on the first-level nodes only
(`SearchAI.Search`, 15665); deeper nodes use `Evaluate`.

---

## 8. Port verification (`/home/s0u7a/browser-tetris/src/ai/hoiko-eval.ts` etc.)

Legend: ✅ = behaviourally equivalent, ❌ = divergence to fix, ⚠️ = divergent but inert under the
shipped config.

| # | Port symbol (file:line) | Binary (IL) | Verdict |
|---|---|---|---|
| 1 | `evalHeight` (eval:162–179) | `GetHeight` 11120 | ✅ term-for-term identical |
| 2 | `evalWellColumn` (eval:182–214) | `GetWellColumn` 11150 | ✅ identical (well lambda, WellHint/WellDepth/WellPeak, column weight) |
| 3 | `evalUpDown` (eval:217–241) | `GetUpDown` 11227 | ✅ identical |
| 4 | `evalUnderground` (eval:244–283) | `GetUnderground` 11348 | ✅ identical |
| 5 | `evalResource` main body (eval:286–325) | `GetResource` 11422–11488 | ✅ anabara/resource/well·0.5/return terms identical |
| 6 | `s4w` (eval:328–425) | `GetResource.<lambda>` 11490–11616 | ⚠️ **different implementation.** Binary only recognises `line[y] == 0x3F` / `0x3F0`, returns only a comboTable bonus, no `h*h*UpDown2`, no `*2`, no 0x387 pattern. Port implements the CPP's richer 0x387 variant. `useS4W=false` ⇒ both evaluate to `+0`. |
| 7 | `evalContBonus` (eval:428–434) | `GetContBonus` 13080 | ✅ identical (`I→HoldI`, `T→HoldT`, `btb>0→Btb`) |
| 8 | `evalFinalAction` (eval:437–546) | `GetFinalAction` 13099–13244 | ❌ **Pc case.** Binary `case 9` returns immediately (IL 13160) after `Pc - (moveDelay>>5)*MoveDelay` plus `(btb==0 ? WasteT/WasteI : ComboBtb)`. The port (eval:479–482) `break`s out and then also adds `ComboDebt` (eval:491), the combo table (skipped for Pc), and the weightIndex≥2 attack table (eval:521–544) — all of which the binary skips for Pc. |
| 9 | `evalPrePcBoard` (eval:549–667) | `SearchPcBoard` minHeight==-1 branch 11633–11648 | ❌ **missing `lambda3_pcSetup`** (§3.4, IL 12037) and missing the structural placement: binary folds `SearchPcBoard(minHeight)` into `boardScore`, whereas the port treats it as a separate `pcScore` subtracted/added (see #11). `searchPc` itself (eval:558–659) is ✅ identical to `lambda2`. |
| 10 | (no port symbol) `evalGround` | `GetGround` 11273 | ❌ **not implemented** — `evaluateNodeFull` has a `// EvalGround = 0` comment (eval:743). Must add. |
| 11 | `evaluateNodeFull` (eval:716–778) | `Evaluate` 11066 | ❌ structural: the binary has **no** `parentPcScore` subtraction (eval:764) and **no** `EvalPrePcBoard` term (eval:765); it instead adds `GetGround`/`SearchTsd`/`SearchTst`/`SearchPcBoard` into `boardScore`. Port omits those four and adds pcScore logic. |
| 12 | (no port symbol) `evaluateFirst` | `EvaluateFirst` 11098 | ❌ **not implemented.** Port evaluates the first ply with `evaluateNodeFull` (`hoiko-search.ts:298`, called with `ply===0`), including trustRate; binary uses the lean `EvaluateFirst` (GetHeight+SearchPcBoard+GetContBonus, no trustRate) for first-level nodes. |
| 13 | `transitionWeight` (eval:674–695) | `TransitionWeight` 13533–13652 | ✅ for the shipped config (`multiEvaluation=false`, `playStyle=0`); ⚠️ binary's `multiEvaluation && opponentsCombo>8` branches (13598–13606, 13644–13647) are omitted. Inert. |
| 14 | `getColumnHeight` (eval:135–152) | `Board.GetColumnHeight` 21122 | ✅ identical |
| 15 | `popcount`/`log2` (eval:103–113) | `Bit.PopCount` 20607 / `Bit.Log2` 20612 | ✅ `log2(b)=9-popcount(b-1)` |
| 16 | `isEvenPop` (eval:155–159) | `EvenOrOdd` 13654 | ✅ |
| 17 | `W` map (eval:19–67) | `EvalWeight` offsets | ✅ every index matches byte `idx*4` |
| 18 | `parseHoikoWeights` (weights:45–109) | `EvalWeight.ReadWeight` 10671 | ✅ positional parse, Column/ComboAtk/Nexus special cases, zero-on-mismatch all match |
| 19 | `evalResource` S4W gate (eval:321) | `useS4W` (11480) | ✅ gated identically (but see #6) |

### 8.1 Divergences that change play (must fix for a faithful replica)

1. **Add `GetGround`** (§2) to the board score. It runs for every node regardless of config.
2. **Add `SearchTsd`** (§4) and **`SearchTst`** (§5, which also invokes `SearchDTCannon` §6).
3. **Add `lambda3_pcSetup`** to the PcChance branch (§3.4), OR restructure the PcChance handling to
   match `SearchPcBoard` exactly.
4. **Restructure `Evaluate`** to the binary shape (§7.1): board includes
   `GetGround + SearchTsd + SearchTst + SearchPcBoard(minHeight)`; drop the `parentPcScore`
   subtraction and the separate `EvalPrePcBoard` term. Parent accumulation stays in the search
   caller.
5. **Add `EvaluateFirst`** (§7.2) and use it for first-level (ply-1) nodes, without trustRate.
6. **Fix the `Pc` case in `evalFinalAction`** to return immediately (§8 #8).

### 8.2 Divergences that are inert under the shipped config

* `s4w` body (#6) — `useS4W=false`.
* `transitionWeight` multiEvaluation branches (#13) — `multiEvaluation=false`.
* `lambda1_pcStack` (#9/#8) — `usePCstack=false` (but *not* the `minHeight==-1` PcChance branch,
  which still runs).

---

## 9. Undetermined / caveats (explicit)

1. **`lambda_a670` mask width** — IL 12801/12805/12809 use `1920`, `1152`, `1024` (bit 10 set).
   `Board.line` is 10-bit (Board.GetColumnHeight 21122–21179), so bit 10 is always 0 and
   `(x == 1024>>idx)` for `idx==0` is unreachable. Transcribed verbatim; masking to `0x3FF` is
   behaviour-preserving. This is an IL-level literal, not a guess.
2. **Semantic labels of `GetGround` accumulators** — IL uses `num/num2/num3/num4`; the mapping to
   `Roof/BadRoof/Pierce` is inferred from the return offsets `+24/+28/+32` (11345) and the W enum.
   The *arithmetic* is exact; only the human label is inferred.
3. **`SearchTsd` y0 meaning** — the IL names it only as the 3rd arg; the call site (11089)
   establishes `y0 = wellDepth + garbageHeight`. The internal use of `y - y0` as "distance from the
   well floor" and `y != y0` as "first row above the floor" is derived from that call site.
4. **`lambda23b` / `lambda_e8ff` idx values** — Pattern A passes the literal `5` (IL 12834/12844),
   Pattern B passes the literal `0` (IL 12913/12923). Recorded; not a guess.
5. **`SearchTst` final loop shift direction** — IL iterates `i=0..6` with `(r2 >> (6-i)) & 0xF`
   (IL 12673/12676), i.e. a 4-bit window that walks from the high bits down. Transcribed exactly.
6. **`GetFinalAction` non-Pc path** — verified identical to the CPP/port except for the Pc early
   return; the in-function `num5 = g.btb` reuse for both the btb branches and the combo table is
   transcribed at IL 13162–13242 and matches the port outside the Pc case.
7. **`TemplateAI`** — with `useTDOpeners=false`, `SearchAI.Search` skips `OpSearch`/`TemplateAI`
   (IL 15639) and uses the plain `ExpandNode` + `EvaluateFirst`/`Evaluate` path. `OpEvaluateFirst`
   (16558) merely wraps `EvaluateFirst`. No TemplateAI reconstruction is needed for this config.

---

## 10. Implementation checklist (TS)

1. Extend `SourceBoard`/node context with `holdM`, `fallingM`, `lockedM`, `lockedX`, `next[]`
   (native MinoType codes) so `SearchPcBoard`/`SearchTsd`/`SearchTst`/`SearchDTCannon` can run.
2. Transcribe §2 (`evalGround`), §3.4 (`pcSetup`), §4 (`searchTsd`), §5 (`searchTst` + 5 lambdas),
   §6 (`searchDTCannon` + 2 lambdas) verbatim; use `popcount`/`log2` and mask constants from §1.1.
3. Implement the shared `trustNext` (§5.1) and `IsTrustNext` (pointer-window → `index <= trustEndIndex`).
4. Rewrite `evaluateNodeFull` into binary `Evaluate` shape (§7.1) and add `evaluateFirst` (§7.2).
5. Remove the `parentPcScore`/`EvalPrePcBoard` plumbing; let `hoiko-search.ts` add
   `parent.familyScore` to both child scores (already does at hoiko-search.ts:317–318).
6. Fix `evalFinalAction` Pc early return.
7. Keep the existing correct functions (#1–#4, #13–#19) unchanged.
8. Golden-test: hand-built boards for each new search (TSD notch → `TsdHole`; TST/DTCannon shapes;
   PC-chance O-lock inventory) and full-board eval deltas vs a reference implementation of this spec.

*End of spec.*
