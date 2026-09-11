# SPEC — Native Hoiko `ExpandAI` child-generation algorithm

Source of truth: decompiled `Hoiko.exe` at `/tmp/opencode/re/Hoiko.all.cs` (IL line numbers cited per
method). Cross-checked against the (older/simplified) C++ at `/home/s0u7a/hoiko-src/TetrizAI_Expand.*`,
`TetrizAI_Common.*`, `Tetriz_Common.*`, `Tetriz_Constant.*`.

Everything below uses **native field names** after decoding raw pointer arithmetic. A raw→named decode
table is in §2. The exact TS translation (bit order, coordinate convention) is in §10.

---

## 0. READ THIS FIRST — the "ExpandTemplateNode is inert" premise is WRONG

The task brief (and `NOTES.md`) state that because `config.dll` has `useTDOpeners=false`,
`ExpandTemplateNode` is inert and `ExpandNode == ExpandBaseNode + ExpandDeriveNode + RegistChildNode`.

**The binary does not support that.** Evidence:

1. `ExpandAI.ExpandNode` (IL 14238) unconditionally selects the expander by board state, **not** by config:
   ```c
   childCount = (!GamePack.IsSafe(parentGame)) ? ExpandBaseNode(babyNode,1,board)
                                               : ExpandTemplateNode(babyNode,1);
   ```
   `GamePack.IsSafe` (IL 6956) = `board.stackHeight < fallingMino.p.y - 3`. At spawn `p.y == 20`, so on any
   board with `stackHeight < 17` (i.e. every normal opening / low stack) **ExpandTemplateNode is the
   expander that runs**, and ExpandBaseNode/ExpandDeriveNode never see those states at the root.

2. `ExpandTemplateNode` (IL 14872) contains **no** check of `ConfigAI.UseTDOpeners()` or
   `TemplateAI.useTemplate`. It reads three `const` static tables directly.

3. The three tables are non-empty compile-time constant data (IL 690, 692, 698):
   `childI` = 33 entries, `childSZTJL` = 33 entries, `childO` = 8 entries. They are decoded in §7.

4. `TemplateAI.ReadConfig` (IL 16524) sets `useTemplate=false` when `useTDOpeners=false`; that flag only
   gates `SearchAI.OpSearch` (IL 15644), **not** `ExpandTemplateNode`.

**Consequence for the TS port:** implementing only `ExpandBaseNode/ExpandDeriveNode/RegistChildNode`
reproduces the engine **only when `!IsSafe` (stackHeight ≥ 17)**. To be faithful on low stacks you must
also implement `ExpandTemplateNode` with the tables in §7. Both paths are fully specified here.
This is the single most important uncertainty to resolve in the port — see §8.

---

## 1. Memory layouts (verified from usage)

### GamePack (`parentGame`) — IL 14227–14255, 6956, 6928
| off | type | field |
|----:|------|-------|
| +0  | NextIterator (16) | `nextIt` (binary uses the **pointer** variant: `+0` = `const MinoType* m`, `+8` = `const MinoType* trustEnd`) |
| +16 | HoldMino (12) | `hold`: `m`@+16, `swappedHold`@+20, `abnormalHold`@+24 |
| +28 | pad 4 | |
| +32 | FallMino (32) | `fallingMino`: `p.x`@+32, `p.y`@+36, `r`@+40, `m`@+44, `lastSrs`@+48, `bugGravity`@+52, `shape*`@+56 |
| +64 | FallMino (32) | `lockedMino` |
| +96 | Board (136) | `line[32]`@+96..+223, `stackHeight`@+224, `lockedBottom`@+228 |
| +232| Command (56) | `commands`: `s[48]`@+232..+279, `moveDelay`@+280, `len`@+284 |
| +288| Others (12) | `combo`@+288, `btb`@+292, `act`@+296 |
| size| 300 | |

### BabyNode (120 bytes; `ExpandAI.BabyNode`, IL 14071+) — matches C++ `ExpandAI::BabyNode`
| off | type | field |
|----:|------|-------|
| +0  | FallMino (32) | `fallingMino` (`x`@+0, `y`@+4, `r`@+8, `m`@+12, `lastSrs`@+16, `bugGravity`@+20, `shape*`@+24) |
| +32 | Command (56) | `commands` (`s[48]`@+32..+79, **`moveDelay`@+80**, `len`@+84) |
| +88 | HoldMino (12) | `hold` (`m`@+88, `swappedHold`@+92, `abnormalHold`@+96) |
| +100| pad 4 | |
| +104| NextIterator (16) | `nextIt` (`m`@+104, `trustEnd`@+112) |
| size| 120 | |

> `baby+80` (= `commands.moveDelay`) is the **dedup tie-break key** ("delay"). §6.

### Node (328 bytes) — IL 14309, 14395–14405, 14258
`Node` embeds `GameState` with the **same layout as GamePack's first 300 bytes** (proven by
`RegistChildNode` copying parentGame+96 → child+96, +288/+292 → child+288/+292, etc.).
Additional fields (inferred; only the ones Expand uses are load-bearing):
| off | field | used by |
|----:|-------|---------|
| +0..+299 | GameState (as GamePack) | |
| +300 | `childCount` | SearchAI |
| +304 | `score` | SearchAI |
| +308 | `familyScore` | SearchAI |
| +312 | `pcScore` | SearchAI |
| +316 | `parentIndex` | |
| +320 | `Node* parentNode` | |
| size | 328 | stride used everywhere |

**Fields Expand reads/writes on a Node:** `+72 = lockedMino.r`, `+228 = board.lockedBottom`,
`+280 = commands.moveDelay`, `+288 = combo`, `+292 = btb`, `+296 = act`.

