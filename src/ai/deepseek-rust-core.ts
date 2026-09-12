/**
 * WASM-backed DeepSeek v2 `DeepSeekV2` fighter.
 *
 * Wraps the verified Rust port (`rust/deepseek-rust` + `rust/deepseek-wasm`)
 * via its single-call-per-move `ds_best_move` ABI. The host marshals a
 * `GameSnapshot` into the `DsInput` `#[repr(C)]` layout, calls `ds_best_move`,
 * and rebuilds a faithful `placeAt` execution plan (landing row + T-spin
 * `lastSrs`) from the returned root-placement detail, so the controller runs
 * the exact same placement TS v2 would.
 */

import type { Board } from "../core/board.js";
import { cellsFor } from "../core/pieces.js";
import type { AiDebug, AiExecutionPlan, AiMove, GameSnapshot, PieceKind } from "../ui/types.js";
import { ROWS } from "../ui/types.js";
import { boardFingerprint } from "../versus/controller.js";
import { toBoard } from "./deepseek.js";
import {
  DEEPSEEK_V2_NAME,
  type DeepSeekV2,
  type DeepSeekV2Options,
  isV2Tspin,
} from "./deepseek-v2.js";

const NEXT_SLOTS = 28;
const OPP_SLOTS = 7;

const DEFAULT_DEPTH = 7;
const DEFAULT_WIDTH = 24;
const DEFAULT_TOP_K = 16;

const PIECE_CODE: Readonly<Record<PieceKind, number>> = {
  I: 0,
  O: 1,
  T: 2,
  S: 3,
  Z: 4,
  J: 5,
  L: 6,
};

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  ds_alloc: (size: number) => number;
  ds_input_size: () => number;
  ds_output_size: () => number;
  ds_best_move: (inputPtr: number, outputPtr: number) => number;
}

export interface RustDeepSeekOut {
  readonly ok: number;
  readonly x: number;
  readonly rotation: number;
  readonly y: number;
  readonly useHold: number;
  readonly linesCleared: number;
  readonly isTspin: number;
  readonly searchDepth: number;
  readonly topHoles: number;
  readonly score: number;
  readonly fireScore: number;
  readonly topMaxHeight: number;
  readonly pieces: number;
}

class Writer {
  pos = 0;
  constructor(private readonly dv: DataView) {}
  i32(v: number): void {
    this.dv.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  i32s(vs: readonly number[]): void {
    for (const v of vs) this.i32(v);
  }
}

function maxNativeY(kind: PieceKind, rotation: number): number {
  let max = 0;
  for (const c of cellsFor(kind, rotation)) if (c.y > max) max = c.y;
  return max;
}

export class RustDeepSeekEngine {
  private readonly ex: WasmExports;
  private readonly inPtr: number;
  private readonly outPtr: number;
  private readonly inSize: number;
  private readonly outSize: number;

  readonly depth: number;
  readonly width: number;
  readonly topK: number;
  readonly useKicks: boolean;
  readonly useOpponent: boolean;
  readonly useGarbageDefense: boolean;
  readonly useDownstack: boolean;

  pieceIndex = 0;

  constructor(instance: WebAssembly.Instance, options: DeepSeekV2Options = {}) {
    const ex = instance.exports as WasmExports;
    this.ex = ex;
    this.inSize = ex.ds_input_size();
    this.outSize = ex.ds_output_size();
    this.inPtr = ex.ds_alloc(this.inSize);
    this.outPtr = ex.ds_alloc(this.outSize);
    this.depth = options.depth ?? DEFAULT_DEPTH;
    this.width = options.width ?? DEFAULT_WIDTH;
    this.topK = options.topK ?? DEFAULT_TOP_K;
    this.useKicks = options.useKicks ?? true;
    this.useOpponent = options.useOpponent ?? true;
    this.useGarbageDefense = options.useGarbageDefense ?? true;
    this.useDownstack = options.useDownstack ?? true;
  }

  reset(): void {
    this.pieceIndex = 0;
  }

  private writeInput(s: GameSnapshot, board: Board): void {
    const dv = new DataView(this.ex.memory.buffer, this.inPtr, this.inSize);
    const w = new Writer(dv);
    const rows = new Array<number>(20).fill(0);
    for (let y = 0; y < board.length && y < 20; y += 1) rows[y] = board[y] ?? 0;
    w.i32s(rows);
    w.i32(s.active === null ? -1 : PIECE_CODE[s.active.kind]);

    const next = new Array<number>(NEXT_SLOTS).fill(-1);
    let nextLen = 0;
    for (let i = 0; i < NEXT_SLOTS && i < s.next.length; i += 1) {
      const kind = s.next[i];
      if (kind === undefined) break;
      next[i] = PIECE_CODE[kind];
      nextLen += 1;
    }
    w.i32s(next);
    w.i32(nextLen);
    w.i32(s.hold === null ? -1 : PIECE_CODE[s.hold]);
    w.i32(s.canHold ? 1 : 0);
    w.i32(s.b2b ? 1 : 0);
    w.i32(s.combo);
    w.i32(s.pendingGarbage);
    w.i32(this.pieceIndex);

    const opp: readonly (number | undefined)[] = [
      s.opponentLockId,
      s.opponentLastClearLines,
      s.opponentLastNativeCombo,
      s.opponentLastNativeBtb,
      s.opponentLastRawAttack,
      s.opponentCombo,
      s.opponentBtb,
    ];
    for (let i = 0; i < OPP_SLOTS; i += 1) w.i32(opp[i] === undefined ? 0 : 1);
    for (let i = 0; i < OPP_SLOTS; i += 1) w.i32(opp[i] ?? 0);

    w.i32(this.depth);
    w.i32(this.width);
    w.i32(this.topK);
    w.i32(this.useKicks ? 1 : 0);
    w.i32(this.useOpponent ? 1 : 0);
    w.i32(this.useGarbageDefense ? 1 : 0);
    w.i32(this.useDownstack ? 1 : 0);
    if (w.pos !== this.inSize) throw new Error(`deepseek input layout ${w.pos} != ${this.inSize}`);
  }

