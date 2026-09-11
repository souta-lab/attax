# SPEC — binary `OffsetOffAI` (garbage/offset management), Hoiko v0-beta1

Authoritative source: `/tmp/opencode/re/Hoiko.all.cs` (decompiled binary).
This is the SHIPPING revision. It differs from the C++ `OffsetAI` in
`/home/s0u7a/hoiko-src/TetrizAI_Evaluate.cpp` (no `opponentsCombo` branches).

Config: `useOffsetOff=false` in `config.dll`, but the driver enables it:
`OffsetOffAI.UseOffsetOff(ConfigAI.UseOffsetOff())` then overrides with `UseOffsetOff(true)`
when a match starts (see call sites). Treat offset as **active** for a real VS match.

## Struct layouts (byte offsets)

`OffsetData` (16 B):
- +0  bool `canWaitGarbage`
- +4  int  `center4Height`
- +8  int  `atk`
- +12 bool `pcChance`
- +13 bool `nearOffset`

`GarbageData` (20 B), all `static`:
- +0  int  `opponentsAtk`
- +4  int  `coolTime`
- +8  int  `remainingTime`
- +12 int  `opponentsLockCount`
- +16 bool `firstInvalidLock`

## Methods (IL 13777–14069)

```
UseOffsetOff(set): useOffsetOff = set; ofsData = zeros; gbData = zeros.

CanOffsetOff(garbage):                       # IL 13799
    if !ofsData.canWaitGarbage: return false
    if ofsData.center4Height + garbage >= 15: return false
    if isEvenBoard && ofsData.pcChance && ofsData.atk >= garbage: return false
    if ofsData.nearOffset && garbage >= 4: return true
    if ofsData.atk < garbage: return true
    return garbage > 2

DecisionOffsetOff(searched):                 # IL 13824
    ofsData.canWaitGarbage = 0
    if !useOffsetOff || searched.plans.act[0] != None: return     # +904
    ofsData.pcChance = 0
    if isEvenBoard:                                              # +? EvaluateAI.isEvenBoard
        end = min(searched.result.depth - 1, searched.next.trustEnd + 1)   # +444, +112
        for i in 2..end: if searched.plans.act[i] == Pc: ofsData.pcChance = 1; break   # +904+i*4
    ofsData.nearOffset = 0
    ofsData.atk = 0
    switch searched.plans.act[1]:            # +908
    case None:
        switch searched.plans.act[2]:        # +912
        case Tst:  if hold.m == T || next.m[2] != T: atk = 6 else return
        case Tsd:  if hold.m == T || next.m[2] != T: atk = 4 else return
        case Tss:  if hold.m == T || next.m[2] != T: atk = 2 else return
        case Quad: if hold.m == I || next.m[2] != I: atk = 4 else return
        default: return
        atk += (searched.others.btb > 0 ? 1 : 0)    # +412
        nearOffset = 1
    case Single:   if !pcChance: break;  goto compute
    case Double:   atk = 1; goto compute
    case Triple:   atk = 2; goto compute
    case Tss:      atk = 2 + btbBonus; goto compute
    case Quad:
    case Tsd:      atk = 4 + btbBonus; goto compute
    case Tst:      atk = 6 + btbBonus; goto compute
    case Tsm:      if btbBonus==1 { atk = 1; goto compute } else break
    case Pc:       break
    default:       break
    goto end
    compute:
        GetColumnHeight(searched.board, col)      # +216
        center4Height = max(col[3], col[4], col[5], col[6])
        canWaitGarbage = 1
    end:

ResetOpponentsAtk(): gbData.opponentsAtk = 0

CalcOpponentsAtk(line, btb, btbBuff, combo):   # IL 13974
    if useOffsetOff && line > 1 && btb != 0 && combo <= 4:
        gbData.opponentsAtk = (line == 4 ? 4 : line*2) + btbBuff + (combo > 2 ? 1 : 0)

GetOpponentsAtk(): return gbData.opponentsAtk

SetPrevAct(act):                                # IL 13999  -> gbData.remainingTime
    remainingTime = { None:0, Single/Tss/Tsm:15, Double/Triple/Tsd/Tst:10, Quad:5, Pc:21 }

LockOffsetAfterClearing(frame, sendingGarbage, lock):   # IL 14029
    if gbData.remainingTime > 0:
        coolTime = frame + remainingTime
        if sendingGarbage <= 0: coolTime += 24
        opponentsLockCount = lock
        firstInvalidLock = 1
        opponentsAtk = -1

OpponentIsNewLockDown(lock):                   # IL 14045
    isNew = gbData.opponentsLockCount != lock
    opponentsLockCount = lock
    return isNew

InvalidateGettingEnemysAtk(): gbData.opponentsAtk = -1

IsLocked(frame): return gbData.coolTime > frame

IsFirstInvalidLockDown():                      # IL 14064
    r = gbData.firstInvalidLock; firstInvalidLock = 0; return r
```

## Driver call-site flow (see IL ~2840–2915, 3140–3280)

Per frame / per own lock:
- `DecisionOffsetOff(root)` after each search.
- `CanOffsetOff(pendingGarbageRows)` decides whether HOIKO should **wait** (delay its lock)
  instead of placing immediately. In the app this maps to `AiMove.garbageWait` + the core's
  `setGarbageWait` (already exists in `versus/controller.ts`).
- `SetPrevAct(act)` after a clear; `LockOffsetAfterClearing(frame, sendingGarbage, lock)`
  when a piece locks; `IsLocked(frame)` gates actions during the cool-time.
- Opponent events: `OpponentIsNewLockDown(opponentLockCount)`, `CalcOpponentsAtk(...)`,
  `ResetOpponentsAtk`, `InvalidateGettingEnemysAtk`.

Frame clock in the binary is `Memory.GetMatchFrames()` (game frames, ~60/s at the game).

## Mapping to the app

`GarbageData`/`OffsetData` are already modelled in
`/home/s0u7a/browser-tetris/src/ai/hoiko-offset.ts` (the OLD C++ semantics). Rewrite that
module to the binary semantics above (the differences: no `opponentsCombo` branches in
`CanOffsetOff`; `SetRemainingTime` values identical; `atk` table identical; `pcChance`
loop bound `min(depth-1, trustEnd+1)`).

The search must expose the chosen line's `plans.act[0..2]` and `result.depth`. The TS
`SearchOutcome` currently exposes `firstAct` (act[0]) only — add `planActs: readonly ClearAct[]`
(act[0..2] at least) and keep `depth`.
