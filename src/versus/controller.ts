import { createEngine, type EngineOptions } from "../core/engine.js";
import type {
  AiDebug,
  AiExecutionPlan,
  AiExecutionStep,
  AiMove,
  CorePort,
  GameSnapshot,
} from "../ui/types.js";

export type VersusSide = "left" | "right";

export interface VersusFighter {
  readonly name: string;
  readonly color: string;
  findBestMove(snapshot: GameSnapshot): AiMove | null;
  getDebug?(): AiDebug | null;
}

export interface SideState {
  readonly side: VersusSide;
  core: CorePort;
  fighter: VersusFighter;
  thinkMs: number;
  thinkCount: number;
  pendingThink: boolean;
  queue: AiStep[] | readonly AiStep[];
  execution: AiExecutionPlan | null;
  garbageWait: boolean;
  acc: number;
  gravityAcc: number;
  sentTotal: number;
  blockedTotal: number;
  processedLockId: number;
  executionSourceMismatches: number;
  executionExpectedBoardFailures: number;
  wins: number;
}

export type AiStep = AiExecutionStep;

export interface VersusResult {
  readonly winner: VersusSide | "draw";
  readonly reason: string;
  readonly pieces: number;
  readonly linesLeft: number;
  readonly linesRight: number;
  readonly sentLeft: number;
  readonly sentRight: number;
}

export interface VersusControllerOptions {
  readonly stepIntervalMs: number;
  readonly gravityMs: number;
  readonly autoRematchMs: number;
}

export const VERSUS_DEFAULTS: VersusControllerOptions = {
  stepIntervalMs: 120,
  gravityMs: 500,
  autoRematchMs: 2500,
};

export function planSteps(
  currentRotation: number,
  currentX: number,
  move: AiMove,
): readonly AiStep[] {
  if (!move.useHold && move.execution !== undefined) return move.execution.steps;
  const steps: AiStep[] = [];
  if (move.useHold) steps.push({ kind: "hold" });
  const targetRot = ((move.targetRotation % 4) + 4) % 4;
  const curRot = ((currentRotation % 4) + 4) % 4;
  const cw = (targetRot - curRot + 4) % 4;
  const ccw = (curRot - targetRot + 4) % 4;
  if (cw <= ccw) {
    for (let i = 0; i < cw; i += 1) steps.push({ kind: "rotateCW" });
  } else {
    for (let i = 0; i < ccw; i += 1) steps.push({ kind: "rotateCCW" });
  }
  const dx = move.targetX - currentX;
  if (dx < 0) {
    for (let i = 0; i < -dx; i += 1) steps.push({ kind: "left" });
  } else {
    for (let i = 0; i < dx; i += 1) steps.push({ kind: "right" });
  }
  steps.push({ kind: "drop" });
  return steps;
}

function think(side: SideState, opponent: SideState): void {
  const snap = side.core.getSnapshot();
  const opponentSnap = opponent.core.getSnapshot();
  const opponentTransition = opponent.core.getLastLockTransition();
  const a = snap.active;
  if (a === null || snap.gameOver) return;
  const decisionSnapshot: GameSnapshot = {
    ...snap,
    opponentCombo: opponentSnap.nativeCombo,
    opponentBtb: opponentSnap.nativeBtb,
    opponentLockId: opponentSnap.lockId,
    ...(opponentTransition === null
      ? {}
      : {
          opponentLastClearLines: opponentTransition.linesCleared,
          opponentLastNativeCombo: opponentTransition.nativeCombo,
          opponentLastNativeBtb: opponentTransition.nativeBtb,
          opponentLastRawAttack: opponentTransition.rawAttack,
        }),
  };
  const t0 = performance.now();
  let move: AiMove | null = null;
  try {
    move = side.fighter.findBestMove(decisionSnapshot);
  } catch {
    move = null;
  }
  side.thinkMs += performance.now() - t0;
  side.thinkCount += 1;
  if (move === null) {
    side.garbageWait = false;
    side.execution = null;
    side.queue = [{ kind: "drop" }];
    return;
  }
  side.garbageWait = move.garbageWait ?? false;
  if (move.useHold) {
    side.execution = null;
    side.queue = [{ kind: "hold" }];
    side.pendingThink = true;
    return;
  }
  if (move.execution !== undefined && !executionMatches(snap, move.execution)) {
    side.executionSourceMismatches += 1;
    side.execution = null;
    side.queue = [{ kind: "drop" }];
    return;
  }
  side.execution = move.execution ?? null;
  side.queue = planSteps(a.rotation, a.posX, move);
}

