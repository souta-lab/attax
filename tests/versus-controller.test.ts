import { describe, expect, test } from "bun:test";
import { type CellValue, COLS, type CorePort, type GameSnapshot, ROWS } from "../src/ui/types.js";
import {
  type AiStep,
  boardFingerprint,
  type SideState,
  tickVersus,
  type VersusController,
  type VersusControllerOptions,
  type VersusFighter,
} from "../src/versus/controller.js";

interface Counter {
  steps: number;
  locks: number;
  gravity: number;
}

const OPTIONS: VersusControllerOptions = {
  stepIntervalMs: 120,
  gravityMs: 500,
  autoRematchMs: 2500,
};

function emptyGrid(): CellValue[][] {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, (): CellValue => 0));
}

function makeSnapshot(
  active: boolean,
  grid: CellValue[][],
  lockId = 0,
  gameOver = false,
): GameSnapshot {
  return {
    board: { cols: COLS, rows: ROWS, grid },
    active: active ? { kind: "T", rotation: 0, cells: [], posX: 0, posY: 0 } : null,
    ghostY: null,
    hold: null,
    canHold: true,
    next: [],
    score: 0,
    lines: 0,
    level: 0,
    gameOver,
    combo: 0,
    b2b: false,
    nativeCombo: 0,
    nativeBtb: 0,
    lockId,
    lastAction: "None",
    lastRawAttack: 0,
    pendingGarbage: 0,
    lastAttack: 0,
    lastBlocked: 0,
  };
}

function makeCore(
  counter: Counter,
  active: boolean,
  grid: CellValue[][] = emptyGrid(),
  isGameOver: () => boolean = () => false,
): CorePort {
  return {
    getSnapshot: () => makeSnapshot(active, grid, 0, isGameOver()),
    getLastLockTransition: () => null,
    moveLeft: () => {
      counter.steps += 1;
    },
    moveRight: () => {
      counter.steps += 1;
    },
    softDrop: () => {
      counter.steps += 1;
    },
    rotateCW: () => {
      counter.steps += 1;
    },
    rotateCCW: () => {
      counter.steps += 1;
    },
    hardDrop: () => {
      counter.steps += 1;
      counter.locks += 1;
    },
    placeMinoAt: () => {
      counter.steps += 1;
      counter.locks += 1;
      return true;
    },
    hold: () => {
      counter.steps += 1;
    },
    gravityTick: () => {
      counter.gravity += 1;
      return false;
    },
    reset: () => {},
  };
}

const idleFighter: VersusFighter = {
  name: "idle",
  color: "#000",
  findBestMove: () => null,
};

const longMoveFighter: VersusFighter = {
  name: "long-move",
  color: "#000",
  findBestMove: (snapshot) =>
    snapshot.active === null ? null : { targetX: 5000, targetRotation: 0, useHold: false },
};

const immediateDropFighter: VersusFighter = {
  name: "immediate-drop",
  color: "#000",
  findBestMove: (snapshot) =>
    snapshot.active === null ? null : { targetX: 0, targetRotation: 0, useHold: false },
};

function executionPlanFighter(prefix: readonly AiStep[]): VersusFighter {
  return {
    name: `execution-plan-${prefix.length}`,
    color: "#000",
    findBestMove: (snapshot) => {
      if (snapshot.active === null) return null;
      const terminal: AiStep = { kind: "placeAt", rotation: 0, x: 0, topRow: 0, lastSrs: 0 };
      return {
        targetX: 0,
        targetRotation: 0,
        useHold: false,
        execution: {
          targetX: 0,
          targetRotation: 0,
          steps: [...prefix, terminal],
          expectedBoard: [],
          expectedLinesCleared: 0,
          sourceActiveKind: snapshot.active.kind,
          sourceRotation: snapshot.active.rotation,
          sourceX: snapshot.active.posX,
          sourceBoardFingerprint: boardFingerprint(snapshot),
          sourceHold: snapshot.hold,
          sourceCanHold: snapshot.canHold,
        },
      };
    },
  };
}

