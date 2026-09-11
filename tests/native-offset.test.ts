import { describe, expect, test } from "bun:test";
import { createHoikoNative } from "../src/ai/hoiko-native.js";
import { OffsetOffAI } from "../src/ai/native/offset.js";
import { NextMino, trustRange } from "../src/ai/native/nextmino.js";
import type { CellValue, GameSnapshot } from "../src/ui/types.js";
import {
  ACT_DOUBLE,
  ACT_NONE,
  ACT_PC,
  ACT_QUAD,
  ACT_SINGLE,
  ACT_TRIPLE,
  ACT_TSD,
  ACT_TSM,
  ACT_TSS,
  ACT_TST,
  MINO_I,
  MINO_J,
  MINO_NONE,
  MINO_T,
} from "../src/ai/native/shapes.js";

function next(trustEnd: number, m2: number): NextMino {
  const nm = new NextMino();
  nm.viewNext = 2;
  nm.trustEnd = trustEnd;
  nm.m[0] = MINO_NONE;
  nm.m[1] = MINO_NONE;
  nm.m[2] = m2;
  return nm;
}

function emptyColumns(): Int32Array {
  return new Int32Array(10);
}

describe("OffsetOffAI.CanOffsetOff (SPEC_OffsetOffAI IL 13799)", () => {
  test("returns false when canWaitGarbage is clear", () => {
    const ai = new OffsetOffAI(true);
    expect(ai.canOffsetOff(1, false)).toBe(false);
  });

  test("rejects waiting when center4Height + garbage >= 15", () => {
    const ai = new OffsetOffAI(true);
    ai.ofsData.canWaitGarbage = true;
    ai.ofsData.center4Height = 13;
    expect(ai.canOffsetOff(2, false)).toBe(false);
    ai.ofsData.center4Height = 12;
    expect(ai.canOffsetOff(3, false)).toBe(false);
    expect(ai.canOffsetOff(2, false)).toBe(true);
  });

  test("even board + pcChance + atk >= garbage rejects waiting", () => {
    const ai = new OffsetOffAI(true);
    ai.ofsData.canWaitGarbage = true;
    ai.ofsData.pcChance = true;
    ai.ofsData.atk = 3;
    ai.ofsData.center4Height = 0;
    expect(ai.canOffsetOff(3, true)).toBe(false);
    expect(ai.canOffsetOff(4, true)).toBe(true);
    expect(ai.canOffsetOff(3, false)).toBe(true);
  });

  test("nearOffset short-circuits for garbage >= 4", () => {
    const ai = new OffsetOffAI(true);
    ai.ofsData.canWaitGarbage = true;
    ai.ofsData.nearOffset = true;
    ai.ofsData.atk = 10;
    expect(ai.canOffsetOff(4, false)).toBe(true);
    ai.ofsData.nearOffset = false;
    expect(ai.canOffsetOff(2, false)).toBe(false);
    expect(ai.canOffsetOff(3, false)).toBe(true);
  });

  test("atk < garbage waits, otherwise only garbage > 2", () => {
    const ai = new OffsetOffAI(true);
    ai.ofsData.canWaitGarbage = true;
    ai.ofsData.atk = 2;
    expect(ai.canOffsetOff(3, false)).toBe(true);
    expect(ai.canOffsetOff(2, false)).toBe(false);
    expect(ai.canOffsetOff(3, false)).toBe(true);
    ai.ofsData.atk = 5;
    expect(ai.canOffsetOff(3, false)).toBe(true);
    expect(ai.canOffsetOff(2, false)).toBe(false);
    expect(ai.canOffsetOff(1, false)).toBe(false);
    expect(ai.canOffsetOff(0, false)).toBe(false);
  });

  test("binary has no opponentsCombo branch (differs from old C++)", () => {
    const ai = new OffsetOffAI(true);
    ai.ofsData.canWaitGarbage = true;
    ai.ofsData.nearOffset = true;
    ai.ofsData.atk = 10;
    expect(ai.canOffsetOff(4, false)).toBe(true);
    ai.ofsData.nearOffset = false;
    expect(ai.canOffsetOff(3, false)).toBe(true);
    expect(ai.canOffsetOff(2, false)).toBe(false);
  });
});