  private readOut(): RustDeepSeekOut {
    const dv = new DataView(this.ex.memory.buffer, this.outPtr, this.outSize);
    let p = 0;
    const rd = (): number => {
      const v = dv.getInt32(p, true);
      p += 4;
      return v;
    };
    const ok = rd();
    const x = rd();
    const rotation = rd();
    const y = rd();
    const useHold = rd();
    const linesCleared = rd();
    const isTspin = rd();
    const searchDepth = rd();
    const topHoles = rd();
    rd();
    const score = dv.getFloat64(p, true);
    p += 8;
    const fireScore = dv.getFloat64(p, true);
    p += 8;
    const topMaxHeight = dv.getFloat64(p, true);
    p += 8;
    if (p !== this.outSize) throw new Error(`deepseek output layout ${p} != ${this.outSize}`);
    return {
      ok,
      x,
      rotation,
      y,
      useHold,
      linesCleared,
      isTspin,
      searchDepth,
      topHoles,
      score,
      fireScore,
      topMaxHeight,
      pieces: this.pieceIndex,
    };
  }

  search(s: GameSnapshot): { out: RustDeepSeekOut; board: Board } {
    this.pieceIndex += 1;
    const board = toBoard(s);
    this.writeInput(s, board);
    const rc = this.ex.ds_best_move(this.inPtr, this.outPtr);
    const out = this.readOut();
    if (out.ok !== 1 || rc !== 1) {
      throw new Error(`ds_best_move failed (ok=${out.ok} rc=${rc})`);
    }
    return { out, board };
  }
}

function moveFromOut(s: GameSnapshot, out: RustDeepSeekOut, board: Board): AiMove | null {
  const active = s.active;
  if (active === null) return null;
  const rotation = ((out.rotation % 4) + 4) % 4;
  if (out.useHold === 1) {
    return { targetX: out.x, targetRotation: rotation, useHold: true };
  }
  const topRow = ROWS - 1 - maxNativeY(active.kind, rotation) - out.y;
  const lastSrs = isV2Tspin(board, active.kind, rotation, out.x, out.y) ? 1 : 0;
  const execution: AiExecutionPlan = {
    targetX: out.x,
    targetRotation: rotation,
    steps: [{ kind: "placeAt", rotation, x: out.x, topRow, lastSrs }],
    expectedBoard: [],
    expectedLinesCleared: 0,
    sourceActiveKind: active.kind,
    sourceRotation: 0,
    sourceX: 3,
    sourceBoardFingerprint: boardFingerprint(s),
    sourceHold: s.hold,
    sourceCanHold: s.canHold,
  };
  return { targetX: out.x, targetRotation: rotation, useHold: false, execution };
}

export interface RustDeepSeekFighter extends DeepSeekV2 {
  readonly engine: RustDeepSeekEngine;
  searchSnapshot(
    s: GameSnapshot,
  ): { out: RustDeepSeekOut; move: AiMove | null; board: Board } | null;
}

export function makeRustDeepSeekV2(
  instance: WebAssembly.Instance,
  options: DeepSeekV2Options = {},
): RustDeepSeekFighter {
  const engine = new RustDeepSeekEngine(instance, options);
  let debug: AiDebug | null = null;

  const fighter: RustDeepSeekFighter = {
    name: DEEPSEEK_V2_NAME,
    engine,
    searchSnapshot(s: GameSnapshot) {
      if (s.active === null || s.gameOver) return null;
      const t0 = performance.now();
      const { out, board } = engine.search(s);
      const move = moveFromOut(s, out, board);
      debug = {
        score: out.score,
        fireScore: out.fireScore,
        linesCleared: out.linesCleared,
        isTspin: out.isTspin === 1,
        opener: null,
        topHoles: out.topHoles,
        topMaxHeight: out.topMaxHeight,
        thinkMs: performance.now() - t0,
        pieceIndex: out.pieces,
        searchDepth: out.searchDepth,
      };
      return { out, move, board };
    },
    findBestMove(s: GameSnapshot): AiMove | null {
      return fighter.searchSnapshot(s)?.move ?? null;
    },
    getDebug(): AiDebug | null {
      return debug;
    },
    reset(): void {
      engine.reset();
      debug = null;
    },
  };
  return fighter;
}
