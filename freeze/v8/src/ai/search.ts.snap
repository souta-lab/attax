/** 1-ply full enumeration + optional Next 2-ply. Self-contained bitboard search. */

import { type Board, collides, computeLockAfterstate, dropY } from "../core/board.js";
import { bottomCellsOf, cellsFor, type PieceKind, rotationCount } from "../core/pieces.js";
import { asRotation, kickTable } from "../core/srs.js";
import type { AiExecutionPlan, AiExecutionStep } from "../ui/types.js";
import { beamBestMove } from "./beam.js";
import { extractFeatures, type FeatureVector } from "./features.js";
import { FULL_ROW, ROWS } from "./types.js";
import { DU_WEIGHTS, scorePlacement, type Weights } from "./weights.js";

export function bottomCells(kind: PieceKind, rotation: number): ReturnType<typeof bottomCellsOf> {
  return bottomCellsOf(kind, rotation);
}

export const DEFAULT_WEIGHTS: Weights = DU_WEIGHTS;

export interface ScoredPlacement {
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly score: number;
  readonly linesCleared: number;
  readonly features: FeatureVector;
  readonly after: Board;
  readonly viaKick: boolean;
  readonly execution?: AiExecutionPlan;
}

export type PlacementGenerator = (board: Board, kind: PieceKind) => readonly ScoredPlacement[];

export interface SearchOptions {
  readonly weights?: Weights | undefined;
  readonly next?: PieceKind | null | undefined;
  readonly nextWeight?: number | undefined;
}

export function enumeratePlacements(board: Board, kind: PieceKind): ScoredPlacement[] {
  void FULL_ROW;
  return enumerateWithScore(board, kind, DU_WEIGHTS);
}

function enumerateWithScore(board: Board, kind: PieceKind, w: Weights): ScoredPlacement[] {
  const out: ScoredPlacement[] = [];
  const rots = rotationCount(kind);
  for (let r = 0; r < rots; r += 1) {
    const cells = bottomCells(kind, r);
    let minX = 0;
    let maxX = 0;
    for (const c of cells) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
    }
    for (let px = -minX; px < 10 - maxX; px += 1) {
      const startY = board.length + 4;
      if (collides(board, cells, px, startY)) continue;
      const y = dropY(board, cells, px, startY);
      pushPlacement(out, board, kind, cells, r, px, y, w, false);
    }
  }
  return out;
}

function pushPlacement(
  out: ScoredPlacement[],
  board: Board,
  kind: PieceKind,
  cells: ReturnType<typeof bottomCells>,
  r: number,
  px: number,
  y: number,
  w: Weights,
  viaKick: boolean,
  path?: readonly AiExecutionStep[],
): void {
  if (collides(board, cells, px, y)) return;
  const transition = computeLockAfterstate(board, cells, px, y);
  if (transition.topOut && transition.linesCleared === 0) return;
  const avgLanding = cells.reduce((s, c) => s + (y + c.y + 1), 0) / cells.length;
  const eroded = transition.linesCleared * transition.pieceCellsInClearedRows;
  const feat = extractFeatures(transition.after, avgLanding, eroded);
  const score = scorePlacement(feat, transition.linesCleared, w);
  const execution =
    path === undefined
      ? {}
      : {
          execution: {
            targetX: px,
            targetRotation: r,
            steps: [...path, { kind: "drop" as const }],
            expectedBoard: Array.from(transition.after),
            expectedLinesCleared: transition.linesCleared,
            sourceActiveKind: kind,
            sourceRotation: 0,
            sourceX: 3,
            sourceBoardFingerprint: Array.from(board, (row) => row & 0x3ff).join(","),
            sourceHold: null,
            sourceCanHold: true,
          },
        };
  out.push({
    rotation: r,
    x: px,
    y,
    score,
    linesCleared: transition.linesCleared,
    features: feat,
    after: transition.after,
    viaKick,
    ...execution,
  });
}

function placementKey(cells: ReturnType<typeof bottomCells>, px: number, y: number): string {
  const pts = cells
    .map((c) => `${px + c.x},${y + c.y}`)
    .sort()
    .join(";");
  return pts;
}

export function enumerateKickPlacements(board: Board, kind: PieceKind): ScoredPlacement[] {
  const out = enumerateWithScore(board, kind, DU_WEIGHTS);
  const hardCells = new Set<string>();
  for (const p of out) {
    const cells = bottomCells(kind, p.rotation);
    const key = placementKey(cells, p.x, restY(board, cells, p.x));
    hardCells.add(key);
  }
  const rots = rotationCount(kind);
  const startY = spawnSearchY(board, kind);
  for (let r = 0; r < rots; r += 1) {
    const cells = bottomCells(kind, r);
    const found = reachableLandings(board, kind, r, startY);
    for (const f of found) {
      const key = placementKey(cells, f.px, f.y);
      if (hardCells.has(key)) continue;
      pushPlacement(out, board, kind, cells, r, f.px, f.y, DU_WEIGHTS, true, f.path);
    }
  }
  return out;
}