describe("OffsetOffAI.computeDecision (SPEC_OffsetOffAI IL 13824)", () => {
  test("first planned act non-None disables canWaitGarbage", () => {
    const ai = new OffsetOffAI(true);
    ai.computeDecision([ACT_DOUBLE, ACT_DOUBLE], 10, MINO_NONE, next(3, MINO_NONE), 0, true, emptyColumns());
    expect(ai.ofsData.canWaitGarbage).toBe(false);
  });

  test("Double / Triple set atk and compute center4Height", () => {
    const ai = new OffsetOffAI(true);
    const cols = emptyColumns();
    cols[3] = 1;
    cols[4] = 4;
    cols[5] = 2;
    cols[6] = 3;
    ai.computeDecision([ACT_NONE, ACT_DOUBLE], 10, MINO_NONE, next(3, MINO_NONE), 0, true, cols);
    expect(ai.ofsData.atk).toBe(1);
    expect(ai.ofsData.canWaitGarbage).toBe(true);
    expect(ai.ofsData.center4Height).toBe(4);
    expect(ai.ofsData.nearOffset).toBe(false);
  });

  test("Quad adds the btb bonus", () => {
    const ai = new OffsetOffAI(true);
    ai.computeDecision([ACT_NONE, ACT_QUAD], 10, MINO_NONE, next(3, MINO_NONE), 1, true, emptyColumns());
    expect(ai.ofsData.atk).toBe(5);
  });

  test("Tst / Tsd / Tss / Quad fallback checks hold or next.m[2]", () => {
    const cases = [
      { act2: ACT_TST, piece: MINO_T, atk: 6 },
      { act2: ACT_TSD, piece: MINO_T, atk: 4 },
      { act2: ACT_TSS, piece: MINO_T, atk: 2 },
      { act2: ACT_QUAD, piece: MINO_I, atk: 4 },
    ] as const;
    for (const c of cases) {
      const holds = new OffsetOffAI(true);
      holds.computeDecision([ACT_NONE, ACT_NONE, c.act2], 10, c.piece, next(3, MINO_NONE), 0, true, emptyColumns());
      expect(holds.ofsData.atk).toBe(c.atk);
      expect(holds.ofsData.canWaitGarbage).toBe(true);
      expect(holds.ofsData.nearOffset).toBe(true);

      const nextMino = new OffsetOffAI(true);
      nextMino.computeDecision(
        [ACT_NONE, ACT_NONE, c.act2],
        10,
        MINO_NONE,
        next(3, MINO_J),
        0,
        true,
        emptyColumns(),
      );
      expect(nextMino.ofsData.atk).toBe(c.atk);
      expect(nextMino.ofsData.canWaitGarbage).toBe(true);
    }
  });

  test("Tst fallback returns when the T sits in next.m[2] but not in hold", () => {
    const ai = new OffsetOffAI(true);
    ai.computeDecision(
      [ACT_NONE, ACT_NONE, ACT_TST],
      10,
      MINO_J,
      next(3, MINO_T),
      0,
      true,
      emptyColumns(),
    );
    expect(ai.ofsData.canWaitGarbage).toBe(false);
    expect(ai.ofsData.atk).toBe(0);
  });

  test("Single only computes when pcChance is set", () => {
    const noPc = new OffsetOffAI(true);
    noPc.computeDecision(
      [ACT_NONE, ACT_SINGLE, ACT_NONE],
      10,
      MINO_NONE,
      next(3, MINO_NONE),
      0,
      false,
      emptyColumns(),
    );
    expect(noPc.ofsData.canWaitGarbage).toBe(false);

    const pc = new OffsetOffAI(true);
    pc.computeDecision(
      [ACT_NONE, ACT_SINGLE, ACT_PC],
      10,
      MINO_NONE,
      next(3, MINO_NONE),
      0,
      true,
      emptyColumns(),
    );
    expect(pc.ofsData.pcChance).toBe(true);
    expect(pc.ofsData.atk).toBe(0);
    expect(pc.ofsData.canWaitGarbage).toBe(true);
  });

  test("pcChance scans planActs[2..min(depth-1, trustEnd+1)] and only on even boards", () => {
    const even = new OffsetOffAI(true);
    even.computeDecision(
      [ACT_NONE, ACT_DOUBLE, ACT_NONE, ACT_PC],
      10,
      MINO_NONE,
      next(3, MINO_NONE),
      0,
      true,
      emptyColumns(),
    );
    expect(even.ofsData.pcChance).toBe(true);

    const odd = new OffsetOffAI(true);
    odd.computeDecision(
      [ACT_NONE, ACT_DOUBLE, ACT_NONE, ACT_PC],
      10,
      MINO_NONE,
      next(3, MINO_NONE),
      0,
      false,
      emptyColumns(),
    );
    expect(odd.ofsData.pcChance).toBe(false);

    const beyondTrust = new OffsetOffAI(true);
    beyondTrust.computeDecision(
      [ACT_NONE, ACT_DOUBLE, ACT_NONE, ACT_NONE, ACT_NONE, ACT_PC],
      10,
      MINO_NONE,
      next(3, MINO_NONE),
      0,
      true,
      emptyColumns(),
    );
    expect(beyondTrust.ofsData.pcChance).toBe(false);
  });

  test("Tsm requires the btb bonus", () => {
    const noBtb = new OffsetOffAI(true);
    noBtb.computeDecision([ACT_NONE, ACT_TSM], 10, MINO_NONE, next(3, MINO_NONE), 0, true, emptyColumns());
    expect(noBtb.ofsData.canWaitGarbage).toBe(false);

    const btb = new OffsetOffAI(true);
    btb.computeDecision([ACT_NONE, ACT_TSM], 10, MINO_NONE, next(3, MINO_NONE), 1, true, emptyColumns());
    expect(btb.ofsData.atk).toBe(1);
    expect(btb.ofsData.canWaitGarbage).toBe(true);
  });

  test("useOffsetOff=false disables the whole decision", () => {
    const ai = new OffsetOffAI(false);
    ai.computeDecision([ACT_NONE, ACT_QUAD], 10, MINO_NONE, next(3, MINO_NONE), 1, true, emptyColumns());
    expect(ai.ofsData.canWaitGarbage).toBe(false);
    expect(ai.ofsData.atk).toBe(0);
  });
});

