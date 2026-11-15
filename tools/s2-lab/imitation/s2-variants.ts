/**
 * S2 imitation driver variants and feature decomposition.
 *
 * Isolates the three section-D candidate representations strictly inside tools/s2-lab:
 *   1. "existing"            — exact tools/s2-lab/search.ts semantics + instrumentation
 *   2. "corrected"           — fixes §F/§J.1 defects (SRS+ non-T spins, 20-row topout,
 *                              bottom-up garbageRows, residual pending, full dedupe)
 *   3. "corrected_augmented" — "corrected" + §C1 stock potential & §C2 solvency features
 *
 * Guideline / src/ai/bot paths are never modified.
 */

import { BOARD_FEATURES, boardFeatures } from "../../../src/ai/bot/features.js";
import {
  type BitBoard,
  COLS,
  collides,
  FULL_ROW,
  generatePlacements,
  lockPlacement,
  type Placement,
  ROWS,
  spawnPosition,
} from "../../../src/ai/bot/movegen.js";
import type { ClearKind, Weights } from "../../../src/ai/bot/weights.js";
import { cellsFor, type PieceKind } from "../../../src/core/pieces.js";
import { awardLock, s2GarbageMultiplier, s2Surge } from "../../../src/core/rules.js";
import { classifyS2Spin } from "../../../src/core/s2-spin.js";
import { asRotation, kickTable as guidelineKickTable, type Kick } from "../../../src/core/srs.js";
import type { TspinKind } from "../../../src/core/tspin.js";
import { placementCells } from "../attax-player.js";
import type { Candidate, SearchInput, SearchResult, Step } from "../search.js";

export type DriverVariant = "existing" | "corrected" | "corrected_augmented";

export const CLEAR_KINDS: readonly ClearKind[] = [
  "single",
  "double",
  "triple",
  "quad",
  "tspinMini",
  "tspinSingle",
  "tspinDouble",
  "tspinTriple",
  "perfectClear",
];

export const BASE_FEATURE_NAMES: readonly string[] = [
  ...BOARD_FEATURES.map((f) => `board.${f}`),
  "attack",
  "conversion",
  ...CLEAR_KINDS.map((c) => `clear.${c}`),
  "b2bBreak",
  "wastedT",
];

export const AUGMENTED_FEATURE_NAMES: readonly string[] = [
  "stock.surgeCashable",
  "stock.surgeGated",
  "stock.b2bBuildGated",
  "stock.comboGated",
  "solvency.rootDeficit",
  "solvency.pathMinDeficit",
  "solvency.pendingLeaf",
  "solvency.pathFatal",
  "solvency.highDanger",
  "downstack.garbageCleared",
];

export const ALL_FEATURE_NAMES: readonly string[] = [
  ...BASE_FEATURE_NAMES,
  ...AUGMENTED_FEATURE_NAMES,
];

export const NUM_BASE_FEATURES = BASE_FEATURE_NAMES.length; // 24
export const NUM_AUGMENTED_FEATURES = AUGMENTED_FEATURE_NAMES.length; // 10
export const NUM_TOTAL_FEATURES = ALL_FEATURE_NAMES.length; // 34

export const S2_VISIBLE_ROWS = 20;
export const S2_GARBAGE_CAP = 8;

export function weightsToVector24(w: Weights): number[] {
  return [
    ...BOARD_FEATURES.map((f) => w.board[f]),
    w.attack,
    w.conversion,
    ...CLEAR_KINDS.map((c) => w.clear[c]),
    w.b2bBreak,
    w.wastedT,
  ];
}

export function vector24ToWeights(vec: readonly number[], discount: number): Weights {
  if (vec.length !== NUM_BASE_FEATURES) {
    throw new Error(`expected ${NUM_BASE_FEATURES} weights, got ${vec.length}`);
  }
  const board = Object.fromEntries(
    BOARD_FEATURES.map((f, idx) => [f, vec[idx] as number]),
  ) as Weights["board"];
  let offset = BOARD_FEATURES.length;
  const attack = vec[offset++] as number;
  const conversion = vec[offset++] as number;
  const clear = Object.fromEntries(
    CLEAR_KINDS.map((c, idx) => [c, vec[offset + idx] as number]),
  ) as Weights["clear"];
  offset += CLEAR_KINDS.length;
  const b2bBreak = vec[offset++] as number;
  const wastedT = vec[offset++] as number;
  return {
    board,
    attack,
    conversion,
    clear,
    b2bBreak,
    wastedT,
    discount,
  };
}

export function dotVectors(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
}

/** Semantic action key matching referee cell+hold+spin identity under S2 All-Mini+. */
export function semanticActionKey(
  placement: Placement,
  usedHold: boolean,
  spin: TspinKind,
): string {
  const cells = placementCells(placement)
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");
  return `${placement.kind}:${usedHold ? 1 : 0}:${spin}:${cells}`;
}

export function witnessActionKey(placement: Placement, usedHold: boolean): string {
  const cells = placementCells(placement)
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");
  return `${placement.kind}:${usedHold ? 1 : 0}:${placement.lastSrs > 0 ? 1 : 0}:${cells}`;
}

export function cellHoldKey(placement: Placement, usedHold: boolean): string {
  const cells = placementCells(placement)
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");
  return `${placement.kind}:${usedHold ? 1 : 0}:${cells}`;
}

// ---------------------------------------------------------------------------
// SRS+ Movegen (all pieces retain rotation evidence & distinct spin drops)
// ---------------------------------------------------------------------------

const KINDS: readonly PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

interface Shape {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly rows: readonly number[];
}