### Board (136) — IL 20587+ (C++ `Tetriz_Common.h`)
`line[32]` bottom-up (`line[0]` = bottom row), `stackHeight` = highest non-empty row (or −1),
`lockedBottom` = `Bottom()` of last locked mino.
**Bit mapping: column `c` occupies bit `9-c`.** Hence `512 >> c` is exactly column `c`'s bit, and
`0x3FF == 1023` is a full row. (Verified by `Board.GetColumnHeight`, IL 21122: it reads
`columnHeight[0]` from `(num>>9)&1` … `columnHeight[9]` from `num&1`.)

### Command (56) — IL 6687+ (C++ `TetrizAI_Common.h`)
`s[48]`, `moveDelay`@+48 (relative; BabyNode+80 / Node+280), `len`@+52.
ASCII opcodes: `'l'` left, `'r'` right, `'a'` RotateA(CW), `'b'` RotateB(CCW), `'u'` hard drop,
`'d'` soft drop (followed by `'A'+y`), `'g'` bug-gravity drop, `'h'` swap-hold (non-empty),
`'f'` first-hold (empty). Delay costs: move 30, rotate 16, soft-drop-per-row 33, hard-drop 112
(binary; C++ newer src says 116), hold 16.

---

## 2. Raw pointer → named field decode table