describe("OffsetOffAI.CalcOpponentsAtk (SPEC_OffsetOffAI IL 13974)", () => {
  test("computes the native attack estimate", () => {
    const ai = new OffsetOffAI(true);
    ai.calcOpponentsAtk(2, 1, 1, 3);
    expect(ai.getOpponentsAtk()).toBe(6);
    ai.calcOpponentsAtk(4, 1, 1, 0);
    expect(ai.getOpponentsAtk()).toBe(5);
    ai.calcOpponentsAtk(3, 1, 0, 1);
    expect(ai.getOpponentsAtk()).toBe(6);
  });

  test("ignores line<=1, btb==0 and combo>4", () => {
    const ai = new OffsetOffAI(true);
    ai.calcOpponentsAtk(2, 1, 1, 3);
    expect(ai.getOpponentsAtk()).toBe(6);
    ai.calcOpponentsAtk(1, 1, 1, 3);
    expect(ai.getOpponentsAtk()).toBe(6);
    ai.calcOpponentsAtk(2, 0, 1, 3);
    expect(ai.getOpponentsAtk()).toBe(6);
    ai.calcOpponentsAtk(2, 1, 1, 5);
    expect(ai.getOpponentsAtk()).toBe(6);
  });

  test("does nothing while disabled", () => {
    const ai = new OffsetOffAI(false);
    ai.calcOpponentsAtk(4, 1, 1, 0);
    expect(ai.getOpponentsAtk()).toBe(0);
  });
});

describe("OffsetOffAI.SetPrevAct + LockOffsetAfterClearing + IsLocked (IL 13999/14029/14058)", () => {
  test("SetPrevAct maps clear acts to the native remainingTime", () => {
    const cases = [
      [ACT_NONE, 0],
      [ACT_SINGLE, 15],
      [ACT_TSS, 15],
      [ACT_TSM, 15],
      [ACT_DOUBLE, 10],
      [ACT_TRIPLE, 10],
      [ACT_TSD, 10],
      [ACT_TST, 10],
      [ACT_QUAD, 5],
      [ACT_PC, 21],
    ] as const;
    for (const [act, expected] of cases) {
      const ai = new OffsetOffAI(true);
      ai.setPrevAct(act);
      expect(ai.gbData.remainingTime).toBe(expected);
    }
  });

  test("LockOffsetAfterClearing sets coolTime from frame + remainingTime", () => {
    const ai = new OffsetOffAI(true);
    ai.setPrevAct(ACT_QUAD);
    ai.lockOffsetAfterClearing(100, 1, 4);
    expect(ai.gbData.coolTime).toBe(105);
    expect(ai.gbData.opponentsLockCount).toBe(4);
    expect(ai.gbData.firstInvalidLock).toBe(true);
    expect(ai.gbData.opponentsAtk).toBe(-1);
    expect(ai.isLocked(104)).toBe(true);
    expect(ai.isLocked(105)).toBe(false);
  });

  test("adds 24 frames when no garbage was sent", () => {
    const ai = new OffsetOffAI(true);
    ai.setPrevAct(ACT_DOUBLE);
    ai.lockOffsetAfterClearing(50, 0, 2);
    expect(ai.gbData.coolTime).toBe(84);
  });

  test("does nothing when remainingTime is 0", () => {
    const ai = new OffsetOffAI(true);
    ai.lockOffsetAfterClearing(10, 0, 2);
    expect(ai.gbData.coolTime).toBe(0);
    expect(ai.gbData.firstInvalidLock).toBe(false);
    expect(ai.gbData.opponentsLockCount).toBe(0);
  });
});