const SHAPES: Readonly<Record<PieceKind, readonly Shape[]>> = Object.fromEntries(
  KINDS.map((kind) => [
    kind,
    [0, 1, 2, 3].map((rotation) => {
      const cells = cellsFor(kind, rotation);
      let minX = 9;
      let maxX = 0;
      let minY = 9;
      let maxY = 0;
      for (const c of cells) {
        minX = Math.min(minX, c.x);
        maxX = Math.max(maxX, c.x);
        minY = Math.min(minY, c.y);
        maxY = Math.max(maxY, c.y);
      }
      const rows: number[] = [];
      for (let y = minY; y <= maxY; y += 1) {
        let mask = 0;
        for (const c of cells) if (c.y === y) mask |= 1 << (c.x - minX);
        rows.push(mask);
      }
      return { minX, maxX, minY, rows };
    }),
  ]),
) as unknown as Record<PieceKind, readonly Shape[]>;

// Symmetric TETR.IO SRS+ I-kicks matching @haelp/teto kickData["SRS+"].
// Note: movegen applies ny = y - kick.dy (positive dy = up), whereas @haelp/teto applies y - dy (positive dy = down).
const I_KICKS_SRS_PLUS: Readonly<Record<string, readonly Kick[]>> = {
  "0>1": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: -2, dy: -1 },
    { dx: 1, dy: 2 },
  ],
  "1>0": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: -1, dy: -2 },
    { dx: 2, dy: 1 },
  ],
  "1>2": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: -1, dy: 2 },
    { dx: 2, dy: -1 },
  ],
  "2>1": [
    { dx: 0, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -2, dy: 1 },
    { dx: 1, dy: -2 },
  ],
  "2>3": [
    { dx: 0, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 2, dy: 1 },
    { dx: -1, dy: -2 },
  ],
  "3>2": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 1, dy: 2 },
    { dx: -2, dy: -1 },
  ],
  "3>0": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 1, dy: -2 },
    { dx: -2, dy: 1 },
  ],
  "0>3": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: 2, dy: -1 },
    { dx: -1, dy: 2 },
  ],
};

function srsPlusKickTable(kind: PieceKind, from: number, to: number): readonly Kick[] {
  const f = asRotation(from);
  const t = asRotation(to);
  if (kind === "I") {
    return I_KICKS_SRS_PLUS[`${f}>${t}`] ?? [{ dx: 0, dy: 0 }];
  }
  return guidelineKickTable(kind, f, t);
}

const KICKS_SRS_PLUS: Readonly<Record<PieceKind, readonly (readonly (readonly Kick[])[])[]>> =
  Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      [0, 1, 2, 3].map((from) =>
        [1, 3].map((dir) => srsPlusKickTable(kind, from, (from + dir) & 3)),
      ),
    ]),
  ) as unknown as Record<PieceKind, readonly (readonly (readonly Kick[])[])[]>;

// BFS buffers for generateS2Placements: rotation (4) x row (-4..59 -> 64) x col (-3..12 -> 16)
const X_OFF = 3;
const Y_OFF = 4;
const X_SPAN = 16;
const Y_SPAN = 64;
const STATE_COUNT = 4 * Y_SPAN * X_SPAN;

const s2Visited = new Uint32Array(STATE_COUNT);
const s2NonSpinStamp = new Uint32Array(STATE_COUNT);
const s2SpinArrival = new Uint8Array(STATE_COUNT);
const s2SpinStamp = new Uint32Array(STATE_COUNT);
const s2Queue = new Int32Array(STATE_COUNT);
let s2Stamp = 0;

function encodeState(rotation: number, x: number, y: number): number {
  return (rotation * Y_SPAN + (y + Y_OFF)) * X_SPAN + (x + X_OFF);
}

function cellKeyFor(shape: Shape, x: number, y: number): number {
  let key = y + shape.minY + Y_OFF;
  for (const row of shape.rows) key = key * 1024 + (row << (x + shape.minX));
  return key;
}

function isS2SpinCandidate(board: BitBoard, placement: Placement): TspinKind {
  return classifyS2Spin(
    placement,
    (x, y) =>
      x < 0 || x >= COLS || y >= board.length || (y >= 0 && ((board[y] ?? 0) & (1 << x)) !== 0),
    (dx, dy) =>
      !collides(board, placement.kind, placement.rotation, placement.x + dx, placement.y + dy),
  );
}

/**
 * Corrected S2 placement generator:
 * - SRS+ kicks (symmetric I kicks), 180 disabled.
 * - Preserves `lastSrs` for ALL pieces (non-T All-Mini+ spin bonuses).
 * - Preserves both spin and non-spin arrivals when they differ in spin class or root witness.
 * - Adjusts spawn row by `lift` to reflect tanked garbage headroom on deeper nodes.
 */