| Raw expression (decompiler) | Meaning |
|---|---|
| `*(int*)((nint)targetBaby + 0)` | `baby.fallingMino.p.x` |
| `*(int*)((nint)targetBaby + 4)` | `baby.fallingMino.p.y` |
| `*(int*)((nint)targetBaby + 8)` | `baby.fallingMino.r` |
| `*(int*)((nint)targetBaby + 12)` | `baby.fallingMino.m` (MinoType: I=0,J=1,L=2,O=3,T=4,S=5,Z=6,None=7) |
| `*(int*)((nint)targetBaby + 16)` | `baby.fallingMino.lastSrs` (0 none, 1 no-kick, 2..5 = kick test[0..3]) |
| `*(int*)((nint)targetBaby + 20)` | `baby.fallingMino.bugGravity` |
| `*(int*)((nint)targetBaby + 80)` | `baby.commands.moveDelay` |
| `*(int*)((nint)targetBaby + 92)` | `baby.hold.swappedHold` |
| `*(int*)((nint)parentGame + 44)` | `parentGame.fallingMino.m` |
| `*(int*)((nint)parentGame + 16)` | `parentGame.hold.m` |
| `*(int*)((long)(baby.y - 2)*4 + board)` | `board.line[baby.y - 2]` |
| `*(int*)((long)(baby.y - 3)*4 + board)` | `board.line[baby.y - 3]` (Collision board) |
| `*(int*)((nint)board + 128/224)` | `board.stackHeight` (Board is at GamePack+96; 96+128=224) |
| `*(int*)((nint)board + 132/228)` | `board.lockedBottom` |
| `*(int*)((nint)childNode + 72)` | `child.lockedMino.r` |
| `*(int*)((nint)childNode + 228)` | `child.board.lockedBottom` |
| `*(int*)((nint)childNode + 280)` | `child.commands.moveDelay` |
| `*(int*)((nint)childNode + 296)` | `child.others.act` |
| `(512 >> baby.x)` | column `baby.x` bit → `colBit(baby.x)` |
| `(512 >> baby.x + 1)` | column `baby.x + 1` bit (C#: `512 >> (x+1)`) |
| `(512 >> baby.x + 2)` | column `baby.x + 2` bit |
| `((512 >> x+1) \| board.line[y-2]) == 1023` | row `y-2` is full **except at most column `x+1`** |
| `(board.line[y-2] & (512 >> x)) > 0` | cell (column `x`, row `y-2`) is occupied |
| `(board.line[y-2] & (512 >> (x+2))) > 0` | cell (column `x+2`, row `y-2`) is occupied |
| `0x3FF` / `1023` | all 10 columns set (full row) |

Orientation: `ColumnIndex c` is the **world column** (`0..9`, left→right); native bit = `9-c`.
`board.line[y]` is row `y` counted from the bottom (row 0 = floor).

---

## 3. Constants and their provenance

| Constant | Value | Where |
|---|---|---|
| `BabyNode` stride | **120** bytes | IL 14624/14631/14747…, `type_ExpandAI.cs` `Size=120` |
| `Node` stride | **328** bytes | IL 14309, 14338, 14258 |
| `MAX_CHILDREN` | **100** | IL 14260/14265; static data `64 00 00 00` (IL 704) |
| `MAX_BABYS` | **300** | `babyNode` alloc = 36000 bytes = 300·120 (IL 14184); C++ `MAX_BABYS=300` |
| `expandedBaby` size | **8064** = 48·168 → 48 buckets | IL 14185; `ExpandedBaby.BabyVec` size 168 |
| `expandedChild` size | **6720** = 40·168 → 40 buckets | IL 14186; `ClearChild` loops 20×2 (IL 14171) |
| base-prune threshold | **childCount > 34** | IL 14681 (literal 34) |
| prune marker | **1000000** (excluded), filter keeps `< 10000` | IL 14133/14139, partition IL 15264 |
| `columnHeight` init | **−1** ×10 | IL 14217–14226 |
| `useHold` | from config (`ConfigAI.UseHold()`) | IL 14191; binary `UseHold()` always `true` (C++ line 831) |

> The task brief asked about `0x380` / `0x280` masks: **they do not appear anywhere in ExpandAI.**
> They occur only in `EvaluateAI.SearchTsd/SearchTst` (IL 12143–12169). Do not put them in the port.

---

## 4. Per-method pseudocode

Notation: `baby` is a pointer into the global `babyNode[300]` array of `BabyNode`.
`babyNode + k` means the k-th 120-byte slot. `AddBaby(v)` appends `v` to `expandedBaby` (§5.1).
`dup(b)` = `OverrideSameNode(b) == 1`. All commands are `Command.*` (§9.1).

### 4.1 `ExpandNode(parentGame, childNode, *totalChildCount)` — IL 14207
```
void ExpandNode(GamePack* g, Node* childNode, int* totalChildCount):
    int columnHeight[10] = {-1,-1,-1,-1,-1,-1,-1,-1,-1,-1}
    Board.GetColumnHeight(board=g.board, columnHeight)

    ExpandedBaby.ClearBaby(expandedBaby)

    // root baby = copy of g's state
    babyNode[0].fallingMino = g.fallingMino            // copy 32B @+32
    babyNode[0].hold        = g.hold                   // copy 12B @+16
    babyNode[0].nextIt      = g.nextIt                 // copy 16B @+0
    Command.Init(babyNode[0].commands)
    AddBaby(babyNode[0])

    int count = !GamePack.IsSafe(g)
              ? ExpandBaseNode(babyNode /*base*/, 1, g.board)
              : ExpandTemplateNode(babyNode, 1)
    count = ExpandDeriveNode(babyNode, count, g.board, columnHeight)
    count = RegistChildNode(babyNode, count, g, childNode)   // -> childNode[0..count)

    if (g.fallingMino.m != g.hold.m && useHold)              // IL 14241
        int prev = count
        ExpandedBaby.ClearBaby(expandedBaby)
        babyNode[0].fallingMino = g.fallingMino
        babyNode[0].hold        = g.hold
        babyNode[0].nextIt      = g.nextIt
        Command.Init(babyNode[0].commands)
        Command.SwapHold(babyNode[0].commands, &babyNode[0].fallingMino,
                         &babyNode[0].hold, g.board, &babyNode[0].nextIt)
        // NOTE: binary ignores SwapHold's return value (C++ returns early on 0)
        AddBaby(babyNode[0])
        count = !GamePack.IsSafe(g)
              ? ExpandBaseNode(babyNode, 1, g.board)
              : ExpandTemplateNode(babyNode, 1)
        count = ExpandDeriveNode(babyNode, count, g.board, columnHeight)
        count = RegistChildNode(babyNode, count, g, childNode + prev*328)  // -> childNode[prev..)
        *totalChildCount = min(prev + count, MAX_CHILDREN)   // IL 14260
    else
        *totalChildCount = min(count, MAX_CHILDREN)          // IL 14265
```
`GamePack.IsSafe(g) = g.board.stackHeight < g.fallingMino.p.y - 3` (IL 6956).

### 4.2 `ExpandBaseNode(babyNode, childCount=1, board)` — IL 14595
Iterative BFS. `num`/`num2` delimit the previous frontier; each frontier state is expanded with
**MoveLeft, MoveRight, RotateB, RotateA, in that order**.
```
int ExpandBaseNode(BabyNode* babyNode, int childCount, Board* board):
    int num = 0, num2 = 1
    while true:
        if num < num2:
            for i in [num, num2):                       // previous-round frontier
                for cmd in [MoveLeft, MoveRight, RotateB, RotateA]:
                    copy babyNode[childCount] = babyNode[i]   // 120B scratch slot
                    BabyNode* cand = &babyNode[childCount]
                    if cmd(&cand.commands, &cand.fallingMino, board) == 1
                       && OverrideSameNode(cand) == 0:
                        AddBaby(cand)
                        childCount++
        if num2 == childCount: break
        num = num2; num2 = childCount

    if childCount > 34:                                  // IL 14681
        int kept = ExpandedBaby.GetFilteredCount(expandedBaby, childCount)
        std::partition(babyNode[0..childCount), by (+80 < 10000))  // keep <10000 first
        childCount = kept
        ExpandedBaby.ClearBaby(expandedBaby)
        for i in [0, kept): AddBaby(&babyNode[i])
    return childCount
```
Per frontier state the 4 candidates are generated **in order L,R,B,A**; each is only kept if the
command succeeded **and** `OverrideSameNode` reported "new". Because the scratch slot is always
`babyNode[childCount]`, a failed candidate is simply overwritten by the next command.

> Note: `ExpandBaseNode` does **not** soft-drop; `y` stays at spawn (20) except for `bugGravity`
> sinking (Command.MoveLeft/Right/RotateA/B, IL 6779/6801/6827/6853) and SRS kick `dy`.
> The hard drop happens later in `RegistChildNode` via `GamePack.LockDown`.

### 4.3 `ExpandDeriveNode(babyNode, childCount, board, columnHeight)` — IL 14706
```
int ExpandDeriveNode(BabyNode* babyNode, int childCount, Board* board, int* columnHeight):
    if (!deriveGuard(babyNode, columnHeight, board)):    // IL 14832 lambda
        return childCount
    int num = 0, num2 = childCount
    BabyNode local
    while true:
        if num >= childCount: break
        for i in [num, childCount):
            local = babyNode[i]                            // copy
            Command.SoftDrop(&local.commands, &local.fallingMino, board)  // drop to floor
            // ---- MoveL ----
            slot = childCount; copy babyNode[slot] = local
            if TryDeriveMoveL(&babyNode[slot], board, columnHeight) == 1:
                AddBaby(&babyNode[slot]); childCount++; last = childCount-1
                if babyNode[last].m == 4 && babyNode[last].r == 2:   // T, rot 2
                    copy babyNode[childCount] = babyNode[last]
                    if TryDeriveFinB(&babyNode[childCount], board, columnHeight) == 1:
                        AddBaby(&babyNode[childCount]); childCount++
            // ---- MoveR (FinA) ----
            slot = childCount; copy babyNode[slot] = local
            if TryDeriveMoveR(...) == 1:
                AddBaby; childCount++
                if babyNode[childCount-1].m == 4 && .r == 2:
                    copy babyNode[childCount] = babyNode[childCount-1]
                    if TryDeriveFinA(...) == 1: AddBaby; childCount++
            // ---- RotateB ----
            slot = childCount; copy babyNode[slot] = local
            if TryDeriveRotateB(...) == 1: AddBaby; childCount++
            // ---- RotateA ----
            slot = childCount; copy babyNode[slot] = local
            if TryDeriveRotateA(...) == 1: AddBaby; childCount++
        if num2 == childCount: break
        num = num2; num2 = childCount
    return childCount
```
`deriveGuard(babyNode, columnHeight, board)` (IL 14832):
```
bool deriveGuard(BabyNode* b, int* columnHeight, Board* board):
    if b.fallingMino.m == 4: return true                // T piece: always derive
    int minH = min(columnHeight[0..9])
    int acc = board.line[max(board.stackHeight, 0)]
    for (int y = board.stackHeight - 1; y > minH; --y):
        int row = board.line[y]
        if (((row ^ 0x3FF) & acc) != 0) return true      // acc ⊄ row -> overhang/hole
        acc |= row
    return false
```

### 4.4 `TryDeriveRotateB(targetBaby, board, columnHeight)` — IL 14443
```
if Command.RotateB(&b.commands, &b.fallingMino, board) == 0: return 0
if GetAboveCell(columnHeight, &b.fallingMino) == 0
   && (b.m != 4 || b.lastSrs != 2 || b.r != 3
       || ((512 >> (b.x+1)) | board.line[b.y-2]) != 1023):
       return 0
return OverrideSameNode(b) != 1 ? 1 : 0
```
### 4.5 `TryDeriveRotateA(targetBaby, board, columnHeight)` — IL 14457
Identical to 4.4 except `Command.RotateA` and `b.r != 1` in the T special-case.

### 4.6 `TryDeriveMoveL(targetBaby, board, columnHeight)` — IL 14471
```
if Command.MoveLeft(...) == 0: return 0
if GetAboveCell(...) == 0: return 0
int n = 0
while Command.MoveLeft(...) != 0:
    if GetAboveCell(...) != 0:
        n++; if n >= 10: break
        continue
    return 0                      // slid out of the stack -> reject
return OverrideSameNode(b) != 1 ? 1 : 0
```
### 4.7 `TryDeriveMoveR` — IL 14500 — mirror of 4.6 with `MoveRight`.

### 4.8 `TryDeriveFinB(targetBaby, board, columnHeight)` — IL 14529
```
if (board.line[b.y-2] & (512 >> b.x)) > 0:        // cell (b.x , b.y-2) occupied
    if Command.MoveRight(...) == 0: return 0
    b.commands.moveDelay -= 30                     // cancel the move cost
if Command.RotateB(...) == 0: return 0
if b.lastSrs == 5
   && ((512 >> (b.x+1)) | board.line[b.y-2]) == 1023:
    return OverrideSameNode(b) != 1 ? 1 : 0
return 0
```
### 4.9 `TryDeriveFinA` — IL 14552 — mirror: pre-check `board.line[b.y-2] & (512 >> (b.x+2))`,
then `MoveLeft`, then `RotateA`, same `lastSrs==5` final test.

### 4.10 `GetAboveCell(columnHeight, mino)` — IL 14575
```
MinoCoordinate* c = FallMino.GetCoordinate(mino)   // c[0..3] = (x,y) offsets
for i in 0..3:
    if columnHeight[c[i].x + mino.p.x] > mino.p.y - c[i].y: return 1
return 0
```
Semantics: returns 1 iff **some shape cell lies strictly below its column's height**
(i.e. the piece is buried/tucked into the stack). Returns 0 on an empty board / for a piece
sitting entirely above every column. This is why derive only yields tucks on flat boards it
rejects everything and the base/template is the only source of normal placements.

### 4.11 `OverrideSameNode(targetBaby)` — IL 14270
See §6.1.

### 4.12 `DeleteSameNode(childNode, index)` — IL 14303
See §6.2.

### 4.13 `RegistChildNode(babyNode, childCount, parentGame, childNode)` — IL 14353
```
Node* out = childNode
ExpandedChild.ClearChild(expandedChild)
int num = 0
for i in [0, childCount):
    out.board = parentGame.board                       // copy 136B
    out.btb   = parentGame.btb                         // @+292
    out.combo = parentGame.combo                       // @+288
    out.fallingMino = babyNode[i].fallingMino          // 32B @+32
    out.hold        = babyNode[i].hold                 // 12B @+16
    out.nextIt      = babyNode[i].nextIt               // 16B @+0
    out.commands    = babyNode[i].commands             // 56B @+232
    if GamePack.LockDown(out) == 0:                     // gameover / spawn blocked
        childCount--; num--; out -= 328                 // reuse the slot
    else if DeleteSameNode(childNode, num) == 1:        // duplicate of an earlier child
        childCount--; num--; out -= 328
    else:
        ExpandedChild.AddChild(expandedChild, out)
    num++; out += 328
return childCount
```
`GamePack.LockDown` (IL 6928): `HardDrop`; `LockMino` (returns −1→0 on gameover);
`Others.Totaling`; `ClearLine` if any; `hold.swappedHold=0`; `lockedMino=fallingMino`;
`nextIt += 4 bytes`; `Spawn(nextIt.Get())` (returns 0 if spawn blocked).

### 4.14 `ExpandTemplateNode(babyNode, childCount)` — IL 14872 (see §7)
Ignores the passed `childCount`; returns `entries+1` and overwrites `babyNode[1..entries]`.

### 4.15 `Op*` variants (used only by `SearchAI.OpSearch`, which is gated on `TemplateAI.UseTemplate()`)

* **`OpExpandNode`** (IL 14952): identical to `ExpandNode`, except it calls `OpExpandDeriveNode`
  instead of `ExpandDeriveNode` (both in the normal and the hold pass). All else equal.
* **`OpExpandDeriveNode`** (IL 15015): guard lambda (IL 15130) is `deriveGuard` **without the `m==4`
  shortcut**; order is `OpTryDeriveMoveL`, `OpTryDeriveMoveR`, `TryDeriveRotateB`, `TryDeriveRotateA`.
  No Fin tucks. After a successful MoveL/MoveR it additionally does:
  ```
  copy babyNode[childCount] = babyNode[childCount-1]   // the just-added baby
  if Command.SoftDropOnce(&babyNode[childCount].commands, &...fallingMino, board) == 1
     && OpTryDeriveMoveL(&babyNode[childCount], board, columnHeight) == 1:
       AddBaby; childCount++
  ```
  (MoveR uses `SoftDropOnce` + `OpTryDeriveMoveR`.)
* **`OpTryDeriveMoveL`** (IL 15166):
  ```
  if MoveLeft == 0: return 0
  slide left up to 10 times (unconditional)
  if GetAboveCell(...) == 0:                 // slid to wall but not buried
      if b.m != 3: return 0                  // only O piece may retry (MinoType O == 3)
      if SoftDropOnce(...) == 0: return 0
      slide left up to 10 more times
      if GetAboveCell(...) == 0: return 0
  return OverrideSameNode(b) != 1 ? 1 : 0
  ```
* **`OpTryDeriveMoveR`** (IL 15210): mirror of `OpTryDeriveMoveL` with `MoveRight`.

---

## 5. Vectors `expandedBaby` / `expandedChild`

### 5.1 `ExpandedBaby` — 48 buckets × 168 bytes, stores `BabyNode*` pointers
```
AddBaby(expandedBaby, baby):                       // IL 14071
    bucket = baby.r * 12 + (baby.x + 2)            // r∈0..3, x∈-2..9 -> 0..47
    vec = expandedBaby[bucket]
    vec.ptr[vec.count] = baby
    vec.count++

ClearBaby(expandedBaby):                           // IL 14080
    zero counts of all 48 buckets

GetFilteredCount(expandedBaby, childCount):        // IL 14102
    for each bucket b:
        c = b.count
        if c > 1:
            childCount += 1 - c                    // keep exactly 1 per non-empty bucket
            // tournament keeping the element with the SMALLEST +80 (moveDelay):
            // mark every loser's baby.commands.moveDelay = 1000000
    return childCount
```
After `GetFilteredCount`, `std::partition` (IL 15254) moves all `babyNode` whose
`commands.moveDelay < 10000` to the front; only those `kept` are re-added to `expandedBaby`.
So the base-prune keeps **one baby per (r, x) bucket** and drops the rest.

### 5.2 `ExpandedChild` — 40 buckets × 168 bytes, stores `Node*` pointers
```
AddChild(expandedChild, node):                     // IL 14158
    bucket = node.board.lockedBottom * 2 + (node.lockedMino.r & 1)
    vec = expandedChild[bucket]; vec.ptr[vec.count++] = node
```
`ClearChild` zeroes all 40 counts (IL 14167).

---

## 6. Exact dedup / filter rules

### 6.1 `OverrideSameNode(targetBaby)` (Baby-level dedup, IL 14270)
```
ptr = expandedBaby[ targetBaby.r*12 + (targetBaby.x + 2) ]
for each stored baby s in that bucket:
    if s.fallingMino.p.y != targetBaby.fallingMino.p.y:
        continue
    if s.commands.moveDelay > targetBaby.commands.moveDelay:
        *s = targetBaby                    // copy 120B: keep the LOWER delay
    return 1                               // "same node exists"
return 0                                   // "new"
```
Comparison key: **`(r, x, y)` only** (r,x via bucket, y compared). Tie-break: keep the baby with
the **smaller `commands.moveDelay`**. `m`, `lastSrs`, `bugGravity`, command string, hold and nextIt
are **not** compared. Because the stored value is a pointer into `babyNode[]`, replacing a
duplicate mutates the already-generated baby in place.

### 6.2 `DeleteSameNode(childNode, index)` (Node-level dedup, IL 14303)
```
cand = childNode + index*328
bucket = expandedChild[ cand.board.lockedBottom*2 + (cand.lockedMino.r & 1) ]
for each stored Node* s in bucket:
    if s.board.line[L]   != cand.board.line[L]   continue   // L = lockedBottom
    if s.board.line[L+1] != cand.board.line[L+1] continue
    if s.board.line[L+2] != cand.board.line[L+2] continue
    if s.board.line[L+3] != cand.board.line[L+3] continue
    if s.others.act       != cand.others.act      continue
    if s.commands.moveDelay > cand.commands.moveDelay:
        *s = *cand                     // copy 328B: keep the LOWER delay
    return 1                           // duplicate
return 0
```
Comparison key: **bucket `(board.lockedBottom, lockedMino.r&1)` + the four board rows
`line[lockedBottom .. lockedBottom+3]` + `others.act`**. Tie-break: smaller
`commands.moveDelay` (includes the hard-drop cost). Note `combo`/`btb` are **not** compared.

### 6.3 Acceptance rule in `RegistChildNode`
A baby becomes a child iff `LockDown != 0` **and** `DeleteSameNode == 0`. `LockDown == 0` covers both
`LockMino == -1` (top-out) and `Spawn` failure (next piece cannot spawn). There is no check that the
baby's own cells are legal before locking: legality is guaranteed by the command generation
(collision-checked moves/rotations/drops).

---

## 7. `ExpandTemplateNode` and its tables (this is NOT inert — see §0)

### 7.1 Pseudocode (IL 14872)
```
int ExpandTemplateNode(BabyNode* babyNode, int ignoredChildCount):
    (num, table) = switch babyNode.m:
        case 3 (O): (9, childO)        // childO has 8 entries
        case 0 (I): (34, childI)       // childI has 33 entries
        default   : (34, childSZTJL)   // childSZTJL has 33 entries
    BabyNode* dst = babyNode + 1                       // slot 1
    bool inherit = (babyNode.hold.swappedHold != 0)    // baby+92
    for e in table[0 .. num-2]:                        // num-1 = entry count
        dst.hold        = babyNode.hold       (copy 12B)
        dst.nextIt      = babyNode.nextIt     (copy 16B)
        dst.m           = babyNode.m
        dst.y           = babyNode.y          (spawn y)
        dst.r           = e.r
        dst.x           = e.x
        FallMino.UpdateShape(&dst)
        dst.bugGravity  = 0
        if !inherit:
            Command.Init(&dst.commands)
            dst.commands.moveDelay = e.delay
        else:
            dst.commands = babyNode.commands  (copy 56B)
            dst.commands.moveDelay += e.delay
        Command.AddCommands(&dst.commands, e.cmds)
        dst++
    return num
```
The template does **not simulate** `e.cmds`; it directly assigns `x`/`r` and records the command
string (so the recorded delay/command stream matches the native log). `ExpandDeriveNode` then
soft-drops each template baby and adds tucks; `RegistChildNode` hard-drops and dedups them.

### 7.2 Table decoding
Each `TemplateChild` is 20 bytes: `char cmds[8]; int32 delay; int32 x; int32 r;`
(the first ≥1 entry count discrepancy is because `num = entries+1` includes the root).
Retrieved from the `const` data at IL 690 (`childI`), 692 (`childSZTJL`), 698 (`childO`).

**childI — 33 entries** (piece = I)
```
 0 lll      90   x= 0 r=0      6 lllall  150  x=-2 r=1     16 lllbl   120  x=-1 r=3     26 llblb    90  x=0 r=2
 1 ll       60   x= 1 r=0      7 lllal   120  x=-1 r=1     17 lllb     90  x= 0 r=3     27 lblb     60  x=1 r=2
 2 l        30   x= 2 r=0      8 llla     90  x= 0 r=1     18 llb      60  x= 1 r=3     28 blb      32  x=2 r=2
 3 r        30   x= 4 r=0      9 lla      60  x= 1 r=1     19 lb       30  x= 2 r=3     29 bb       32  x=3 r=2
 4 rr       60   x= 5 r=0     10 la       30  x= 2 r=1     20 b         0  x= 3 r=3     30 ara      32  x=4 r=2
 5 rrr      90   x= 6 r=0     11 a         0  x= 3 r=1     21 rb       30  x= 4 r=3     31 rara     60  x=5 r=2
                              12 ra       30  x= 4 r=1     22 rrb      60  x= 5 r=3     32 rrara    90  x=6 r=2
                              13 rra      60  x= 5 r=1     23 rrrb     90  x= 6 r=3
                              14 rrra     90  x= 6 r=1     24 rrrbr   120  x= 7 r=3
                              15 rrrar   120  x= 7 r=1     25 rrrbrr  150  x= 8 r=3
```
**childSZTJL — 33 entries** (pieces S,Z,T,J,L)
```
 0 lll      90   x= 0 r=0      7 lllal   120  x=-1 r=1     16 lllb     90  x= 0 r=3     25 llblb    90  x=0 r=2
 1 ll       60   x= 1 r=0      8 llla     90  x= 0 r=1     17 llb      60  x= 1 r=3     26 lblb     60  x=1 r=2
 2 l        30   x= 2 r=0      9 lla      60  x= 1 r=1     18 lb       30  x= 2 r=3     27 blb      32  x=2 r=2
 3 r        30   x= 4 r=0     10 la       30  x= 2 r=1     19 b         0  x= 3 r=3     28 bb       32  x=3 r=2
 4 rr       60   x= 5 r=0     11 a         0  x= 3 r=1     20 rb       30  x= 4 r=3     29 ara      32  x=4 r=2
 5 rrr      90   x= 6 r=0     12 ra       30  x= 4 r=1     21 rrb      60  x= 5 r=3     30 rara     60  x=5 r=2
 6 rrrr    120   x= 7 r=0     13 rra      60  x= 5 r=1     22 rrrb     90  x= 6 r=3     31 rrara    90  x=6 r=2
                              14 rrra     90  x= 6 r=1     23 rrrrb   120  x= 7 r=3     32 rrrara  120  x=7 r=2
                              15 rrrar   120  x= 7 r=1     24 rrrrbr  150  x= 8 r=3
```
**childO — 8 entries** (piece = O)
```
 0 llll 120 x=-1 r=0    2 ll  60 x=1 r=0    4 r   30 x=4 r=0    6 rrr  90 x=6 r=0
 1 lll   90 x= 0 r=0    3 l   30 x=2 r=0    5 rr  60 x=5 r=0    7 rrrr 120 x=7 r=0
```
Entry counts: `childI`=33, `childSZTJL`=33, `childO`=8 ⇒ `ExpandTemplateNode` returns 34/34/9.
`childSZTJL` entry 0–6 are r=0 columns; 7–15 r=1; 16–24 r=3; 25–32 r=2.

---

## 8. Uncertainties / things I could NOT determine (flagged, not guessed)

1. **Template-vs-config (highest impact).** §0 shows `ExpandTemplateNode` is not gated by
   `useTDOpeners` and runs whenever `IsSafe`. The task brief asserts it is inert. These cannot both be
   true. I did **not** silently follow either. The tables are decoded in §7 so the port can implement
   the native behavior; implementing base+derive only will diverge on `stackHeight < p.y-3`.
2. **`ExpandNode` hold pass ignores `SwapHold` failure.** C++ (`TetrizAI_Expand.cpp:40`) returns
   `min(prevChildCount, MAX_CHILDREN)` when `SwapHold == 0`; the binary (IL 14254) proceeds regardless.
   Follow the binary for bit-exact parity. `SwapHold` returns 0 only when `hold.swappedHold == 1`
   (IL 6865), which is reset by `LockDown`, so in practice it rarely triggers.
3. **`MAX_BABYS` overflow.** `babyNode` is 300 slots; I found **no** bounds check while `ExpandBaseNode`
   or `ExpandDeriveNode` append. A TS implementation must either prove the frontier stays ≤ 300 or add
   a defensive cap (state the choice explicitly — a silent cap would change behavior).
4. **Hard-drop delay constant.** Binary `Command.HardDrop` adds **112** (IL 6728); the C++ source
   `TetrizAI_Common.cpp:255` adds **116**. Port's `moveDelay()` uses 116. For `DeleteSameNode`
   tie-breaks this difference can flip which child wins; use 112 to match the binary.
5. **`Others.Totaling` details** (IL 21211) were only skimmed. It sets `others.act` (0 None,1 Single,
   2 Double,3 Triple,4 Quad,5 Tss,6 Tsd,7 Tst,8 Tsm,9 Pc), which `DeleteSameNode` compares at `+296`.
   If the port's ClearAct classification differs, child dedup differs. Out of Expand's direct scope but
   load-bearing. The C++ `Others::CalcAtk` (Tetriz_Common.cpp:530) is the older equivalent.
6. **`GameState`/`Node` exact tail layout.** Offsets ≥ +300 are inferred from SearchAI usage
   (+304 score, +308 familyScore, +312 pcScore) and the 328 stride; not needed by Expand.
7. **`NextIterator` variant.** Binary is the pointer variant (`m`/`trustEnd` pointers, advanced by
   `+= 4` bytes in `LockDown`), not the `OUR` index variant in `TetrizAI_Common.h`. This affects the
   hold/queue bookkeeping only.
8. **`GetFilteredCount` semantics.** I decoded it as "keep exactly one baby per `(r,x)` bucket, the one
   with the smallest `moveDelay`". It is only reached when `childCount > 34` after base expansion; the
   collapse to ≤48 babies is aggressive. Report what was observed, not a rationalization.

---

## 9. Helper semantics used by Expand (authoritative summaries)

### 9.1 Command (IL 6687–6920; C++ `TetrizAI_Common.cpp:233`)
* `Init`: zero 48 cmd bytes, `moveDelay=0`, `len=0`.
* `MoveLeft` (IL 6767): fail if `Board.CollisionLeft`; `x-=1`; `lastSrs=0`; append `'l'`;
  `moveDelay+=30`; if `bugGravity==1 && !CollisionBottom` then `y-=1; bugGravity=0; append 'g',y`.
* `MoveRight`: mirror (`'r'`).
* `RotateA` (IL 6811): fail if `m==3` (O) or `Board.SrsA==0`; append `'a'`; `moveDelay+=16`;
  `lastSrs = return of SrsA`. `RotateB` mirror (`'b'`, `SrsB`).
* `SoftDrop` (IL 6738): `d = CollisionDistance`; if 0 fail; `y-=d; lastSrs=0`;
  append `'d', 'A'+y`; `moveDelay += d*33`.
* `SoftDropOnce` (IL 6753): fail if `CollisionBottom`; `y-=1; lastSrs=0`; append `'d','A'+y`;
  `moveDelay+=33`.
* `HardDrop` (IL 6723): append `'u'`; `moveDelay+=112`; `d=CollisionDistance`; if `d>0`
  `y-=d; lastSrs=0`.
* `AddCommands` (IL 6696): copy 7 bytes at `s+len`, `len += strlen(cmds)`.

### 9.2 Board collision / rotation (IL 20626–21178; C++ `Tetriz_Common.cpp`)
* `CollisionBoard`: bounds via `rect.left+x >= 0`, `rect.right+x < 10`, `y-rect.bottom >= 0`;
  then the four rows `y-3..y` against `shape.bit.line[3..0]` shifted by `x`.
* `CollisionBottom` = same against `y-4..y-1`; `CollisionLeft` = `shape >> (x-1)`, bounds
  `rect.left+x >= 1`; `CollisionRight` = `x+1`, bounds `rect.right+x <= 8`.
  (`= 1` means collision.)
* `CollisionDistance` = number of rows the piece can fall.
* `SrsA`/`SrsB` (IL 20866/20898): mutate `r` via `SpinA/SpinB`, check collision; if clear return 1
  (`lastSrs=1`, no kick); else try the 4 `srsRotateA/B[(m*4+r_new)*32]` test offsets, return `i+2`
  on success; else undo rotation (`SpinB`/`SpinA`) and return 0. So `lastSrs ∈ {0,1,2,3,4,5}` and
  `lastSrs==5` means the 4th kick (`srs->test[3]`) was used — the only value `TryDeriveFin*` accepts.
* `GetCoordinate` (IL 20582): `&minoCoordinate[(m*4 + r)]`, 4 × `(int x,int y)`.
* `UpdateShape` (IL 20577): `shape = &minoShape[(m*4 + r)]`.
* `LockMino` (IL 20930): if `Bottom() > 19` return −1 (gameover); OR the four shape rows into
  `line[y-3..y]`; count full rows; update `stackHeight`, `lockedBottom`.
* `ClearLine` (IL 21043), `GetSpawnHeight` (IL 20670).

### 9.3 `GamePack.LockDown` (IL 6928) / `IsSafe` (IL 6956)
`LockDown`: `HardDrop` → `LockMino` (0 if −1) → `Others.Totaling` → `ClearLine` if lines>0 →
`hold.swappedHold=0` → `lockedMino=fallingMino` → `nextIt += 4` → `Spawn(nextIt.Get())`
(returns 0 if spawn blocked → child rejected).
`IsSafe`: `board.stackHeight < fallingMino.p.y - 3`.

---

## 10. TS integration notes (`/home/s0u7a/browser-tetris`)

**Bit order is mirrored.** Native puts world column `c` at bit `9-c`; `src/core/board.ts` puts column
`x` at bit `x` (`1 << x`). Translate native masks as `colBit(c) = 1 << c` (not `512 >> c`) when reading
the port board, and read `columnHeight(c) = number of rows occupied`, same as native. Row index is
bottom-up in both. `FULL_ROW = 0x3ff` matches.

**Coordinates.** `src/core/pieces.ts` `NATIVE_CELLS` uses the same leftmost=0 cell offsets as native
`MinoCoordinate` (verified against the binary `minoCoordinate` block, e.g. I r0 = (0,1)(1,1)(2,1)(3,1)).
`GetAboveCell` in port terms: for each raw cell `(cx,cy)` of the piece at rotation `r`,
`col = px + cx`, `row = py + cy` if `py` is the piece's top-anchor; if using `bottomCellsOf` + bottom
row `by`, then `row = by + (maxCellY - cy)`. Ensure one consistent convention. Return true iff
`columnHeight[col] > row` for any cell.

**What to implement, in order:**
1. A `Baby` struct mirroring §1 (FallMino+Command+HoldMino+nextIt) with `moveDelay` and lastSrs/bugGravity.
2. `Command.*` per §9.1 using native **112** hard-drop delay.
3. `OverrideSameNode`/`DeleteSameNode`/`AddBaby`/`GetFilteredCount` per §5–6 exactly (including the
   in-place replacement of the winner's lower `moveDelay`).
4. `ExpandBaseNode` + `ExpandDeriveNode` + `RegistChildNode` per §4.2/4.3/4.13.
5. `ExpandTemplateNode` + the §7 tables, selected by `IsSafe`. Without this the port only matches the
   native engine when `stackHeight >= fallingMino.y - 3`.

**Current port gap.** `src/ai/hoiko-search.ts` expands via `enumerateKickPlacements` (all SRS-kick
placements). That is a different set from native `ExpandTemplateNode ∪ derived tucks`; it can include
placements native never generates and miss native tuck states. Replace it with the above.

---

## 11. Method / IL index

| Method | IL line |
|---|---|
| ExpandedBaby.AddBaby / ClearBaby / GetFilteredCount | 14071 / 14080 / 14102 |
| ExpandedChild.AddChild / ClearChild | 14158 / 14167 |
| ExpandAI.Init / End | 14182 / 14194 |
| **ExpandNode** | **14207** |
| OverrideSameNode | 14270 |
| DeleteSameNode | 14303 |
| RegistChildNode | 14353 |
| TryDeriveRotateB / RotateA | 14443 / 14457 |
| TryDeriveMoveL / MoveR | 14471 / 14500 |
| TryDeriveFinB / FinA | 14529 / 14552 |
| GetAboveCell | 14575 |
| **ExpandBaseNode** | **14595** |
| **ExpandDeriveNode** | **14706** |
| derive guard lambda | 14832 |
| ExpandTemplateNode | 14872 |
| OpExpandNode | 14952 |
| OpExpandDeriveNode / guard lambda | 15015 / 15130 |
| OpTryDeriveMoveL / MoveR | 15166 / 15210 |
| std::partition / std::min_element | 15254 / 15289 |
| Command.* | 6687–6920 |
| GamePack.LockDown / IsSafe | 6928 / 6956 |
| NextMino/NextIterator | 6529–6685 |
| FallMino.Spawn/Spin/UpdateShape/GetCoordinate | 20529–20585 |
| Bit.Log2 | 20612 |
| Board collision/Srs/Lock/Clear/GetColumnHeight | 20626–21178 |
| Others.Totaling | 21211 |
| TemplateAI.ReadConfig / UseTemplate | 16524 / 20447 |
| childI / childSZTJL / childO data | 690 / 692 / 698 |