describe("OffsetOffAI.OpponentIsNewLockDown / invalidation (IL 14045/14052/14064)", () => {
  test("reports change and stores the lock", () => {
    const ai = new OffsetOffAI(true);
    expect(ai.opponentIsNewLockDown(4)).toBe(true);
    expect(ai.opponentIsNewLockDown(4)).toBe(false);
    expect(ai.opponentIsNewLockDown(5)).toBe(true);
  });

  test("IsFirstInvalidLockDown is consuming", () => {
    const ai = new OffsetOffAI(true);
    ai.setPrevAct(ACT_QUAD);
    ai.lockOffsetAfterClearing(10, 1, 3);
    expect(ai.isFirstInvalidLockDown()).toBe(true);
    expect(ai.isFirstInvalidLockDown()).toBe(false);
  });

  test("InvalidateGettingEnemysAtk and ResetOpponentsAtk", () => {
    const ai = new OffsetOffAI(true);
    ai.calcOpponentsAtk(4, 1, 1, 0);
    expect(ai.getOpponentsAtk()).toBe(5);
    ai.invalidateGettingEnemysAtk();
    expect(ai.getOpponentsAtk()).toBe(-1);
    ai.resetOpponentsAtk();
    expect(ai.getOpponentsAtk()).toBe(0);
  });
});

describe("NextMino trust window feeds the pcChance bound", () => {
  test("fresh bag trustEnd is 3", () => {
    const nm = new NextMino();
    nm.viewNext = 2;
    nm.init([MINO_I, MINO_J]);
    expect(nm.trustEnd).toBe(3);
    expect(trustRange(nm.bagRemains)).toBe(2);
  });
});

describe("hoiko-native adapter wires OffsetOffAI into garbageWait", () => {
  // Position found by sweeping low random stacks: horizontal [I,S,...] with a
  // planned [None, Double] and center4Height 6, so CanOffsetOff(4) is true.
  const rows = [1019, 507, 499, 499, 355, 354, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  function snapshot(pendingGarbage: number): GameSnapshot {
    const grid: CellValue[][] = rows.map((r) =>
      Array.from({ length: 10 }, (_, x) => (((r >> (9 - x)) & 1) === 1 ? 1 : 0) as CellValue),
    );
    return {
      board: { cols: 10, rows: 20, grid: [...grid].reverse() },
      active: {
        kind: "I",
        rotation: 0,
        cells: [],
        posX: 3,
        posY: 18,
      },
      ghostY: 18,
      hold: null,
      canHold: true,
      next: ["S", "Z", "I", "I", "I", "L", "Z", "O", "O", "I"],
      score: 0,
      lines: 0,
      level: 1,
      gameOver: false,
      combo: -1,
      b2b: false,
      nativeCombo: 0,
      nativeBtb: 0,
      lockId: 1,
      lastAction: "None",
      lastRawAttack: 0,
      pendingGarbage,
      lastAttack: 0,
      lastBlocked: 0,
    };
  }

  test("returns garbageWait=true when the plan has a near clear and garbage >= 3", () => {
    const move = createHoikoNative({ weightPreset: "we", offset: true }).findBestMove(
      snapshot(4),
    );
    expect(move).not.toBeNull();
    expect(move?.garbageWait).toBe(true);
  });

  test("returns garbageWait=false when offset handling is disabled", () => {
    const move = createHoikoNative({ weightPreset: "we", offset: false }).findBestMove(
      snapshot(4),
    );
    expect(move).not.toBeNull();
    expect(move?.garbageWait ?? false).toBe(false);
  });

  test("returns garbageWait=false for trivial garbage (garbage <= 2, atk >= garbage)", () => {
    const move = createHoikoNative({ weightPreset: "we", offset: true }).findBestMove(
      snapshot(1),
    );
    expect(move).not.toBeNull();
    expect(move?.garbageWait ?? false).toBe(false);
  });
});