function restY(board: Board, cells: ReturnType<typeof bottomCells>, px: number): number {
  const startY = board.length + 4;
  if (collides(board, cells, px, startY)) return startY;
  return dropY(board, cells, px, startY);
}

interface Landing {
  readonly px: number;
  readonly y: number;
  readonly path: readonly AiExecutionStep[];
}

function shapeHeight(kind: PieceKind, rotation: number): number {
  let maxY = 0;
  for (const cell of cellsFor(kind, rotation)) if (cell.y > maxY) maxY = cell.y;
  return maxY;
}

function spawnSearchY(board: Board, kind: PieceKind): number {
  return board.length - 1 - shapeHeight(kind, 0);
}

function reachableLandings(
  board: Board,
  kind: PieceKind,
  targetRot: number,
  startY: number,
): Landing[] {
  const out: Landing[] = [];
  if (collides(board, bottomCells(kind, 0), 3, startY)) return out;
  const seen = new Set<string>();
  interface State {
    readonly rot: number;
    readonly px: number;
    readonly y: number;
    readonly path: readonly AiExecutionStep[];
  }
  const queue: State[] = [{ rot: 0, px: 3, y: startY, path: [] }];
  seen.add(`0,3,${startY}`);
  let head = 0;
  let guard = 40000;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    guard -= 1;
    if (guard <= 0 || cur === undefined) break;
    const curCells = bottomCells(kind, cur.rot);
    if (cur.rot === targetRot && collides(board, curCells, cur.px, cur.y - 1)) {
      out.push({ px: cur.px, y: cur.y, path: cur.path });
    }
    for (const [dx, step] of [
      [-1, { kind: "left" }],
      [1, { kind: "right" }],
    ] as const) {
      const nxt: State = {
        rot: cur.rot,
        px: cur.px + dx,
        y: cur.y,
        path: [...cur.path, step],
      };
      const key = `${nxt.rot},${nxt.px},${nxt.y}`;
      if (seen.has(key)) continue;
      if (collides(board, bottomCells(kind, nxt.rot), nxt.px, nxt.y)) continue;
      seen.add(key);
      queue.push(nxt);
    }
    const down: State = {
      rot: cur.rot,
      px: cur.px,
      y: cur.y - 1,
      path: [...cur.path, { kind: "softDrop" }],
    };
    const downKey = `${down.rot},${down.px},${down.y}`;
    if (!seen.has(downKey) && !collides(board, bottomCells(kind, down.rot), down.px, down.y)) {
      seen.add(downKey);
      queue.push(down);
    }
    for (const dir of [1, -1] as const) {
      const from = asRotation(cur.rot);
      const to = asRotation(cur.rot + dir);
      const kicks = kickTable(kind, from, to);
      const kick = kicks.find((candidate) => {
        const nx = cur.px + candidate.dx;
        const ny = cur.y + candidate.dy + shapeHeight(kind, cur.rot) - shapeHeight(kind, to);
        return !collides(board, bottomCells(kind, to), nx, ny);
      });
      if (kick !== undefined) {
        const nx = cur.px + kick.dx;
        const ny = cur.y + kick.dy + shapeHeight(kind, cur.rot) - shapeHeight(kind, to);
        const key = `${to},${nx},${ny}`;
        if (!seen.has(key)) {
          seen.add(key);
          queue.push({
            rot: to,
            px: nx,
            y: ny,
            path: [...cur.path, { kind: dir === 1 ? "rotateCW" : "rotateCCW" }],
          });
        }
      }
    }
  }
  return out;
}

export function enumerateScored(board: Board, kind: PieceKind, w: Weights): ScoredPlacement[] {
  return enumerateWithScore(board, kind, w);
}

export function findBestPlacement(
  board: Board,
  current: PieceKind,
  options: SearchOptions = {},
): ScoredPlacement | null {
  const next = options.next ?? null;
  const weights = options.weights ?? DU_WEIGHTS;
  const list = enumerateWithScore(board, current, weights);
  if (list.length === 0) return null;
  if (next === null) {
    let best = list[0] as ScoredPlacement;
    for (const p of list) if (p.score > best.score) best = p;
    return best;
  }
  let best: ScoredPlacement | null = null;
  let bestTotal = Number.NEGATIVE_INFINITY;
  for (const p of list) {
    const cells = bottomCells(current, p.rotation);
    const y = dropY(board, cells, p.x, board.length + 4);
    if (collides(board, cells, p.x, y)) continue;
    const transition = computeLockAfterstate(board, cells, p.x, y);
    const replies = enumerateWithScore(transition.after, next, weights);
    let replyBest = Number.NEGATIVE_INFINITY;
    for (const r2 of replies) if (r2.score > replyBest) replyBest = r2.score;
    if (replyBest === Number.NEGATIVE_INFINITY) continue;
    const total = p.score + replyBest;
    if (total > bestTotal) {
      bestTotal = total;
      best = p;
    }
  }
  return best ?? list[0] ?? null;
}

