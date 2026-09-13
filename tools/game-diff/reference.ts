/**
 * Differential fixture generator for the native game core (Phase 1).
 *
 *   bun tools/game-diff/reference.ts
 *
 * Runs the TypeScript reference (`src/core/engine.ts`, `src/versus/controller.ts`,
 * the Hoiko input-contract helpers) over deterministic scripts and writes JSON
 * fixtures to `evidence/native-app/`. `rust/game/tests/differential*.rs` replays
 * the recorded operations/decisions and asserts identical boards, transitions,
 * garbage and match results.
 *
 * The fixtures are committed evidence: regenerating them is how a TS behavior
 * change is surfaced against the Rust port.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import {
  FAITHFUL_HOIKO,
  type FaithfulHoikoEnv,
  resolveFaithfulHoikoOptions,
} from "../../src/ai/hoiko-faithful.js";
import { NEXT_SIZE, NextState, trustRange } from "../../src/ai/hoiko-next.js";
import {
  boardToNativeRows,
  opponentIsPCBoard,
  opponentIsPowerfulBoard,
} from "../../src/ai/hoiko-opponent.js";
import type { HoikoPreset } from "../../src/ai/hoiko-weights.js";
import { createEngine } from "../../src/core/engine.js";
import { cellsFor } from "../../src/core/pieces.js";
import type { AiMove, BoardView, CellValue, PieceKind } from "../../src/ui/types.js";
import { COLS, ROWS } from "../../src/ui/types.js";
import { resolveVersusConfig } from "../../src/versus/config.js";
import {
  boardFingerprint,
  createVersusController,
  seededRandom,
  VERSUS_DEFAULTS,
  type VersusController,
  type VersusFighter,
} from "../../src/versus/controller.js";

const EVIDENCE = new URL("../../evidence/native-app/", import.meta.url);
mkdirSync(EVIDENCE, { recursive: true });

const write = (name: string, value: unknown): void => {
  writeFileSync(new URL(name, EVIDENCE), `${JSON.stringify(value)}\n`);
  console.log(`wrote evidence/native-app/${name}`);
};

// ---------------------------------------------------------------------------
// Deterministic script RNG (drives op selection; the Rust replay is fully
// mechanical because every resolved argument/decision is recorded).
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 2147483648;
  };
}

function gridFingerprint(grid: readonly (readonly CellValue[])[]): string {
  const rows: number[] = [];
  for (let y = grid.length - 1; y >= 0; y -= 1) {
    const row = grid[y];
    let bits = 0;
    for (let x = 0; x < COLS; x += 1) if ((row?.[x] ?? 0) !== 0) bits |= 1 << x;
    rows.push(bits);
  }
  return rows.join(",");
}

// ---------------------------------------------------------------------------
// Greedy placement solver (TS-side only; the resolved arguments/decisions are
// recorded, so the Rust side never re-derives a decision).
// ---------------------------------------------------------------------------

interface Placement {
  readonly rotation: number;
  readonly x: number;
  readonly topRow: number;
  readonly score: number;
}

function landingRow(
  grid: readonly (readonly CellValue[])[],
  kind: PieceKind,
  rotation: number,
  x: number,
): number | null {
  const cells = cellsFor(kind, rotation);
  let y = -4;
  for (;;) {
    const next = y + 1;
    let blocked = false;
    for (const c of cells) {
      const cx = x + c.x;
      const cy = next + c.y;
      if (cx < 0 || cx >= COLS || cy >= ROWS) {
        blocked = true;
        break;
      }
      if (cy >= 0 && (grid[cy]?.[cx] ?? 0) !== 0) {
        blocked = true;
        break;
      }
    }
    if (blocked) break;
    y = next;
  }
  for (const c of cells) {
    const cx = x + c.x;
    const cy = y + c.y;
    if (cx < 0 || cx >= COLS || cy >= ROWS) return null;
    if (cy >= 0 && (grid[cy]?.[cx] ?? 0) !== 0) return null;
  }
  return y;
}

function scorePlacement(
  grid: readonly (readonly CellValue[])[],
  kind: PieceKind,
  rotation: number,
  x: number,
  y: number,
): number {
  const rows = grid.map((row) => [...row]);
  for (const c of cellsFor(kind, rotation)) {
    const cy = y + c.y;
    const cx = x + c.x;
    if (cy < 0) continue;
    const row = rows[cy];
    if (row === undefined) continue;
    row[cx] = 1;
  }
  let clears = 0;
  for (const row of rows) if (row.every((v) => v !== 0)) clears += 1;
  const kept = rows.filter((row) => !row.every((v) => v !== 0));
  while (kept.length < ROWS) kept.unshift(Array.from({ length: COLS }, () => 0 as CellValue));
  let holes = 0;
  let aggregate = 0;
  let maxHeight = 0;
  const heights: number[] = [];
  for (let col = 0; col < COLS; col += 1) {
    let seen = false;
    let height = 0;
    for (let yy = 0; yy < ROWS; yy += 1) {
      if ((kept[yy]?.[col] ?? 0) !== 0) {
        if (!seen) {
          seen = true;
          height = ROWS - yy;
        }
      } else if (seen) {
        holes += 1;
      }
    }
    heights.push(height);
    aggregate += height;
    maxHeight = Math.max(maxHeight, height);
  }
  let bumpiness = 0;
  for (let col = 0; col + 1 < COLS; col += 1) {
    bumpiness += Math.abs((heights[col] ?? 0) - (heights[col + 1] ?? 0));
  }
  return clears * 1000 - holes * 12 - aggregate * 0.8 - maxHeight * 4 - bumpiness * 1.5;
}

function choosePlacement(
  grid: readonly (readonly CellValue[])[],
  kind: PieceKind,
  tieBias: number,
): Placement | null {
  let best: Placement | null = null;
  for (let rotation = 0; rotation < 4; rotation += 1) {
    const cells = cellsFor(kind, rotation);
    const maxX = Math.max(...cells.map((c) => c.x));
    for (let x = 0; x + maxX < COLS; x += 1) {
      const topRow = landingRow(grid, kind, rotation, x);
      if (topRow === null) continue;
      const score = scorePlacement(grid, kind, rotation, x, topRow) + (x === tieBias ? 0.01 : 0);
      if (best === null || score > best.score) best = { rotation, x, topRow, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Engine differential: recorded ops (move/drop/hold/garbage/place) + chaos.
// ---------------------------------------------------------------------------

interface SnapshotRecord {
  readonly over: boolean;
  readonly lock: number;
  readonly kind: string | null;
  readonly rot: number;
  readonly x: number;
  readonly y: number;
  readonly ghost: number | null;
  readonly hold: string | null;
  readonly canHold: boolean;
  readonly pending: number;
  readonly lines: number;
  readonly combo: number;
  readonly nCombo: number;
  readonly nBtb: number;
  readonly b2b: boolean;
  readonly score: number;
  readonly act: string;
  readonly raw: number;
  readonly blocked: number;
  readonly attack: number;
  readonly board: string;
  readonly next: string;
}

function recordEngineSnapshot(engine: ReturnType<typeof createEngine>): SnapshotRecord {
  const s = engine.getSnapshot();
  return {
    over: s.gameOver,
    lock: s.lockId,
    kind: s.active?.kind ?? null,
    rot: s.active?.rotation ?? 0,
    x: s.active?.posX ?? 0,
    y: s.active?.posY ?? 0,
    ghost: s.ghostY,
    hold: s.hold,
    canHold: s.canHold,
    pending: s.pendingGarbage,
    lines: s.lines,
    combo: s.combo,
    nCombo: s.nativeCombo,
    nBtb: s.nativeBtb,
    b2b: s.b2b,
    score: s.score,
    act: s.lastAction,
    raw: s.lastRawAttack,
    blocked: s.lastBlocked,
    attack: s.lastAttack,
    board: gridFingerprint(s.board.grid),
    next: s.next.slice(0, 5).join(","),
  };
}

interface EngineOp {
  readonly op: string;
  readonly rotation?: number;
  readonly x?: number;
  readonly topRow?: number;
  readonly lastSrs?: number;
  readonly rows?: number;
  readonly wait?: boolean;
  readonly drained?: number;
  readonly expect: SnapshotRecord;
  readonly transition?: {
    readonly board: string;
    readonly lines: number;
    readonly garbage: number;
    readonly act: string;
    readonly nCombo: number;
    readonly nBtb: number;
    readonly raw: number;
    readonly sent: number;
    readonly lock: number;
  };
}

function engineTrace(seed: number, garbageAligned: boolean, opCount: number, chaos: boolean) {
  const engine = createEngine({ random: seededRandom(seed), garbageAligned });
  const rnd = lcg(seed ^ 0x5f3759df);
  const ops: EngineOp[] = [];
  let lastLockId = engine.getSnapshot().lockId;

  const chaosOp = (): Omit<EngineOp, "expect" | "transition"> => {
    const snap = engine.getSnapshot();
    const roll = rnd();
    if (roll < 0.4) {
      const rotation = Math.floor(rnd() * 4);
      const x = (snap.active?.posX ?? 3) + Math.floor(rnd() * 5) - 2;
      const topRow = (snap.active?.posY ?? 0) + Math.floor(rnd() * 7) - 3;
      const lastSrs = Math.floor(rnd() * 6);
      engine.placeMinoAt?.(rotation, x, topRow, lastSrs);
      return { op: "placeMinoAt", rotation, x, topRow, lastSrs };
    }
    if (roll < 0.7) {
      const rotation = Math.floor(rnd() * 4);
      const x = (snap.active?.posX ?? 3) + Math.floor(rnd() * 7) - 3;
      engine.hardDropAt?.(rotation, x);
      return { op: "hardDropAt", rotation, x };
    }
    engine.hardDrop();
    return { op: "hardDrop" };
  };

  const greedyOp = (): Omit<EngineOp, "expect" | "transition"> => {
    const snap = engine.getSnapshot();
    const active = snap.active;
    if (active !== null) {
      const placement = choosePlacement(snap.board.grid, active.kind, snap.lockId % COLS);
      if (placement !== null) {
        engine.placeMinoAt?.(placement.rotation, placement.x, placement.topRow, 0);
        return {
          op: "placeMinoAt",
          rotation: placement.rotation,
          x: placement.x,
          topRow: placement.topRow,
          lastSrs: 0,
        };
      }
    }
    engine.hardDrop();
    return { op: "hardDrop" };
  };

  for (let i = 0; i < opCount; i += 1) {
    const roll = rnd();
    let opRecord: Omit<EngineOp, "expect" | "transition">;
    if (chaos) {
      opRecord = chaosOp();
    } else if (roll < 0.62) {
      opRecord = greedyOp();
    } else if (roll < 0.68) {
      engine.hold();
      opRecord = { op: "hold" };
    } else if (roll < 0.74) {
      const rows = 1 + Math.floor(rnd() * 3);
      engine.receiveGarbage(rows);
      opRecord = { op: "receiveGarbage", rows };
    } else if (roll < 0.8) {
      engine.setGarbageWait(true);
      opRecord = { op: "setGarbageWait", wait: true };
    } else if (roll < 0.85) {
      engine.rotateCW();
      opRecord = { op: "rotateCW" };
    } else if (roll < 0.9) {
      if (rnd() < 0.5) {
        engine.moveLeft();
        opRecord = { op: "moveLeft" };
      } else {
        engine.moveRight();
        opRecord = { op: "moveRight" };
      }
    } else if (roll < 0.94) {
      engine.softDrop();
      opRecord = { op: "softDrop" };
    } else if (roll < 0.97) {
      engine.gravityTick();
      opRecord = { op: "gravityTick" };
    } else {
      const drained = engine.drainOutbox();
      opRecord = { op: "drainOutbox", drained };
    }
    const expect = recordEngineSnapshot(engine);
    const transition = engine.getLastLockTransition();
    ops.push({
      ...opRecord,
      expect,
      ...(transition !== null && transition.lockId !== lastLockId
        ? {
            transition: {
              board: transition.boardAfterLockClear.join(","),
              lines: transition.linesCleared,
              garbage: transition.garbageRowsApplied,
              act: transition.action,
              nCombo: transition.nativeCombo,
              nBtb: transition.nativeBtb,
              raw: transition.rawAttack,
              sent: transition.sentAttack,
              lock: transition.lockId,
            },
          }
        : {}),
    });
    lastLockId = expect.lock;
  }
  return { seed, garbageAligned, garbageDelay: 1, chaos, ops };
}

function engineFile(garbageAligned: boolean) {
  return {
    meta: {
      generatedBy: "tools/game-diff/reference.ts",
      reference: "src/core/engine.ts",
      kind: "engine",
    },
    traces: [
      ...[1, 7, 12345].map((seed) => engineTrace(seed, garbageAligned, 360, false)),
      engineTrace(99, garbageAligned, 160, true),
    ],
  };
}

write("engine-aligned.json", engineFile(true));
write("engine-per-row.json", engineFile(false));

// ---------------------------------------------------------------------------
// Versus differential: the greedy fighter's decisions are recorded per AI call
// and replayed by index in Rust (no decision logic to mirror).
// ---------------------------------------------------------------------------

interface RecordedDecision {
  readonly call: number;
  readonly lock: number;
  readonly useHold: boolean;
  readonly fallback: boolean;
  readonly x: number;
  readonly rotation: number;
  readonly topRow: number;
  readonly lastSrs: number;
  readonly garbageWait: boolean;
}

function recordingFighter(sideOffset: number, decisions: RecordedDecision[]): VersusFighter {
  return {
    name: `greedy-${sideOffset}`,
    color: "#000",
    findBestMove: (snapshot): AiMove | null => {
      if (snapshot.active === null || snapshot.gameOver) return null;
      const call = decisions.length;
      const lock = snapshot.lockId;
      const garbageWait = (lock + sideOffset) % 17 === 4;
      if (snapshot.canHold && snapshot.hold === null && (lock + sideOffset) % 23 === 7) {
        decisions.push({
          call,
          lock,
          useHold: true,
          fallback: false,
          x: 0,
          rotation: 0,
          topRow: 0,
          lastSrs: 0,
          garbageWait,
        });
        return { targetX: 0, targetRotation: 0, useHold: true, garbageWait };
      }
      const placement = choosePlacement(snapshot.board.grid, snapshot.active.kind, sideOffset);
      if (placement === null) {
        decisions.push({
          call,
          lock,
          useHold: false,
          fallback: true,
          x: 3,
          rotation: 0,
          topRow: 0,
          lastSrs: 0,
          garbageWait,
        });
        return { targetX: 3, targetRotation: 0, useHold: false, garbageWait };
      }
      decisions.push({
        call,
        lock,
        useHold: false,
        fallback: false,
        x: placement.x,
        rotation: placement.rotation,
        topRow: placement.topRow,
        lastSrs: 0,
        garbageWait,
      });
      return {
        targetX: placement.x,
        targetRotation: placement.rotation,
        useHold: false,
        garbageWait,
        execution: {
          targetX: placement.x,
          targetRotation: placement.rotation,
          steps: [
            {
              kind: "placeAt",
              rotation: placement.rotation,
              x: placement.x,
              topRow: placement.topRow,
              lastSrs: 0,
            },
          ],
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

interface SideRecord {
  readonly lock: number;
  readonly over: boolean;
  readonly lines: number;
  readonly pending: number;
  readonly sent: number;
  readonly blocked: number;
  readonly board: string;
  readonly act: string;
}

function recordSide(ctrl: VersusController, side: "left" | "right"): SideRecord {
  const state = side === "left" ? ctrl.left : ctrl.right;
  const s = state.core.getSnapshot();
  return {
    lock: s.lockId,
    over: s.gameOver,
    lines: s.lines,
    pending: s.pendingGarbage,
    sent: state.sentTotal,
    blocked: state.blockedTotal,
    board: boardFingerprint(s),
    act: s.lastAction,
  };
}

function versusTrace(seed: number, maxTicks: number) {
  const leftDecisions: RecordedDecision[] = [];
  const rightDecisions: RecordedDecision[] = [];
  const ctrl = createVersusController(
    recordingFighter(0, leftDecisions),
    recordingFighter(2, rightDecisions),
    seed,
    resolveVersusConfig(),
  );
  const events: unknown[] = [];
  let ticks = 0;
  let lastPieces = 0;
  while (ctrl.result === null && ticks < maxTicks) {
    ctrl.tick(16, VERSUS_DEFAULTS);
    ticks += 1;
    if (ctrl.pieces !== lastPieces) {
      lastPieces = ctrl.pieces;
      events.push({
        tick: ticks,
        pieces: ctrl.pieces,
        left: recordSide(ctrl, "left"),
        right: recordSide(ctrl, "right"),
      });
    }
  }
  const result = ctrl.result;
  return {
    seed,
    maxTicks,
    ticks,
    leftDecisions,
    rightDecisions,
    events,
    result:
      result === null
        ? null
        : {
            winner: result.winner,
            reason: result.reason,
            pieces: result.pieces,
            linesLeft: result.linesLeft,
            linesRight: result.linesRight,
            sentLeft: result.sentLeft,
            sentRight: result.sentRight,
          },
    final: {
      pieces: ctrl.pieces,
      left: {
        ...recordSide(ctrl, "left"),
        mismatches: ctrl.left.executionSourceMismatches,
        boardFailures: ctrl.left.executionExpectedBoardFailures,
      },
      right: {
        ...recordSide(ctrl, "right"),
        mismatches: ctrl.right.executionSourceMismatches,
        boardFailures: ctrl.right.executionExpectedBoardFailures,
      },
    },
  };
}

const VERSUS_SEEDS: readonly number[] = [1, 12345, 4294967295];
const versusScenarios = VERSUS_SEEDS.map((seed) => versusTrace(seed, 60000));
if (!versusScenarios.every((scenario) => scenario.result !== null)) {
  throw new Error("versus fixture must reach a match result in every scenario");
}
write("versus.json", {
  meta: {
    generatedBy: "tools/game-diff/reference.ts",
    reference: "src/versus/controller.ts",
    kind: "versus",
    fighter:
      "greedy placement solver (TS-side); decisions recorded per AI call and replayed by index in Rust",
  },
  scenarios: versusScenarios,
});

// ---------------------------------------------------------------------------
// Contract differential: NextState, opponent flags, faithful config, bridge.
// ---------------------------------------------------------------------------

interface NextOp {
  readonly kind: "shiftNext" | "compare";
  readonly first?: number;
  readonly nx?: readonly number[];
}

function nextTrace(
  name: string,
  viewNext: number,
  init: readonly number[],
  ops: readonly NextOp[],
) {
  const n = new NextState(viewNext);
  n.init(init);
  for (const op of ops) {
    if (op.kind === "shiftNext") n.shiftNext();
    else n.compare(op.first ?? 0, op.nx ?? []);
  }
  return { name, viewNext, init, ops, m: [...n.m], trustEnd: n.trustEnd, bagRemains: n.bagRemains };
}

const NEXT_SEQ = Array.from({ length: NEXT_SIZE }, (_, i) => i % 7);
const NEXT_LIVE = [6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2];
const SET_PPT_SEQ = [
  0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2,
];
const compareOp = (nx: readonly number[]): NextOp => ({ kind: "compare", first: 0, nx });
const shift = (count: number): NextOp[] =>
  Array.from({ length: count }, () => ({ kind: "shiftNext" }));

const nextStates = [
  nextTrace("fresh-empty-view2", 2, [], []),
  nextTrace("fresh-empty-view5", 5, [], []),
  nextTrace("nextdump-shift2", 2, NEXT_SEQ, [...shift(2), compareOp(NEXT_SEQ)]),
  nextTrace("full-carry-live", 2, NEXT_LIVE, [
    ...shift(3).flatMap((op) => [op, compareOp(NEXT_LIVE)]),
    ...shift(3).flatMap((op) => [op, compareOp(NEXT_LIVE)]),
  ]),
  nextTrace("setppt-iter1", 2, SET_PPT_SEQ, [...shift(1), compareOp(SET_PPT_SEQ)]),
  nextTrace("setppt-iter4", 2, SET_PPT_SEQ, [
    ...shift(4).flatMap((op) => [op, compareOp(SET_PPT_SEQ)]),
  ]),
  nextTrace("bag-cursor-14", 2, [0, 1, 2, 3], shift(14)),
];

const derivationBoards: { name: string; rows: number[] }[] = (() => {
  const full = (n: number, row = 0x3ff): number[] => Array.from({ length: n }, () => row);
  return [
    { name: "empty", rows: [] },
    { name: "one-full", rows: [0x3ff] },
    { name: "four-full", rows: full(4) },
    { name: "nine-full", rows: full(9) },
    { name: "ten-full", rows: full(10) },
    { name: "odd-9bit", rows: [0x1ff] },
    { name: "odd-9bit-x5", rows: full(5, 0x001) },
    { name: "even-col9", rows: full(6, 0x001) },
    { name: "bara-mix", rows: [0x1ff, 0x0ff, 0x03f, 0x01f, 0x00f, 0x007] },
    { name: "well-center", rows: [0x3ff, 0x3ff, 0x3ff, 0x3ef, 0x3ef, 0x3ef, 0x3ef] },
    {
      name: "tall-mixed",
      rows: [0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x37f, 0x37f, 0x37f, 0x37f, 0x37f, 0x37f],
    },
    { name: "s4w-3f", rows: [0x1ff, 0x3f, 0x3f, 0x3f, 0x3f, 0x3f] },
  ];
})();
const flagInputs: readonly (readonly [number, number])[] = [
  [0, 0],
  [4, 0],
  [5, 0],
  [0, 5],
  [0, 6],
  [9, 0],
];
const opponentCases = derivationBoards.flatMap((board) =>
  flagInputs.map(([combo, garbage]) => ({
    name: `${board.name}-c${combo}-g${garbage}`,
    rows: board.rows,
    combo,
    garbage,
    pc: opponentIsPCBoard(board.rows),
    powerful: opponentIsPowerfulBoard(board.rows, combo, garbage),
  })),
);

const faithfulCases: {
  readonly name: string;
  readonly preset: HoikoPreset;
  readonly env: FaithfulHoikoEnv;
}[] = [
  { name: "empty", preset: "we", env: {} },
  { name: "beam-1500", preset: "we", env: { HOIKO_BEAM: "1500" } },
  { name: "adapt-off", preset: "we", env: { HOIKO_ADAPT: "0" } },
  { name: "preset-wo", preset: "wo", env: {} },
  {
    name: "all-optional",
    preset: "wr",
    env: {
      HOIKO_OFFSET: "0",
      HOIKO_FRAMES: "25",
      HOIKO_NEXTCARRY: "1",
      HOIKO_EVEN: "true",
    },
  },
];

function gridFrom(rows: readonly number[], height: number): BoardView {
  const grid: CellValue[][] = Array.from({ length: height }, () =>
    Array.from({ length: COLS }, () => 0 as CellValue),
  );
  for (let y = 0; y < rows.length && y < height; y += 1) {
    const native = rows[y] ?? 0;
    const row = grid[height - 1 - y];
    if (row === undefined) continue;
    for (let x = 0; x < COLS; x += 1) if ((native & (1 << (9 - x))) !== 0) row[x] = 1;
  }
  return { cols: COLS, rows: height, grid };
}

write("contract.json", {
  meta: {
    generatedBy: "tools/game-diff/reference.ts",
    reference: "src/ai/hoiko-next.ts, src/ai/hoiko-opponent.ts, src/ai/hoiko-faithful.ts",
    kind: "contract",
  },
  nextStates,
  trustRange: [6, 5, 4, 3, 2, 1, 0, 7].map((remains) => ({ remains, range: trustRange(remains) })),
  opponentCases,
  faithful: {
    constant: FAITHFUL_HOIKO,
    cases: faithfulCases.map((test) => ({
      ...test,
      options: resolveFaithfulHoikoOptions(test.env, test.preset),
    })),
  },
  bridge: {
    frameSteps: [0, 1, 20, 100].map((frames) => ({ frames, ms: Math.round(frames / 0.06) })),
    boardToNative: derivationBoards.map((board) => ({
      name: board.name,
      rows: board.rows,
      native: boardToNativeRows(gridFrom(board.rows, ROWS)),
    })),
  },
});

console.log("done");