function boardMatches(actual: readonly number[], expected: readonly number[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

function boardFingerprint(snapshot: GameSnapshot): string {
  const rows: number[] = [];
  for (let y = 0; y < snapshot.board.rows; y += 1) {
    const row = snapshot.board.grid[snapshot.board.rows - 1 - y];
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((row?.[x] ?? 0) !== 0) bits |= 1 << x;
    }
    rows.push(bits);
  }
  return rows.join(",");
}

function executionMatches(snapshot: GameSnapshot, execution: AiExecutionPlan): boolean {
  const active = snapshot.active;
  return (
    active !== null &&
    active.kind === execution.sourceActiveKind &&
    active.rotation === execution.sourceRotation &&
    active.posX === execution.sourceX &&
    snapshot.hold === execution.sourceHold &&
    snapshot.canHold === execution.sourceCanHold &&
    boardFingerprint(snapshot) === execution.sourceBoardFingerprint
  );
}

type ApplyStepResult = { readonly kind: "applied" } | { readonly kind: "expected-board-failure" };

function locksPiece(kind: AiStep["kind"]): boolean {
  return kind === "drop" || kind === "placeAt";
}

function applyStep(
  core: CorePort,
  step: AiStep,
  execution: AiExecutionPlan | null,
): ApplyStepResult {
  switch (step.kind) {
    case "hold":
      core.hold();
      return { kind: "applied" };
    case "rotateCW":
      core.rotateCW();
      return { kind: "applied" };
    case "rotateCCW":
      core.rotateCCW();
      return { kind: "applied" };
    case "left":
      core.moveLeft();
      return { kind: "applied" };
    case "right":
      core.moveRight();
      return { kind: "applied" };
    case "softDrop":
      core.softDrop();
      return { kind: "applied" };
    case "drop": {
      core.hardDrop();
      if (execution === null) return { kind: "applied" };
      const transition = core.getLastLockTransition();
      return transition !== null &&
        boardMatches(transition.boardAfterLockClear, execution.expectedBoard) &&
        transition.linesCleared === execution.expectedLinesCleared
        ? { kind: "applied" }
        : { kind: "expected-board-failure" };
    }
    case "placeAt": {
      const placed =
        step.topRow !== undefined && core.placeMinoAt !== undefined
          ? core.placeMinoAt(step.rotation, step.x, step.topRow, step.lastSrs ?? 0)
          : (core.hardDropAt?.(step.rotation, step.x) ?? false);
      if (!placed) core.hardDrop();
      return { kind: "applied" };
    }
  }
}

export interface VersusController {
  readonly left: SideState;
  readonly right: SideState;
  pieces: number;
  result: VersusResult | null;
  rematchIn: number | null;
  tick(dt: number, options: VersusControllerOptions): void;
  resetMatch(seed: number): void;
}

export interface VersusControllerConfig {
  /** Locks pending garbage waits before spawning (engine `garbageDelay`). */
  readonly garbageDelay?: number | undefined;
  /** Share one hole column across all rows of a garbage chunk (engine `garbageAligned`). */
  readonly garbageAligned?: boolean | undefined;
}

export function createVersusController(
  leftFighter: VersusFighter,
  rightFighter: VersusFighter,
  seed: number,
  config: VersusControllerConfig = {},
): VersusController {
  const engineOptions: EngineOptions = {
    ...(config.garbageDelay === undefined ? {} : { garbageDelay: config.garbageDelay }),
    ...(config.garbageAligned === undefined ? {} : { garbageAligned: config.garbageAligned }),
  };
  const mkSide = (side: VersusSide, fighter: VersusFighter): SideState => ({
    side,
    core: createEngine({ random: seededRandom(seed), ...engineOptions }),
    fighter,
    thinkMs: 0,
    thinkCount: 0,
    pendingThink: true,
    queue: [],
    acc: 0,
    execution: null,
    garbageWait: false,
    gravityAcc: 0,
    sentTotal: 0,
    blockedTotal: 0,
    processedLockId: 0,
    executionSourceMismatches: 0,
    executionExpectedBoardFailures: 0,
    wins: 0,
  });
  const left = mkSide("left", leftFighter);
  const right = mkSide("right", rightFighter);
  const ctrl: VersusController = {
    left,
    right,
    pieces: 0,
    result: null,
    rematchIn: null,
    tick(dt: number, options: VersusControllerOptions): void {
      tickVersus(ctrl, dt, options);
    },
    resetMatch(nextSeed: number): void {
      resetSide(left, nextSeed, engineOptions);
      resetSide(right, nextSeed, engineOptions);
      ctrl.pieces = 0;
      ctrl.result = null;
      ctrl.rematchIn = null;
    },
  };
  return ctrl;
}

function resetSide(side: SideState, seed: number, engineOptions: EngineOptions = {}): void {
  side.core = createEngine({ random: seededRandom(seed), ...engineOptions });
  side.thinkMs = 0;
  side.thinkCount = 0;
  side.pendingThink = true;
  side.queue = [];
  side.execution = null;
  side.garbageWait = false;
  side.acc = 0;
  side.gravityAcc = 0;
  side.sentTotal = 0;
  side.blockedTotal = 0;
  side.processedLockId = 0;
  side.executionSourceMismatches = 0;
  side.executionExpectedBoardFailures = 0;
}

function seededRandom(seed: number): () => number {
  let s = seed < 0 ? -seed : seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function stepSide(
  side: SideState,
  opponent: SideState,
  dt: number,
  options: VersusControllerOptions,
): number {
  const snap = side.core.getSnapshot();
  if (snap.gameOver) return 0;
  const hadActive = snap.active !== null;
  if (side.pendingThink && side.queue.length === 0 && snap.active !== null) {
    side.pendingThink = false;
    think(side, opponent);
  }
  side.acc += dt;
  if (side.queue.length > 0 && side.acc >= options.stepIntervalMs) {
    side.acc = 0;
    const [head, ...rest] = side.queue;
    if (head !== undefined) {
      if (locksPiece(head.kind)) side.core.setGarbageWait?.(side.garbageWait);
      const stepResult = applyStep(side.core, head, side.execution);
      switch (stepResult.kind) {
        case "applied":
          break;
        case "expected-board-failure":
          side.executionExpectedBoardFailures += 1;
          side.execution = null;
          side.queue = [];
          side.pendingThink = true;
          return 0;
      }
      if (locksPiece(head.kind) || head.kind === "hold") {
        side.pendingThink = side.queue.length <= 1;
      }
      if (locksPiece(head.kind)) side.execution = null;
      if (locksPiece(head.kind)) {
        side.garbageWait = false;
        side.core.setGarbageWait?.(false);
      }
    }
    side.queue = rest;
    const lockedPiece = head !== undefined && locksPiece(head.kind) && hadActive;
    return lockedPiece ? 1 : 0;
  } else if (side.queue.length === 0) {
    side.gravityAcc = (side.gravityAcc ?? 0) + dt;
    if (side.gravityAcc >= options.gravityMs) {
      side.gravityAcc = 0;
      const locked = side.core.gravityTick();
      if (locked) {
        side.pendingThink = true;
        return 1;
      }
    }
    return 0;
  }
  return 0;
}

function exchangeGarbage(left: SideState, right: SideState): void {
  const outL = left.core.drainOutbox?.() ?? 0;
  const outR = right.core.drainOutbox?.() ?? 0;
  if (outL > 0) {
    right.core.receiveGarbage?.(outL);
    left.sentTotal += outL;
  }
  if (outR > 0) {
    left.core.receiveGarbage?.(outR);
    right.sentTotal += outR;
  }
  const snapL = left.core.getSnapshot();
  const snapR = right.core.getSnapshot();
  if (snapL.lockId !== left.processedLockId) {
    left.blockedTotal += snapL.lastBlocked;
    left.processedLockId = snapL.lockId;
  }
  if (snapR.lockId !== right.processedLockId) {
    right.blockedTotal += snapR.lastBlocked;
    right.processedLockId = snapR.lockId;
  }
}

function tickVersus(ctrl: VersusController, dt: number, options: VersusControllerOptions): void {
  if (ctrl.result !== null) {
    if (ctrl.rematchIn === null) {
      ctrl.rematchIn = options.autoRematchMs;
    } else {
      ctrl.rematchIn -= dt;
      if (ctrl.rematchIn <= 0) {
        const seed = (Date.now() ^ (Math.random() * 1e9)) | 0;
        ctrl.resetMatch(seed);
      }
    }
    return;
  }
  const lockedL = stepSide(ctrl.left, ctrl.right, dt, options);
  const lockedR = stepSide(ctrl.right, ctrl.left, dt, options);
  exchangeGarbage(ctrl.left, ctrl.right);
  ctrl.pieces += lockedL + lockedR;
  const snapL = ctrl.left.core.getSnapshot();
  const snapR = ctrl.right.core.getSnapshot();
  const executionInFlight =
    (ctrl.left.execution !== null && ctrl.left.queue.length > 0 && !snapL.gameOver) ||
    (ctrl.right.execution !== null && ctrl.right.queue.length > 0 && !snapR.gameOver);
  if ((snapL.gameOver || snapR.gameOver) && !executionInFlight) {
    let winner: VersusSide | "draw";
    let reason: string;
    if (snapL.gameOver && snapR.gameOver) {
      winner = "draw";
      reason = "同時死亡";
    } else if (snapR.gameOver) {
      winner = "left";
      reason = "KO";
    } else {
      winner = "right";
      reason = "KO";
    }
    if (winner === "left") ctrl.left.wins += 1;
    if (winner === "right") ctrl.right.wins += 1;
    ctrl.result = {
      winner,
      reason,
      pieces: ctrl.pieces,
      linesLeft: snapL.lines,
      linesRight: snapR.lines,
      sentLeft: ctrl.left.sentTotal,
      sentRight: ctrl.right.sentTotal,
    };
    ctrl.rematchIn = options.autoRematchMs;
    return;
  }
}