function makeSide(
  side: "left" | "right",
  core: CorePort,
  fighter: VersusFighter,
  overrides: Partial<SideState> = {},
): SideState {
  return {
    side,
    core,
    fighter,
    thinkMs: 0,
    thinkCount: 0,
    pendingThink: true,
    queue: [],
    execution: null,
    garbageWait: false,
    acc: 0,
    gravityAcc: 0,
    sentTotal: 0,
    blockedTotal: 0,
    processedLockId: 0,
    executionSourceMismatches: 0,
    executionExpectedBoardFailures: 0,
    lastError: null,
    errorCount: 0,
    wins: 0,
    ...overrides,
  };
}

function makeController(left: SideState, right: SideState): VersusController {
  const ctrl: VersusController = {
    left,
    right,
    pieces: 0,
    result: null,
    rematchIn: null,
    tick: (dt, options) => {
      tickVersus(ctrl, dt, options);
    },
    resetMatch: () => {},
  };
  return ctrl;
}

function runLocks(dts: readonly number[]): number {
  const counter: Counter = { steps: 0, locks: 0, gravity: 0 };
  const left = makeSide("left", makeCore(counter, true), immediateDropFighter);
  const right = makeSide("right", makeCore(counter, true), immediateDropFighter);
  const ctrl = makeController(left, right);
  for (const dt of dts) tickVersus(ctrl, dt, OPTIONS);
  return counter.locks;
}

function runGravityDrops(dts: readonly number[]): number {
  const counter: Counter = { steps: 0, locks: 0, gravity: 0 };
  const left = makeSide("left", makeCore(counter, false), idleFighter, { pendingThink: false });
  const right = makeSide("right", makeCore(counter, false), idleFighter, { pendingThink: false });
  const ctrl = makeController(left, right);
  for (const dt of dts) tickVersus(ctrl, dt, OPTIONS);
  return counter.gravity;
}

function irregularDts(total: number): number[] {
  const pattern = [16, 200, 37];
  const dts: number[] = [];
  let elapsed = 0;
  let index = 0;
  while (elapsed < total) {
    const dt = pattern[index % pattern.length] ?? 16;
    dts.push(dt);
    elapsed += dt;
    index += 1;
  }
  return dts;
}

describe("versus controller accumulator", () => {
  test("irregular dt locks the same number of pieces as uniform small ticks", () => {
    const total = 2530;
    const irregular = irregularDts(total);
    const irregularTotal = irregular.reduce((sum, dt) => sum + dt, 0);
    const uniform = new Array<number>(irregularTotal).fill(1);

    expect(irregularTotal).toBe(total);
    expect(runLocks(irregular)).toBe(runLocks(uniform));
    expect(runLocks(irregular)).toBe(2 * Math.floor(total / OPTIONS.stepIntervalMs));
  });

  test("irregular dt drops gravity the same number of times as uniform small ticks", () => {
    const total = 2530;
    const irregular = irregularDts(total);
    const irregularTotal = irregular.reduce((sum, dt) => sum + dt, 0);
    const uniform = new Array<number>(irregularTotal).fill(1);

    expect(runGravityDrops(irregular)).toBe(runGravityDrops(uniform));
    expect(runGravityDrops(irregular)).toBe(2 * Math.floor(total / OPTIONS.gravityMs));
  });

  test("step accumulator keeps the leftover instead of dropping it", () => {
    const counter: Counter = { steps: 0, locks: 0, gravity: 0 };
    const left = makeSide("left", makeCore(counter, true), immediateDropFighter);
    const right = makeSide("right", makeCore(counter, true), immediateDropFighter);
    const ctrl = makeController(left, right);

    tickVersus(ctrl, 200, OPTIONS);

    expect(left.acc).toBe(200 - OPTIONS.stepIntervalMs);
    expect(right.acc).toBe(200 - OPTIONS.stepIntervalMs);
  });

  test("gravity accumulator keeps the leftover instead of dropping it", () => {
    const counter: Counter = { steps: 0, locks: 0, gravity: 0 };
    const options = { ...OPTIONS, gravityMs: 100 };
    const left = makeSide("left", makeCore(counter, false), idleFighter, { pendingThink: false });
    const right = makeSide("right", makeCore(counter, false), idleFighter, { pendingThink: false });
    const ctrl = makeController(left, right);

    tickVersus(ctrl, 250, options);

    expect(counter.gravity).toBe(4);
    expect(left.gravityAcc).toBe(50);
    expect(right.gravityAcc).toBe(50);
  });
});