export function generateS2Placements(
  board: BitBoard,
  kind: PieceKind,
  start: { readonly rotation: number; readonly x: number; readonly y: number } = spawnPosition(
    kind,
    board.length,
  ),
  lift = 0,
  includeBothWitnessesAtRoot = false,
): Placement[] {
  const out: Placement[] = [];
  let effStart = lift > 0 ? { ...start, y: start.y + lift } : start;
  if (
    board.length > ROWS &&
    start.y === board.length - 21 &&
    collides(board, kind, effStart.rotation, effStart.x, effStart.y)
  ) {
    effStart = { ...effStart, y: effStart.y - 1 };
  }
  if (collides(board, kind, effStart.rotation, effStart.x, effStart.y)) return out;

  s2Stamp += 1;
  if (s2Stamp >= 0xfffffffe) {
    s2Visited.fill(0);
    s2NonSpinStamp.fill(0);
    s2SpinStamp.fill(0);
    s2Stamp = 1;
  }

  const rotations = kind === "O" ? 1 : 4;
  let head = 0;
  let tail = 0;
  const resting: number[] = [];
  const restingSeen = new Uint32Array(0);
  void restingSeen;

  const visit = (rotation: number, x: number, y: number, fromNonRot: boolean): void => {
    if (y + Y_OFF < 0 || y + Y_OFF >= Y_SPAN || x + X_OFF < 0 || x + X_OFF >= X_SPAN) return;
    const id = encodeState(rotation, x, y);
    if (fromNonRot && collides(board, kind, rotation, x, y + 1)) {
      if (!collides(board, kind, rotation, x, y)) {
        s2NonSpinStamp[id] = s2Stamp;
      }
    }
    if (s2Visited[id] === s2Stamp) return;
    if (collides(board, kind, rotation, x, y)) return;
    s2Visited[id] = s2Stamp;
    s2Queue[tail++] = id;
  };

  let top = 0;
  while (top < board.length && board[top] === 0) top += 1;
  const startShape = SHAPES[kind][effStart.rotation & 3] as Shape;
  const startBottom = effStart.y + startShape.minY + startShape.rows.length - 1;
  if (startBottom < top - 1) {
    for (let rotation = 0; rotation < rotations; rotation += 1) {
      const shape = SHAPES[kind][rotation] as Shape;
      const lowest = top - shape.minY - shape.rows.length;
      const highest = Math.max(lowest - 2, effStart.y);
      for (let x = -shape.minX; x + shape.maxX < COLS; x += 1) {
        for (let y = lowest; y >= highest; y -= 1) {
          const id = encodeState(rotation, x, y);
          // Reached open-air positions via shifts/drops; if y === lowest on empty board, resting non-spin.
          if (
            y + Y_OFF >= 0 &&
            y + Y_OFF < Y_SPAN &&
            x + X_OFF >= 0 &&
            x + X_OFF < X_SPAN &&
            !collides(board, kind, rotation, x, y)
          ) {
            if (s2Visited[id] !== s2Stamp) {
              s2Visited[id] = s2Stamp;
              s2Queue[tail++] = id;
            }
            if (collides(board, kind, rotation, x, y + 1)) {
              s2NonSpinStamp[id] = s2Stamp;
            }
          }
        }
      }
    }
  } else {
    visit(effStart.rotation, effStart.x, effStart.y, true);
  }

  while (head < tail) {
    const id = s2Queue[head++] as number;
    const x = (id % X_SPAN) - X_OFF;
    const y = (Math.floor(id / X_SPAN) % Y_SPAN) - Y_OFF;
    const rotation = Math.floor(id / (X_SPAN * Y_SPAN));
    const grounded = collides(board, kind, rotation, x, y + 1);
    if (grounded) {
      resting.push(id);
      if (rotations === 1) {
        // Rotating O in place is a valid 0-kick input in SRS+, so resting O has a rotation witness too.
        s2SpinStamp[id] = s2Stamp;
        s2SpinArrival[id] = 1;
      }
    }

    visit(rotation, x - 1, y, true);
    visit(rotation, x + 1, y, true);
    if (!grounded) visit(rotation, x, y + 1, true);
    if (rotations === 1) continue;

    const kickSets = KICKS_SRS_PLUS[kind][rotation] as readonly (readonly Kick[])[];
    for (let dir = 0; dir < 2; dir += 1) {
      const to = (rotation + (dir === 0 ? 1 : 3)) & 3;
      const kicks = kickSets[dir] as readonly Kick[];
      for (let i = 0; i < kicks.length; i += 1) {
        const kick = kicks[i] as Kick;
        const nx = x + kick.dx;
        const ny = y - kick.dy;
        if (collides(board, kind, to, nx, ny)) continue;
        const lastSrs = i === 0 ? 1 : i + 1;
        if (collides(board, kind, to, nx, ny + 1)) {
          const target = encodeState(to, nx, ny);
          if (s2SpinStamp[target] !== s2Stamp || lastSrs > (s2SpinArrival[target] as number)) {
            s2SpinStamp[target] = s2Stamp;
            s2SpinArrival[target] = lastSrs;
          }
        }
        visit(to, nx, ny, false);
        break;
      }
    }
  }

  // Deduplicate cleanly by (cells, spin) or at root by (cells, lastSrs>0, spin) so witness checks match.
  const seenKey = new Set<string>();
  const seenSemantic = new Set<string>();
  for (const id of resting) {
    const x = (id % X_SPAN) - X_OFF;
    const y = (Math.floor(id / X_SPAN) % Y_SPAN) - Y_OFF;
    const rotation = Math.floor(id / (X_SPAN * Y_SPAN));
    const shape = SHAPES[kind][rotation] as Shape;
    if (y + shape.minY + shape.rows.length - 1 < 0) continue;

    const hasSpin = s2SpinStamp[id] === s2Stamp;
    const lastSrs = hasSpin ? (s2SpinArrival[id] as number) : 0;
    const hasNonSpin = s2NonSpinStamp[id] === s2Stamp || !hasSpin;
    const cKey = cellKeyFor(shape, x, y);

    if (hasSpin) {
      const cand: Placement = { kind, rotation, x, y, lastSrs, tspin: "none" };
      const spin = isS2SpinCandidate(board, cand);
      const semKey = `${cKey}:${spin}`;
      const key = includeBothWitnessesAtRoot ? `${cKey}:1:${spin}` : semKey;
      if (!seenKey.has(key)) {
        seenKey.add(key);
        seenSemantic.add(semKey);
        out.push({ kind, rotation, x, y, lastSrs, tspin: spin });
      }
    }

    if (hasNonSpin) {
      const semKey = `${cKey}:none`;
      if (includeBothWitnessesAtRoot) {
        const key = `${cKey}:0:none`;
        if (!seenKey.has(key)) {
          seenKey.add(key);
          seenSemantic.add(semKey);
          out.push({ kind, rotation, x, y, lastSrs: 0, tspin: "none" });
        }
      } else if (!seenSemantic.has(semKey)) {
        seenKey.add(semKey);
        seenSemantic.add(semKey);
        out.push({ kind, rotation, x, y, lastSrs: 0, tspin: "none" });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instrumented search & linear feature vector extraction
// ---------------------------------------------------------------------------

export interface RootCandidateReport {
  /** Key `${kind}:${usedHold?1:0}:${lastSrs>0?1:0}:${cells}` */
  readonly witnessKey: string;
  /** Semantic S2 key `${kind}:${usedHold?1:0}:${spin}:${cells}` */
  readonly semanticKey: string;
  /** Cell+hold key `${kind}:${usedHold?1:0}:${cells}` */
  readonly cellKey: string;
  readonly placement: Placement;
  readonly usedHold: boolean;
  readonly spin: TspinKind;
  readonly rootSolvencyMargin: number;
  readonly minSolvencyMargin: number;
  readonly fatalAtRoot: boolean;
  readonly fatalOnBestPath: boolean;
  /** Max ply depth 1..maxDepth reached inside production width-48 beam (0 if pruned at root filter). */
  readonly pruningDepth: number;
  /** True iff at least one descendant reached `leaves` in production width-48 beam. */
  readonly survivedBeam: boolean;
  /** Best leaf value inside production width-48 beam (null if pruned before leaves). */
  readonly beamValue: number | null;
  /** Value from matched-horizon (or deepest fatal fallback) continuation `phi`. */
  readonly completeValue: number;
  /** 24 base linear weights features + 10 augmented §C1/§C2 features = 34 numbers. */
  readonly phi34: readonly number[];
  readonly phi24: readonly number[];
  readonly stepCount: number;
}

export interface InstrumentedSearchReport {
  readonly variant: DriverVariant;
  readonly searchResult: SearchResult | null;
  /** Total nodes expanded across standard + completion passes. */
  readonly nodes: number;
  readonly depth: number;
  readonly candidates: readonly RootCandidateReport[];
  readonly maxHeightRoot: number;
}

interface TraceAcc {
  readonly attack: number;
  readonly conversion: number;
  readonly clears: Float64Array; // length 9 mapped by CLEAR_KINDS
  readonly b2bBreak: number;
  readonly wastedT: number;
  readonly garbageCleared: number;
}

function emptyAcc(): TraceAcc {
  return {
    attack: 0,
    conversion: 0,
    clears: new Float64Array(CLEAR_KINDS.length),
    b2bBreak: 0,
    wastedT: 0,
    garbageCleared: 0,
  };
}

interface SimNode {
  readonly board: BitBoard;
  readonly garbageRows: Uint8Array;
  readonly hold: PieceKind | null;
  readonly next: number;
  readonly canHold: boolean;
  readonly b2b: number;
  readonly combo: number;
  readonly lift: number;
  readonly pending: number;
  readonly due: number;
  readonly tSlot: number;
  readonly reward: number;
  readonly value: number;
  readonly depth: number;
  readonly step: Step | null;
  readonly parent: SimNode | null;
  readonly root: number;
  readonly acc: TraceAcc;
  readonly rootSolvencyMargin: number;
  readonly minSolvencyMargin: number;
  readonly fatal: boolean;
}

interface PieceOption {
  readonly kind: PieceKind;
  readonly usedHold: boolean;
  readonly next: number;
  readonly hold: PieceKind | null;
}

function pieceOptions(node: SimNode, sequence: readonly PieceKind[]): PieceOption[] {
  const current = sequence[node.next];
  if (current === undefined) return [];
  const options: PieceOption[] = [
    { kind: current, usedHold: false, next: node.next + 1, hold: node.hold },
  ];
  if (!node.canHold) return options;
  if (node.hold === null) {
    const after = sequence[node.next + 1];
    if (after !== undefined && after !== current) {
      options.push({ kind: after, usedHold: true, next: node.next + 2, hold: current });
    }
  } else if (node.hold !== current) {
    options.push({ kind: node.hold, usedHold: true, next: node.next + 1, hold: current });
  }
  return options;
}

function clearKindOf(lines: number, tspin: TspinKind, perfectClear: boolean): ClearKind | null {
  if (lines === 0) return null;
  if (perfectClear) return "perfectClear";
  if (tspin === "mini") return "tspinMini";
  if (tspin === "full")
    return lines === 1 ? "tspinSingle" : lines === 2 ? "tspinDouble" : "tspinTriple";
  return lines === 1 ? "single" : lines === 2 ? "double" : lines === 3 ? "triple" : "quad";
}

function clearKindIndex(kind: ClearKind | null): number {
  if (kind === null) return -1;
  return CLEAR_KINDS.indexOf(kind);
}

function occupiedHeightOf(board: BitBoard): number {
  for (let row = 0; row < board.length; row += 1) {
    if ((board[row] as number) !== 0) return board.length - row;
  }
  return 0;
}

function clip01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

function buildLeafPhi(
  node: SimNode,
  discount: number,
  rootFrame: number,
): { phi24: number[]; phi34: number[]; augScoreContribution: number } {
  const leafFeatures = boardFeatures(node.board, node.lift);
  const leafScale = discount ** node.depth;
  const phi24: number[] = [];
  for (const name of BOARD_FEATURES) {
    phi24.push(leafScale * leafFeatures[name]);
  }
  phi24.push(node.acc.attack);
  phi24.push(node.acc.conversion);
  for (let i = 0; i < CLEAR_KINDS.length; i += 1) {
    phi24.push(node.acc.clears[i] as number);
  }
  phi24.push(node.acc.b2bBreak);
  phi24.push(node.acc.wastedT);

  const mult = s2GarbageMultiplier(rootFrame + 60 * node.depth);
  const cashableSurge = s2Surge(node.b2b) * mult;
  const h = leafFeatures.maxHeight;
  const leafMargin = Math.max(0, S2_VISIBLE_ROWS - h - node.pending);
  const gate = clip01((14 - h) / 6) * clip01(leafMargin / 6);

  const aug10 = [
    leafScale * cashableSurge, // stock.surgeCashable
    leafScale * gate * cashableSurge, // stock.surgeGated
    leafScale * gate * Math.min(node.b2b, 4), // stock.b2bBuildGated
    leafScale * gate * Math.max(0, node.combo), // stock.comboGated
    Math.max(0, -node.rootSolvencyMargin), // solvency.rootDeficit
    Math.max(0, -node.minSolvencyMargin), // solvency.pathMinDeficit
    leafScale * node.pending, // solvency.pendingLeaf
    node.fatal ? 1 : 0, // solvency.pathFatal
    leafScale * Math.max(0, h - 14) ** 2, // solvency.highDanger
    node.acc.garbageCleared, // downstack.garbageCleared
  ];

  return {
    phi24,
    phi34: [...phi24, ...aug10],
    augScoreContribution: 0,
  };
}

function expandSimNode(
  node: SimNode,
  rawPlacement: Placement,
  option: PieceOption,
  w: Weights,
  augWeights: readonly number[] | undefined,
  rootIndex: number,
  rootPending: number,
  dueThisLock: number,
  rootFrame: number,
  mode: "existing" | "corrected",
): SimNode | null {
  const spin = classifyS2Spin(
    rawPlacement,
    (x, y) =>
      x < 0 ||
      x >= COLS ||
      y >= node.board.length ||
      (y >= 0 && ((node.board[y] ?? 0) & (1 << x)) !== 0),
    (dx, dy) =>
      !collides(
        node.board,
        rawPlacement.kind,
        rawPlacement.rotation,
        rawPlacement.x + dx,
        rawPlacement.y + dy,
      ),
  );
  const placement: Placement = { ...rawPlacement, tspin: spin };

  const filled = node.board.slice();
  for (const cell of cellsFor(placement.kind, placement.rotation)) {
    const row = placement.y + cell.y;
    if (row >= 0 && row < filled.length) {
      filled[row] = (filled[row] as number) | (1 << (placement.x + cell.x));
    }
  }

  const garbageRows = new Uint8Array(node.board.length);
  let garbageCleared = 0;
  if (mode === "existing") {
    let write = 0;
    for (let read = 0; read < filled.length; read += 1) {
      if (filled[read] === FULL_ROW) {
        garbageCleared += node.garbageRows[read] ?? 0;
      } else {
        garbageRows[write++] = node.garbageRows[read] ?? 0;
      }
    }
  } else {
    // Bottom-up survivor collapse matching lockPlacement.
    let write = filled.length - 1;
    for (let read = filled.length - 1; read >= 0; read -= 1) {
      if (filled[read] === FULL_ROW) {
        garbageCleared += node.garbageRows[read] ?? 0;
      } else {
        garbageRows[write--] = node.garbageRows[read] ?? 0;
      }
    }
  }

  const outcome = lockPlacement(node.board, placement);
  const lines = outcome.linesCleared;
  const combo = lines > 0 ? node.combo + 1 : -1;
  const award = awardLock(
    "tetrio-s2",
    {
      lines,
      tspinLines: spin === "full" ? lines : 0,
      tspinKind: spin,
      combo,
      b2bActive: node.b2b > 0,
      perfectClear: outcome.perfectClear,
    },
    node.b2b,
    { multiplier: s2GarbageMultiplier(rootFrame + 60 * node.depth), garbageCleared },
  );
  const attack = award.attack;
  const difficult = lines > 0 && (lines === 4 || spin !== "none" || outcome.perfectClear);
  const b2b = award.difficultChain;

  let pendingThisStep: number;
  let dueThisStep: number;
  let tankedThisStep: number;
  let nextPending: number;
  let nextDue: number;

  if (mode === "existing") {
    pendingThisStep = node.depth === 0 ? rootPending : 0;
    dueThisStep = dueThisLock;
    tankedThisStep = lines === 0 ? Math.min(dueThisStep, Math.max(0, pendingThisStep - attack)) : 0;
    nextPending = 0;
    nextDue = 0;
  } else {
    pendingThisStep = node.pending;
    dueThisStep = node.due;
    if (lines > 0) {
      const cancelled = Math.min(attack, pendingThisStep);
      tankedThisStep = 0;
      nextPending = pendingThisStep - cancelled;
      nextDue = nextPending;
    } else {
      tankedThisStep = Math.min(S2_GARBAGE_CAP, dueThisStep, pendingThisStep);
      nextPending = pendingThisStep - tankedThisStep;
      nextDue = nextPending;
    }
  }

  const lift = node.lift + tankedThisStep;
  const convUnits =
    mode === "existing"
      ? node.depth === 0
        ? Math.max(0, attack - rootPending)
        : 0
      : Math.max(0, attack - pendingThisStep);
  const cKind = clearKindOf(lines, spin, outcome.perfectClear);
  const brokeB2b = node.b2b > 0 && lines > 0 && !difficult && !outcome.perfectClear;
  const isWastedT = placement.kind === "T" && spin === "none" && node.tSlot > 0;

  let reward = attack * w.attack + convUnits * w.conversion;
  if (cKind !== null) reward += w.clear[cKind];
  if (brokeB2b) reward += w.b2bBreak;
  if (isWastedT) reward += w.wastedT;

  const features = boardFeatures(outcome.board, lift);
  if (mode === "existing" && features.maxHeight >= node.board.length) return null;

  const occAfterLock = occupiedHeightOf(outcome.board);
  const stepSolvency = S2_VISIBLE_ROWS - occAfterLock - lift - nextPending;
  const fatalNow = occAfterLock + lift > S2_VISIBLE_ROWS;
  const rootSolvency = node.depth === 0 ? stepSolvency : node.rootSolvencyMargin;
  const minSolvency =
    node.depth === 0 ? stepSolvency : Math.min(node.minSolvencyMargin, stepSolvency);

  const scale = w.discount ** node.depth;
  const accumulated = node.reward + scale * reward;

  const clears = Float64Array.from(node.acc.clears);
  const ckIdx = clearKindIndex(cKind);
  if (ckIdx >= 0) clears[ckIdx] = (clears[ckIdx] as number) + scale;

  const acc: TraceAcc = {
    attack: node.acc.attack + scale * attack,
    conversion: node.acc.conversion + scale * convUnits,
    clears,
    b2bBreak: node.acc.b2bBreak + (brokeB2b ? scale : 0),
    wastedT: node.acc.wastedT + (isWastedT ? scale : 0),
    garbageCleared: node.acc.garbageCleared + scale * garbageCleared,
  };

  let boardDot = 0;
  for (const name of BOARD_FEATURES) boardDot += features[name] * w.board[name];
  let value = accumulated + scale * w.discount * boardDot;

  const nextDepth = node.depth + 1;
  const fatal = node.fatal || fatalNow;

  if (augWeights !== undefined && augWeights.length === NUM_AUGMENTED_FEATURES) {
    const leafScale = w.discount ** nextDepth;
    const mult = s2GarbageMultiplier(rootFrame + 60 * nextDepth);
    const cashable = s2Surge(b2b) * mult;
    const h = features.maxHeight;
    const leafMargin = Math.max(0, S2_VISIBLE_ROWS - h - nextPending);
    const gate = clip01((14 - h) / 6) * clip01(leafMargin / 6);
    const augVec = [
      leafScale * cashable,
      leafScale * gate * cashable,
      leafScale * gate * Math.min(b2b, 4),
      leafScale * gate * Math.max(0, combo),
      Math.max(0, -rootSolvency),
      Math.max(0, -minSolvency),
      leafScale * nextPending,
      fatal ? 1 : 0,
      leafScale * Math.max(0, h - 14) ** 2,
      acc.garbageCleared,
    ];
    value += dotVectors(augVec, augWeights);
  }

  return {
    board: outcome.board,
    garbageRows,
    hold: option.hold,
    next: option.next,
    canHold: true,
    b2b,
    combo,
    lift,
    pending: nextPending,
    due: nextDue,
    tSlot: features.tSlot,
    reward: accumulated,
    value,
    depth: nextDepth,
    step: { placement, usedHold: option.usedHold, linesCleared: lines, attack, reward },
    parent: node,
    root: node.depth === 0 ? rootIndex : node.root,
    acc,
    rootSolvencyMargin: rootSolvency,
    minSolvencyMargin: minSolvency,
    fatal,
  };
}

function makeDedupeKey(node: SimNode, mode: "existing" | "corrected"): string {
  if (mode === "existing") {
    return `${node.next}|${node.hold}|${node.b2b}|${node.combo}|${node.board.join(",")}`;
  }
  let gKey = "";
  for (let r = 0; r < node.garbageRows.length; r += 1) {
    if (node.garbageRows[r]) gKey += `${r},`;
  }
  return `${node.next}|${node.hold}|${Number(node.canHold)}|${node.b2b}|${node.combo}|${node.lift}|${node.pending}|${gKey}|${node.board.join(",")}`;
}

function dedupeBeam(
  sorted: readonly SimNode[],
  width: number,
  mode: "existing" | "corrected",
): SimNode[] {
  const kept: SimNode[] = [];
  const seen = new Set<string>();
  for (const node of sorted) {
    if (kept.length >= width) break;
    const key = makeDedupeKey(node, mode);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(node);
  }
  return kept;
}

/** Guarantees at least 1 surviving slot per active rootId in `targetRoots`, then fills extra slots globally. */
function selectBeamWithRootFloor(
  sorted: readonly SimNode[],
  maxSlots: number,
  mode: "existing" | "corrected",
): SimNode[] {
  const kept: SimNode[] = [];
  const seen = new Set<string>();
  const pickedByRoot = new Set<number>();
  const usedNodes = new Set<SimNode>();

  for (const node of sorted) {
    if (pickedByRoot.has(node.root)) continue;
    const key = makeDedupeKey(node, mode);
    pickedByRoot.add(node.root);
    usedNodes.add(node);
    seen.add(key);
    kept.push(node);
  }
  for (const node of sorted) {
    if (kept.length >= maxSlots) break;
    if (usedNodes.has(node)) continue;
    const key = makeDedupeKey(node, mode);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(node);
  }
  return kept.sort((a, b) => b.value - a.value);
}

function generateForNode(
  node: SimNode,
  option: PieceOption,
  input: SearchInput,
  mode: "existing" | "corrected",
): Placement[] {
  const rawStart =
    node.depth === 0 && !option.usedHold
      ? input.active
      : option.usedHold && node.hold !== null
        ? { rotation: 0, x: 3, y: node.board.length > 20 ? node.board.length - 21 : 0 }
        : spawnPosition(option.kind, node.board.length);

  if (mode === "existing") {
    const placements = generatePlacements(node.board, option.kind, rawStart);
    if (node.depth === 0 && input.acceptRoot) {
      return placements.filter((p) => input.acceptRoot?.(p, option.usedHold) ?? true);
    }
    return placements;
  }

  const placements = generateS2Placements(
    node.board,
    option.kind,
    rawStart,
    node.lift,
    node.depth === 0 && Boolean(input.acceptRoot),
  );
  if (node.depth === 0 && input.acceptRoot) {
    return placements.filter((p) => input.acceptRoot?.(p, option.usedHold) ?? true);
  }
  return placements;
}

export interface VariantSearchOptions {
  readonly weights: Weights;
  readonly width: number;
  /** Optional 10 augmented weights for "corrected_augmented". */
  readonly augmentedWeights?: readonly number[];
  /**
   * When true (default for data generation), runs a lightweight root-floor completion
   * pass for any expressible root pruned before `leaves`, so every legal action in movegen
   * receives a matched-horizon continuation feature vector `phi34`.
   */
  readonly completePrunedRoots?: boolean;
}

/**
 * Runs beam search under the requested S2 variant, returning both the exact SearchResult
 * (at the requested `width`) and per-root survival/pruning/feature diagnostics.
 */
export function runVariantSearch(
  input: SearchInput,
  variant: DriverVariant,
  options: VariantSearchOptions,
): InstrumentedSearchReport {
  const mode: "existing" | "corrected" = variant === "existing" ? "existing" : "corrected";
  const w = options.weights;
  const augW = variant === "corrected_augmented" ? options.augmentedWeights : undefined;
  const sequence: PieceKind[] = [input.active.kind, ...input.preview];
  const rootFrame = input.frame ?? 0;
  const rootFeatures = boardFeatures(input.board, 0);

  const root: SimNode = {
    board: input.board,
    garbageRows: Uint8Array.from(input.board, (_, row) => (input.garbageRows?.[row] ? 1 : 0)),
    hold: input.hold,
    next: 0,
    canHold: input.canHold,
    b2b: input.b2b,
    combo: input.combo,
    lift: 0,
    pending: input.pending,
    due: input.dueThisLock,
    tSlot: rootFeatures.tSlot,
    reward: 0,
    value: 0,
    depth: 0,
    step: null,
    parent: null,
    root: -1,
    acc: emptyAcc(),
    rootSolvencyMargin: S2_VISIBLE_ROWS - rootFeatures.maxHeight - input.pending,
    minSolvencyMargin: S2_VISIBLE_ROWS - rootFeatures.maxHeight - input.pending,
    fatal: false,
  };

  let beam: SimNode[] = [root];
  let beamNodes = 0;
  let totalNodes = 0;
  const firstMoves: SimNode[] = [];
  const maxDepthByRoot: number[] = [];
  const bestFatalByRoot = new Map<number, SimNode>();
  const finishedAlive: SimNode[] = [];
  let deepestAlive: SimNode[] = [];

  while (beam.length > 0) {
    const children: SimNode[] = [];
    for (const node of beam) {
      const opts = pieceOptions(node, sequence);
      if (opts.length === 0) {
        if (!node.fatal) finishedAlive.push(node);
        continue;
      }
      for (const option of opts) {
        const placements = generateForNode(node, option, input, mode);
        for (const p of placements) {
          const rIdx = node.depth === 0 ? firstMoves.length : node.root;
          const child = expandSimNode(
            node,
            p,
            option,
            w,
            augW,
            rIdx,
            input.pending,
            input.dueThisLock,
            rootFrame,
            mode,
          );
          beamNodes += 1;
          totalNodes += 1;
          if (child === null) continue;
          if (node.depth === 0) {
            firstMoves.push(child);
            maxDepthByRoot.push(1);
          }
          if (mode === "corrected" && child.fatal) {
            const prevFatal = bestFatalByRoot.get(child.root);
            if (
              prevFatal === undefined ||
              child.depth > prevFatal.depth ||
              (child.depth === prevFatal.depth && child.value > prevFatal.value)
            ) {
              bestFatalByRoot.set(child.root, child);
            }
            continue;
          }
          children.push(child);
        }
      }
    }
    children.sort((a, b) => b.value - a.value);
    beam = dedupeBeam(children, options.width, mode);
    for (const node of beam) {
      if (node.root >= 0 && node.depth > (maxDepthByRoot[node.root] ?? 0)) {
        maxDepthByRoot[node.root] = node.depth;
      }
    }
    if (beam.length > 0) deepestAlive = beam;
  }

  const leavesAlive = finishedAlive.length > 0 ? finishedAlive : deepestAlive;
  const rootBestAlive = new Map<number, SimNode>();
  for (const leaf of leavesAlive) {
    if (leaf.depth === 0 || leaf.root < 0) continue;
    const prev = rootBestAlive.get(leaf.root);
    if (prev === undefined || leaf.value > prev.value) rootBestAlive.set(leaf.root, leaf);
  }

  let bestLeaf: SimNode | null = null;
  for (const leaf of leavesAlive) {
    if (leaf.depth === 0) continue;
    if (bestLeaf === null || leaf.value > bestLeaf.value) bestLeaf = leaf;
  }
  if (bestLeaf === null && bestFatalByRoot.size > 0) {
    for (const fatalLeaf of bestFatalByRoot.values()) {
      if (bestLeaf === null || fatalLeaf.value > bestLeaf.value) bestLeaf = fatalLeaf;
    }
  }

  // Run root-floor completion pass ONLY for non-fatal roots that didn't survive to `leavesAlive`.
  const rootBestComplete = new Map<number, SimNode>(rootBestAlive);
  if (options.completePrunedRoots !== false && firstMoves.length > 0) {
    const missingAliveRoots: SimNode[] = [];
    for (let i = 0; i < firstMoves.length; i += 1) {
      const fm = firstMoves[i] as SimNode;
      if (rootBestComplete.has(i)) continue;
      if (mode === "corrected" && fm.fatal) continue;
      missingAliveRoots.push(fm);
    }

    if (missingAliveRoots.length > 0) {
      let cBeam: SimNode[] = missingAliveRoots.sort((a, b) => b.value - a.value);
      const cFinished: SimNode[] = [];
      const cDeepestByRoot = new Map<number, SimNode>();
      while (cBeam.length > 0) {
        const cChildren: SimNode[] = [];
        for (const node of cBeam) {
          const opts = pieceOptions(node, sequence);
          if (opts.length === 0) {
            if (!node.fatal) cFinished.push(node);
            continue;
          }
          for (const option of opts) {
            const placements = generateForNode(node, option, input, mode);
            for (const p of placements) {
              const child = expandSimNode(
                node,
                p,
                option,
                w,
                augW,
                node.root,
                input.pending,
                input.dueThisLock,
                rootFrame,
                mode,
              );
              totalNodes += 1;
              if (child === null) continue;
              if (mode === "corrected" && child.fatal) {
                const prevFatal = bestFatalByRoot.get(child.root);
                if (
                  prevFatal === undefined ||
                  child.depth > prevFatal.depth ||
                  (child.depth === prevFatal.depth && child.value > prevFatal.value)
                ) {
                  bestFatalByRoot.set(child.root, child);
                }
                continue;
              }
              cChildren.push(child);
            }
          }
        }
        cChildren.sort((a, b) => b.value - a.value);
        // 1 slot per missing root guarantees matched-horizon completion quickly.
        cBeam = selectBeamWithRootFloor(cChildren, cBeam.length, mode);
        for (const node of cBeam) {
          cDeepestByRoot.set(node.root, node);
        }
      }
      for (const leaf of cFinished) {
        const prev = rootBestComplete.get(leaf.root);
        if (prev === undefined || leaf.value > prev.value) rootBestComplete.set(leaf.root, leaf);
      }
      for (const [rIdx, deep] of cDeepestByRoot.entries()) {
        if (!rootBestComplete.has(rIdx) && !bestFatalByRoot.has(rIdx)) {
          rootBestComplete.set(rIdx, deep);
        }
      }
    }
  }

  let searchResult: SearchResult | null = null;
  if (bestLeaf !== null) {
    const line: Step[] = [];
    for (let n: SimNode | null = bestLeaf; n !== null && n.step !== null; n = n.parent) {
      line.unshift(n.step);
    }
    const first = firstMoves[bestLeaf.root] as SimNode;
    const candidatesSource =
      rootBestAlive.size > 0
        ? rootBestAlive
        : new Map([...bestFatalByRoot.entries()].map(([k, v]) => [k, v]));
    const candidates: Candidate[] = [...candidatesSource.entries()]
      .map(([index, leaf]) => {
        const n = firstMoves[index] as SimNode;
        const step = n.step as Step;
        return { placement: step.placement, usedHold: step.usedHold, value: leaf.value };
      })
      .sort((a, b) => b.value - a.value);

    const firstFeat = boardFeatures(first.board, first.lift);
    const breakdown: Record<string, number> = {};
    for (const name of BOARD_FEATURES) breakdown[name] = firstFeat[name] * w.board[name];

    searchResult = {
      best: line[0] as Step,
      line,
      value: bestLeaf.value,
      breakdown,
      candidates,
      nodes: beamNodes,
      depth: bestLeaf.depth,
    };
  }

  const reports: RootCandidateReport[] = [];
  for (let i = 0; i < firstMoves.length; i += 1) {
    const fm = firstMoves[i] as SimNode;
    const step = fm.step as Step;
    const aliveLeaf = rootBestAlive.get(i);
    const completeLeaf = rootBestComplete.get(i) ?? bestFatalByRoot.get(i) ?? fm;
    const { phi24, phi34 } = buildLeafPhi(completeLeaf, w.discount, rootFrame);
    reports.push({
      witnessKey: witnessActionKey(step.placement, step.usedHold),
      semanticKey: semanticActionKey(step.placement, step.usedHold, step.placement.tspin),
      cellKey: cellHoldKey(step.placement, step.usedHold),
      placement: step.placement,
      usedHold: step.usedHold,
      spin: step.placement.tspin,
      rootSolvencyMargin: fm.rootSolvencyMargin,
      minSolvencyMargin: completeLeaf.minSolvencyMargin,
      fatalAtRoot: fm.fatal,
      fatalOnBestPath: completeLeaf.fatal,
      pruningDepth: maxDepthByRoot[i] ?? 1,
      survivedBeam: aliveLeaf !== undefined,
      beamValue: aliveLeaf ? aliveLeaf.value : null,
      completeValue: completeLeaf.value,
      phi34,
      phi24,
      stepCount: completeLeaf.depth,
    });
  }

  return {
    variant,
    searchResult,
    nodes: totalNodes,
    depth: bestLeaf?.depth ?? 0,
    candidates: reports.sort((a, b) => b.completeValue - a.completeValue),
    maxHeightRoot: rootFeatures.maxHeight,
  };
}
