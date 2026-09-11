# Addendum — `Others.Totaling` (CalcAtk) and `Board.IsTspin` decoded

Resolves two of the three "undetermined" items in `REFERENCE.md §9`. Both were decoded from
`Hoiko.all.cs` and compared against the existing port. **Verdict: the existing port already matches
both**, with one cosmetic PC-detection nuance.

## 1. `Others.Totaling` (IL 21211) — the real `CalcAtk`

Signature is `(Others* o, FallMino* mino, Board* bd, int clearedLine)`. The 4th arg is `clearedLine`
(not moveDelay — the decompiler's name is wrong; it indexes `bd.line[clearedLine]`).

Called from `GamePack.LockDown` (IL 6942) **before** `Board.ClearLine`, so `bd` is the post-lock,
pre-clear board. `o.combo=+0`, `o.btb=+4`, `o.act=+8`.

```
Totaling(o, mino, bd, n):            # n = cleared lines
    if n == 0:
        o.combo = o.combo > 0 ? -o.combo : 0
        o.act = 0                    # None
        return
    if o.combo < 0: o.combo = 0
    # perfect clear: the row under the cleared block is full AND the row above is empty
    if bd.line[n-1] == 0x3FF and bd.line[n] == 0:
        if n >= 4: o.btb += 1 else: o.btb = 0
        o.combo += 1
        o.act = 9                    # Pc
        return
    if n >= 4:
        o.btb += 1
        o.act = 4                    # Quad
    else:
        t = Board.IsTspin(bd, mino)  # 0 none, 1 full, 2 mini
        if t == 1:
            o.act = n==1 ? 5 : n==2 ? 6 : 7      # Tss/Tsd/Tst
            o.btb += 1
        else:
            o.act = n==1 ? 1 : n==2 ? 2 : 3      # Single/Double/Triple
            if t == 2: o.act = 8; o.btb += 1      # Tsm
            else: o.btb = 0
    o.combo += 1
```

### Port comparison — `hoiko-search.ts:sourceOthers`
| aspect | binary | port | verdict |
|---|---|---|---|
| no-clear | `combo = combo>0 ? -combo : 0`, act None | identical | ✅ |
| clear combo | `if combo<0 ->0; combo++` | identical | ✅ |
| PC | `line[n-1]==FULL && line[n]==0` (pre-clear board) | `isEmpty(after)` (post-clear board) | ⚠️ equivalent on normal states; exact form differs |
| PC btb | `n>=4 ? btb++ : 0` | identical | ✅ |
| Quad | act 4, `btb++` | identical | ✅ |
| T-spin full 1/2/3 | act 5/6/7, `btb++` | identical | ✅ |
| Tsm | act 8, `btb++` | identical | ✅ |
| plain | act 1/2/3, `btb=0` | identical | ✅ |

→ Only the PC predicate differs. Since the port passes the post-clear board, `isEmpty(after)` is the
canonical PC test; the binary's local check is weaker but the game states reachable in solo make them
agree except pathological gap cases. For bit-exactness, replicate the binary's 2-row test on the
pre-clear board.

## 2. `Board.IsTspin` (IL 20978)

```
IsTspin(bd, mino):                   # mino.m=+12, x=+0, y=+4, r=+8, lastSrs=+16
    if mino.m != 4: return 0          # not T
    if mino.lastSrs == 0: return 0    # must have rotated
    corner = [0,0,0,0]; count = 0
    # corners at (x, y), (x+2, y), (x+2, y-2), (x, y-2); 512>>c == column c
    corner[0] = 1 if (x<0  || (bd.line[y-0] & (512>>x))     != 0)
    corner[1] = 1 if (x>=8 || (bd.line[y-0] & (512>>(x+2))) != 0)
    corner[2] = 1 if !(x<8 && y-2>=0 && (bd.line[y-2] & (512>>(x+2))) == 0)
    corner[3] = 1 if !(x>=0 && y-2>=0 && (bd.line[y-2] & (512>>x))     == 0)
    count = sum(corner)
    if count < 3: return 0
    r  = mino.r; r2 = (r+1 <= 3) ? r+1 : 0
    if corner[r] != corner[r2] and mino.lastSrs != 5: return 2   # mini
    return 1                                                     # full
```

### Port comparison — `src/core/tspin.ts:classifyTspin`
Exact line-for-line match: same `lastSrs==0 -> none`, same four corners `(px,nativePy),(px+2,nativePy),(px+2,nativePy-2),(px,nativePy-2)`,
same `count<3 -> none`, same `occupied[index] !== occupied[next] && lastSrs !== 5 ? mini : full`.
**✅ already faithful.**

## 3. Effect on the D1–D8 plan
- No new work for the T-spin rule (already correct).
- `sourceOthers` needs only the PC predicate tweak if bit-exactness is required.
- `DeleteSameNode` compares `others.act`, which feeds from `Totaling`; the act values above are the
  authoritative enum (None0 Single1 Double2 Triple3 Quad4 Tss5 Tsd6 Tst7 Tsm8 Pc9).