describe("versus controller lock fairness (issue #24)", () => {
  test("cosmetic execution steps do not delay locks relative to a bare placeAt", () => {
    const bareCounter: Counter = { steps: 0, locks: 0, gravity: 0 };
    const cosmeticCounter: Counter = { steps: 0, locks: 0, gravity: 0 };
    const bare = makeSide("left", makeCore(bareCounter, true), executionPlanFighter([]));
    const cosmetic = makeSide(
      "right",
      makeCore(cosmeticCounter, true),
      executionPlanFighter([{ kind: "left" }, { kind: "left" }]),
    );
    const ctrl = makeController(bare, cosmetic);

    const ticks = 8;
    for (let tick = 1; tick <= ticks; tick += 1) {
      tickVersus(ctrl, OPTIONS.stepIntervalMs, OPTIONS);
      expect(bareCounter.locks).toBe(tick);
      expect(cosmeticCounter.locks).toBe(tick);
    }

    expect(bareCounter.steps).toBe(ticks);
    expect(cosmeticCounter.steps).toBe(3 * ticks);
  });
});

describe("versus controller AI failures", () => {
  test("throwing fighter is surfaced and never crashes the loop", () => {
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const counter: Counter = { steps: 0, locks: 0, gravity: 0 };
      const throwing: VersusFighter = {
        name: "throwing",
        color: "#f00",
        findBestMove: () => {
          throw new Error("AI exploded");
        },
      };
      const left = makeSide("left", makeCore(counter, true), throwing);
      const right = makeSide("right", makeCore(counter, true), longMoveFighter);
      const ctrl = makeController(left, right);

      tickVersus(ctrl, 16, OPTIONS);

      expect(left.lastError).toBe("AI exploded");
      expect(left.errorCount).toBe(1);
      expect(logged.length).toBe(1);
      expect(left.queue).toEqual([{ kind: "drop" }]);
      expect(ctrl.result).toBeNull();

      for (let i = 0; i < 20; i += 1) tickVersus(ctrl, 16, OPTIONS);

      expect(left.errorCount).toBeGreaterThan(1);
      expect(logged.length).toBe(1);
      expect(left.lastError).toBe("AI exploded");
      expect(ctrl.result).toBeNull();
      expect(right.thinkCount).toBe(1);
    } finally {
      console.error = originalError;
    }
  });

  test("match result exposes the captured side errors", () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const counter: Counter = { steps: 0, locks: 0, gravity: 0 };
      const throwing: VersusFighter = {
        name: "throwing",
        color: "#f00",
        findBestMove: () => {
          throw new Error("boom");
        },
      };
      let over = false;
      const grid = emptyGrid();
      const left = makeSide(
        "left",
        makeCore(counter, true, grid, () => over),
        throwing,
      );
      const right = makeSide(
        "right",
        makeCore(counter, true, grid, () => over),
        longMoveFighter,
      );
      const ctrl = makeController(left, right);

      tickVersus(ctrl, 16, OPTIONS);
      over = true;
      tickVersus(ctrl, 16, OPTIONS);

      expect(ctrl.result?.leftError).toBe("boom");
      expect(ctrl.result?.rightError).toBeNull();
    } finally {
      console.error = originalError;
    }
  });
});

describe("boardFingerprint", () => {
  test("covers the last column via COLS", () => {
    const grid = emptyGrid();
    const bottom = grid[ROWS - 1];
    expect(bottom).toBeDefined();
    if (bottom === undefined) return;
    bottom[COLS - 1] = 1;

    const rows = boardFingerprint(makeSnapshot(true, grid)).split(",").map(Number);

    expect(rows[0]).toBe(1 << (COLS - 1));
  });

  test("encodes an empty board as zero rows", () => {
    const rows = boardFingerprint(makeSnapshot(true, emptyGrid())).split(",").map(Number);

    expect(rows).toEqual(new Array<number>(ROWS).fill(0));
  });
});
