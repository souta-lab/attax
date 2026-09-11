/**
 * VersusFighter adapter around the native Hoiko engine (src/ai/native).
 *
 * Maps a `GameSnapshot` into `NativeInput` (native bit orientation), runs the
 * reconstructed SearchAI, and returns an `AiMove`. Hold requests are surfaced
 * via `useHold`; the controller performs the hold and re-thinks (the adapter
 * disables the search's hold pass when `canHold` is false to avoid loops).
 */

import type { AiDebug, AiMove, GameSnapshot } from "../ui/types.js";
import { ROWS } from "../ui/types.js";
import type { VersusFighter } from "../versus/controller.js";
import type { PieceKind } from "../core/pieces.js";
import { HOIKO_DEFAULT_PRESET, type HoikoPreset, type HoikoWeights } from "./hoiko-weights.js";
import { searchNative, type NativeInput, type SearchState } from "./native/index.js";
import { defaultSearchState } from "./native/search.js";

const HOIKO_COLOR = "#e94fb0";

export interface HoikoNativeOptions {
  readonly weightPreset?: HoikoPreset | undefined;
  readonly weights?: readonly HoikoWeights[] | undefined;
  readonly timeLimitMs?: number | undefined;
  readonly viewNext?: number | undefined;
}

interface DebugState {
  score: number;
  depth: number;
  nodes: number;
  thinkMs: number;
}

function toNativeRows(s: GameSnapshot): number[] {
  const rows: number[] = [];
  for (let y = 0; y < s.board.rows; y += 1) {
    const src = s.board.grid[s.board.rows - 1 - y];
    let bits = 0;
    for (let x = 0; x < 10; x += 1) if ((src?.[x] ?? 0) !== 0) bits |= 1 << (9 - x);
    rows.push(bits);
  }
  return rows;
}

function boardFingerprint(s: GameSnapshot): string {
  const rows: number[] = [];
  for (let y = 0; y < s.board.rows; y += 1) {
    const row = s.board.grid[s.board.rows - 1 - y];
    let bits = 0;
    for (let x = 0; x < 10; x += 1) if ((row?.[x] ?? 0) !== 0) bits |= 1 << x;
    rows.push(bits);
  }
  return rows.join(",");
}

function toNativeInput(s: GameSnapshot): NativeInput | null {
  if (s.active === null) return null;
  const queue: readonly PieceKind[] = s.next;
  return {
    board: toNativeRows(s),
    current: s.active.kind,
    queue,
    hold: s.hold,
    combo: s.nativeCombo,
    btb: s.nativeBtb,
  };
}

function boardStats(grid: GameSnapshot["board"]["grid"], rows: number): {
  holes: number;
  maxHeight: number;
} {
  let maxHeight = 0;
  let holes = 0;
  for (let x = 0; x < 10; x += 1) {
    let seen = false;
    for (let y = 0; y < rows; y += 1) {
      const filled = (grid[y]?.[x] ?? 0) !== 0;
      if (filled) {
        seen = true;
        maxHeight = Math.max(maxHeight, rows - y);
      } else if (seen) {
        holes += 1;
      }
    }
  }
  return { holes, maxHeight };
}

export function createHoikoNative(options: HoikoNativeOptions = {}): VersusFighter {
  const state: SearchState = defaultSearchState();
  const weightList = options.weights;
  const weightPreset = options.weightPreset ?? HOIKO_DEFAULT_PRESET;
  const timeLimitMs = options.timeLimitMs;
  const viewNext = options.viewNext;
  let debug: DebugState | null = null;
  let lastSnapshot: GameSnapshot | null = null;

  return {
    name: "HOIKO-NATIVE",
    color: HOIKO_COLOR,
    findBestMove: (s: GameSnapshot): AiMove | null => {
      const t0 = performance.now();
      const active = s.active;
      if (active === null || s.gameOver) return null;
      const input = toNativeInput(s);
      if (input === null) return null;
      const run = searchNative(input, {
        searchState: state,
        ...(weightList === undefined ? {} : { weights: weightList }),
        ...(weightList === undefined ? { weightPreset } : {}),
        ...(timeLimitMs === undefined ? {} : { timeLimitMs }),
        ...(viewNext === undefined ? {} : { viewNext }),
        allowHold: s.canHold,
        adapt: true,
      });
      if (run === null) return null;
      const o = run.outcome;
      const rotation = ((o.firstR % 4) + 4) % 4;
      debug = { score: o.score, depth: o.depth, nodes: o.node, thinkMs: performance.now() - t0 };
      lastSnapshot = s;
      if (o.firstHold) {
        return { targetX: o.firstX, targetRotation: rotation, useHold: true };
      }
      const landing = o.firstPlacement;
      const placeStep = {
        kind: "placeAt",
        rotation,
        x: o.firstX,
        topRow: ROWS - 1 - landing.y,
        lastSrs: landing.lastSrs,
      } as const;
      return {
        targetX: o.firstX,
        targetRotation: rotation,
        useHold: false,
        execution: {
          targetX: o.firstX,
          targetRotation: rotation,
          steps: [placeStep],
          expectedBoard: [],
          expectedLinesCleared: 0,
          sourceActiveKind: active.kind,
          sourceRotation: active.rotation,
          sourceX: active.posX,
          sourceBoardFingerprint: boardFingerprint(s),
          sourceHold: s.hold,
          sourceCanHold: s.canHold,
        },
      };
    },
    getDebug: (): AiDebug | null => {
      if (debug === null) return null;
      const stats =
        lastSnapshot === null
          ? { holes: 0, maxHeight: 0 }
          : boardStats(lastSnapshot.board.grid, lastSnapshot.board.rows);
      return {
        score: debug.score,
        fireScore: 0,
        linesCleared: 0,
        isTspin: false,
        opener: null,
        topHoles: stats.holes,
        topMaxHeight: stats.maxHeight,
        thinkMs: debug.thinkMs,
      };
    },
  };
}