export interface ScoreAiResult {
  readonly targetX: number;
  readonly targetRotation: number;
  readonly useHold: boolean;
  readonly score: number;
  readonly fireScore: number;
  readonly linesCleared: number;
  readonly holes: number;
  readonly maxHeight: number;
  readonly thinkMs: number;
}

/** UI adapter: snapshot grid (top row first) -> bitboard, returns target x/rotation. */
export function searchBestMove(snapshot: {
  readonly board: {
    readonly cols: number;
    readonly rows: number;
    readonly grid: readonly (readonly number[])[];
  };
  readonly active: {
    readonly kind: string;
    readonly rotation: number;
    readonly posX: number;
  } | null;
  readonly next: readonly string[];
  readonly hold?: string | null | undefined;
  readonly canHold?: boolean | undefined;
}): {
  readonly targetX: number;
  readonly targetRotation: number;
  readonly useHold: boolean;
} | null {
  return searchBestMoveDetailed(snapshot);
}

export function searchBestMoveDetailed(snapshot: {
  readonly board: {
    readonly cols: number;
    readonly rows: number;
    readonly grid: readonly (readonly number[])[];
  };
  readonly active: {
    readonly kind: string;
    readonly rotation: number;
    readonly posX: number;
  } | null;
  readonly next: readonly string[];
  readonly hold?: string | null | undefined;
  readonly canHold?: boolean | undefined;
}): ScoreAiResult | null {
  const active = snapshot.active;
  if (active === null) return null;
  const rows = snapshot.board.rows;
  const board: Board = new Uint16Array(ROWS);
  const gridRows = snapshot.board.grid;
  for (let y = 0; y < rows && y < ROWS; y += 1) {
    const srcRow = gridRows[rows - 1 - y];
    if (srcRow === undefined) continue;
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((srcRow[x] ?? 0) !== 0) bits |= 1 << x;
    }
    board[y] = bits;
  }
  const cur = active.kind as PieceKind;
  const queue = snapshot.next.slice(0, 5).filter((v): v is PieceKind => typeof v === "string");
  const holdRaw = snapshot.hold ?? null;
  const hold = (typeof holdRaw === "string" ? holdRaw : null) as PieceKind | null;
  const t0 = performance.now();
  const beam = beamBestMove(board, cur, queue, hold, snapshot.canHold ?? false, false, -1, {
    width: 24,
    depth: 6,
    topK: 16,
  });
  const thinkMs = performance.now() - t0;
  if (beam !== null) {
    return {
      targetX: beam.x,
      targetRotation: beam.rotation,
      useHold: beam.useHold,
      score: beam.score,
      fireScore: 0,
      linesCleared: 0,
      holes: 0,
      maxHeight: 0,
      thinkMs,
    };
  }
  const ranked = enumerateScored(board, cur, DU_WEIGHTS).sort((a, b) => b.score - a.score);
  const bestRanked = ranked[0];
  if (bestRanked === undefined) return null;
  return {
    targetX: bestRanked.x,
    targetRotation: bestRanked.rotation,
    useHold: false,
    score: bestRanked.score,
    fireScore: 0,
    linesCleared: bestRanked.linesCleared,
    holes: bestRanked.features.holes,
    maxHeight: bestRanked.features.maxHeight,
    thinkMs,
  };
}

export function createAi(): {
  readonly name: string;
  findBestMove(snapshot: Parameters<typeof searchBestMove>[0]): ReturnType<typeof searchBestMove>;
  getDebug(): import("../ui/types.js").AiDebug | null;
} {
  let last: ScoreAiResult | null = null;
  return {
    name: "beam24-hold",
    findBestMove: (s) => {
      const r = searchBestMoveDetailed(s);
      last = r;
      return r;
    },
    getDebug: () =>
      last === null
        ? null
        : {
            score: last.score,
            fireScore: last.fireScore,
            linesCleared: last.linesCleared,
            isTspin: false,
            opener: null,
            topHoles: last.holes,
            topMaxHeight: last.maxHeight,
            thinkMs: last.thinkMs,
          },
  };
}
