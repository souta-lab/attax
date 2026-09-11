/**
 * WASM-backed Hoiko `VersusFighter`.
 *
 * Wraps the verified Rust port (`rust/hoiko-core` + `rust/hoiko-wasm`) via its
 * single-call-per-move `h_search` ABI. The host marshals a `GameSnapshot` into
 * the `HSearchInput` `#[repr(C)]` layout (byte order copied verbatim from
 * `/tmp/opencode/re/rustdiff/search_diff.ts`, whose TS-vs-Rust first-move
 * differential is 42/42 identical), calls `h_search`, and carries the returned
 * `SearchState` + `OffsetOffAI` fields into the next call so beam adaptation and
 * garbage offsetting persist across moves.
 *
 * The `GameSnapshot -> input` mapping, `placeAt` execution and offset sync
 * bookkeeping mirror the retired TS engine (archived at
 * `/tmp/opencode/re/ts-native-snapshot/`).
 */

import type {
  AiDebug,
  AiExecutionPlan,
  AiExecutionStep,
  AiMove,
  GameSnapshot,
  LockAction,
} from "../ui/types.js";
import { ROWS } from "../ui/types.js";
import type { VersusFighter } from "../versus/controller.js";
import { hoikoWeightList, type HoikoPreset, type HoikoWeights } from "./hoiko-weights.js";
import { MINO_NONE, kindToMino, type MinoType } from "./mino-codes.js";

const HOIKO_DEFAULT_PRESET: HoikoPreset = "we";

/** Binary frame clock: `Memory.GetMatchFrames()` ~= wall ms * 0.06 (60 fps). */
const GAME_FRAMES_PER_MS = 0.06;
const MAX_WEIGHTS = 4;
const MAX_PLAN_ACTS = 16;

const HOIKO_COLOR = "#e94fb0";

const LOCK_ACTION_CODE: Readonly<Record<LockAction, number>> = {
  None: 0,
  Single: 1,
  Double: 2,
  Triple: 3,
  Quad: 4,
  Tss: 5,
  Tsd: 6,
  Tst: 7,
  Tsm: 8,
  Pc: 9,
};

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  h_alloc: (size: number) => number;
  h_search_input_size: () => number;
  h_search_output_size: () => number;
  h_search: (inputPtr: number, outputPtr: number) => number;
}

/** Byte-order writer matching `search_diff.ts` `Writer` (LE). */
class Writer {
  pos = 0;
  constructor(private readonly dv: DataView) {}
  f64(v: number): void {
    this.dv.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  i32(v: number): void {
    this.dv.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  i32s(vs: readonly number[]): void {
    for (const v of vs) this.i32(v);
  }
}

export interface RustOut {
  readonly ok: number;
  readonly x: number;
  readonly rotation: number;
  readonly y: number;
  readonly lastSrs: number;
  readonly useHold: number;
  readonly firstRRaw: number;
  readonly firstM: number;
  readonly firstAct: number;
  readonly moveDelay: number;
  readonly planActs: readonly number[];
  readonly planLen: number;
  readonly score: number;
  readonly depth: number;
  readonly node: number;
  readonly garbageWait: number;
  readonly maxBeamSize: number;
  readonly beamSizeLimit: number;
  readonly timerLimitMs: number;
  readonly weightIndex: number;
  readonly useOffsetOff: number;
  readonly ofsCanWait: number;
  readonly ofsCenter4: number;
  readonly ofsAtk: number;
  readonly ofsPcChance: number;
  readonly ofsNearOffset: number;
  readonly gbOpponentsAtk: number;
  readonly gbCoolTime: number;
  readonly gbRemainingTime: number;
  readonly gbOpponentsLockCount: number;
  readonly gbFirstInvalidLock: number;
  readonly hasLastOwnLock: number;
  readonly lastOwnLockId: number;
  readonly hasLastOppLock: number;
  readonly lastOppLockId: number;
}

/** Snapshot-derived offset driver inputs (mirrors `HoikoOffsetDriver.sync`). */
export interface SyncFields {
  readonly lockId: number;
  readonly lastAction: LockAction;
  readonly lastAttack: number;
  readonly opponentLockId: number | undefined;
  readonly opponentLastClearLines: number | undefined;
  readonly opponentLastNativeBtb: number | undefined;
  readonly opponentLastNativeCombo: number | undefined;
}

export interface RawSearchRequest {
  /** Native bottom-up rows (row 0 = bottom), column c = bit (9-c). Up to 32. */
  readonly board: readonly number[];
  readonly current: number;
  /** Queue AFTER the current piece, up to 28 entries. */
  readonly next: readonly number[];
  readonly hold: number;
  readonly combo: number;
  readonly btb: number;
  readonly isEven: boolean;
  readonly useS4W: boolean;
  readonly viewNext: number;
  readonly allowHold: boolean;
  readonly depth: number;
}

export interface RustHoikoOptions {
  readonly beamSizeLimit?: number | undefined;
  readonly weightPreset?: HoikoPreset | undefined;
  readonly weights?: readonly HoikoWeights[] | undefined;
  /** OffsetOffAI garbage management. Default true (mirrors hoiko-native.ts). */
  readonly offset?: boolean | undefined;
  readonly viewNext?: number | undefined;
  readonly isEvenBoard?: boolean | undefined;
  readonly depthLimit?: number | undefined;
  /** Deterministic virtual frame clock: game frames advanced per think. */
  readonly framesPerThink?: number | undefined;
}

/**
 * Owns the persistent engine state: the wasm buffers plus the `SearchState` and
 * `OffsetOffAI` fields that `h_search` carries in/out on every call.
 */
export class RustHoikoEngine {
  private readonly ex: WasmExports;
  private readonly inPtr: number;
  private readonly outPtr: number;
  private readonly inSize: number;
  private readonly outSize: number;
  private readonly weights: readonly HoikoWeights[];

  // --- carried SearchState (initial = defaultSearchState) ---
  private weightIndex = 0;
  private maxBeamSize = 50;
  private beamSizeLimit: number;
  private timerLimitMs = 1000;
  // --- carried OffsetOffAI ---
  private useOffsetOff: number;
  private ofsCanWait = 0;
  private ofsCenter4 = 0;
  private ofsAtk = 0;
  private ofsPcChance = 0;
  private ofsNearOffset = 0;
  private gbOpponentsAtk = 0;
  private gbCoolTime = 0;
  private gbRemainingTime = 0;
  private gbOpponentsLockCount = 0;
  private gbFirstInvalidLock = 0;
  private hasLastOwnLock = 0;
  private lastOwnLockId = 0;
  private hasLastOppLock = 0;
  private lastOppLockId = 0;

  /** Deterministic frame clock (ms), advanced per think. */
  frameMs = 0;

  readonly depthLimit: number;
  readonly viewNext: number;
  readonly isEvenBoard: boolean;
  readonly offsetEnabled: number;
  readonly framesPerThink: number;

  constructor(instance: WebAssembly.Instance, options: RustHoikoOptions = {}) {
    const ex = instance.exports as WasmExports;
    this.ex = ex;
    this.inSize = ex.h_search_input_size();
    this.outSize = ex.h_search_output_size();
    this.inPtr = ex.h_alloc(this.inSize);
    this.outPtr = ex.h_alloc(this.outSize);
    this.weights = options.weights ?? hoikoWeightList(options.weightPreset ?? HOIKO_DEFAULT_PRESET);
    this.beamSizeLimit = options.beamSizeLimit ?? 150;
    this.depthLimit = options.depthLimit ?? 14;
    this.viewNext = options.viewNext ?? 2;
    this.isEvenBoard = options.isEvenBoard ?? true;
    this.framesPerThink = options.framesPerThink ?? 20;
    const offset = options.offset ?? true;
    this.offsetEnabled = offset ? 1 : 0;
    this.useOffsetOff = offset ? 1 : 0;
  }

  /** Fill `HSearchInput` in exact declaration order (see ffi/layout.rs). */
  private writeInput(req: RawSearchRequest, sync: SyncFields, pendingGarbage: number): void {
    const dv = new DataView(this.ex.memory.buffer, this.inPtr, this.inSize);
    const w = new Writer(dv);
    for (let k = 0; k < MAX_WEIGHTS; k += 1) w.f64(this.weights[k]?.nexus ?? 0);
    for (let k = 0; k < MAX_WEIGHTS; k += 1) w.i32s(this.weights[k]?.weight ?? new Array(50).fill(0));
    for (let k = 0; k < MAX_WEIGHTS; k += 1) w.i32s(this.weights[k]?.column ?? new Array(10).fill(0));
    for (let k = 0; k < MAX_WEIGHTS; k += 1) w.i32s(this.weights[k]?.comboTable ?? new Array(5).fill(0));
    w.i32(MAX_WEIGHTS);
    const board = new Array<number>(32).fill(0);
    for (let y = 0; y < req.board.length && y < 32; y += 1) board[y] = req.board[y] ?? 0;
    w.i32s(board);
    w.i32(req.current);
    const queue = new Array<number>(28).fill(MINO_NONE);
    for (let i = 0; i < 28 && i < req.next.length; i += 1) queue[i] = req.next[i] ?? MINO_NONE;
    w.i32s(queue);
    w.i32(req.hold);
    w.i32(req.combo);
    w.i32(req.btb);
    w.i32(req.isEven ? 1 : 0);
    w.i32(req.useS4W ? 1 : 0);
    w.i32(req.viewNext);
    w.i32(req.allowHold ? 1 : 0);
    w.i32(this.weightIndex);
    w.i32(10); // min_depth
    w.i32(req.depth);
    w.i32(this.beamSizeLimit);
    w.i32(this.maxBeamSize);
    w.i32(this.timerLimitMs);
    w.i32(1000); // time_limit_ms (constant clock => depth-limited deterministically)
    const nowMs = Math.trunc(this.frameMs);
    w.i32(nowMs);
    w.i32(0); // adapt
    w.i32(this.offsetEnabled);
    w.i32(pendingGarbage);
    w.i32(this.useOffsetOff);
    w.i32(this.ofsCanWait);
    w.i32(this.ofsCenter4);
    w.i32(this.ofsAtk);
    w.i32(this.ofsPcChance);
    w.i32(this.ofsNearOffset);
    w.i32(this.gbOpponentsAtk);
    w.i32(this.gbCoolTime);
    w.i32(this.gbRemainingTime);
    w.i32(this.gbOpponentsLockCount);
    w.i32(this.gbFirstInvalidLock);
    w.i32(this.hasLastOwnLock);
    w.i32(this.lastOwnLockId);
    w.i32(this.hasLastOppLock);
    w.i32(this.lastOppLockId);
    w.i32(1); // sync_enabled
    w.i32(sync.lockId);
    w.i32(LOCK_ACTION_CODE[sync.lastAction] ?? 0);
    w.i32(sync.lastAttack);
    w.i32(sync.opponentLockId === undefined ? 0 : 1);
    w.i32(sync.opponentLockId ?? 0);
    w.i32(sync.opponentLastClearLines ?? 0);
    w.i32(sync.opponentLastNativeBtb ?? 0);
    w.i32(sync.opponentLastNativeCombo ?? 0);
    w.i32(nowMs); // sync_now_ms
    w.i32(0); // trailing struct padding (IN_SIZE includes 4 B align pad)
    if (w.pos !== this.inSize) throw new Error(`input layout ${w.pos} != ${this.inSize}`);
  }

  /** Parse `HSearchOutput` in exact declaration order. */
  private readOut(): RustOut {
    const dv = new DataView(this.ex.memory.buffer, this.outPtr, this.outSize);
    let p = 8; // skip f64 over_time
    const rd = (): number => {
      const v = dv.getInt32(p, true);
      p += 4;
      return v;
    };
    const ok = rd();
    const x = rd();
    const rotation = rd();
    const y = rd();
    const lastSrs = rd();
    const useHold = rd();
    const firstRRaw = rd();
    const firstM = rd();
    const firstAct = rd();
    const moveDelay = rd();
    const planActs: number[] = [];
    for (let i = 0; i < MAX_PLAN_ACTS; i += 1) planActs.push(rd());
    const planLen = rd();
    const score = rd();
    const depth = rd();
    const node = rd();
    const garbageWait = rd();
    const maxBeamSize = rd();
    const beamSizeLimit = rd();
    const timerLimitMs = rd();
    const weightIndex = rd();
    const useOffsetOff = rd();
    const ofsCanWait = rd();
    const ofsCenter4 = rd();
    const ofsAtk = rd();
    const ofsPcChance = rd();
    const ofsNearOffset = rd();
    const gbOpponentsAtk = rd();
    const gbCoolTime = rd();
    const gbRemainingTime = rd();
    const gbOpponentsLockCount = rd();
    const gbFirstInvalidLock = rd();
    const hasLastOwnLock = rd();
    const lastOwnLockId = rd();
    const hasLastOppLock = rd();
    const lastOppLockId = rd();
    return {
      ok,
      x,
      rotation,
      y,
      lastSrs,
      useHold,
      firstRRaw,
      firstM,
      firstAct,
      moveDelay,
      planActs,
      planLen,
      score,
      depth,
      node,
      garbageWait,
      maxBeamSize,
      beamSizeLimit,
      timerLimitMs,
      weightIndex,
      useOffsetOff,
      ofsCanWait,
      ofsCenter4,
      ofsAtk,
      ofsPcChance,
      ofsNearOffset,
      gbOpponentsAtk,
      gbCoolTime,
      gbRemainingTime,
      gbOpponentsLockCount,
      gbFirstInvalidLock,
      hasLastOwnLock,
      lastOwnLockId,
      hasLastOppLock,
      lastOppLockId,
    };
  }

  /** One `h_search`; carries all SearchState + OffsetOffAI fields forward. */
  search(req: RawSearchRequest, sync: SyncFields, pendingGarbage: number): RustOut {
    this.writeInput(req, sync, pendingGarbage);
    const rc = this.ex.h_search(this.inPtr, this.outPtr);
    const out = this.readOut();
    if (out.ok !== 1 || rc !== 1) {
      throw new Error(`h_search failed (ok=${out.ok} rc=${rc})`);
    }
    this.weightIndex = out.weightIndex;
    this.maxBeamSize = out.maxBeamSize;
    this.beamSizeLimit = out.beamSizeLimit;
    this.timerLimitMs = out.timerLimitMs;
    this.useOffsetOff = out.useOffsetOff;
    this.ofsCanWait = out.ofsCanWait;
    this.ofsCenter4 = out.ofsCenter4;
    this.ofsAtk = out.ofsAtk;
    this.ofsPcChance = out.ofsPcChance;
    this.ofsNearOffset = out.ofsNearOffset;
    this.gbOpponentsAtk = out.gbOpponentsAtk;
    this.gbCoolTime = out.gbCoolTime;
    this.gbRemainingTime = out.gbRemainingTime;
    this.gbOpponentsLockCount = out.gbOpponentsLockCount;
    this.gbFirstInvalidLock = out.gbFirstInvalidLock;
    this.hasLastOwnLock = out.hasLastOwnLock;
    this.lastOwnLockId = out.lastOwnLockId;
    this.hasLastOppLock = out.hasLastOppLock;
    this.lastOppLockId = out.lastOppLockId;
    this.frameMs += Math.round(this.framesPerThink / GAME_FRAMES_PER_MS);
    return out;
  }
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

function cosmeticSteps(
  fromRotation: number,
  fromX: number,
  toRotation: number,
  toX: number,
): readonly AiExecutionStep[] {
  const steps: AiExecutionStep[] = [];
  const cur = ((fromRotation % 4) + 4) % 4;
  const cw = (toRotation - cur + 4) % 4;
  const ccw = (cur - toRotation + 4) % 4;
  for (let i = 0; i < (cw <= ccw ? cw : ccw); i += 1) {
    steps.push({ kind: cw <= ccw ? "rotateCW" : "rotateCCW" });
  }
  for (let i = 0; i < Math.abs(toX - fromX); i += 1) {
    steps.push({ kind: toX < fromX ? "left" : "right" });
  }
  return steps;
}

export interface RustHoikoFighter extends VersusFighter {
  readonly engine: RustHoikoEngine;
  /** Runs the adapter end-to-end and returns both the raw Rust output and the `AiMove`. */
  searchSnapshot(s: GameSnapshot): { out: RustOut; move: AiMove | null; req: RawSearchRequest } | null;
}

export function rawRequestFromSnapshot(s: GameSnapshot, engine: RustHoikoEngine): RawSearchRequest | null {
  if (s.active === null) return null;
  const next: number[] = [];
  for (const k of s.next) next.push(kindToMino(k));
  return {
    board: toNativeRows(s),
    current: kindToMino(s.active.kind),
    next,
    hold: s.hold === null ? MINO_NONE : (kindToMino(s.hold) as MinoType),
    combo: s.nativeCombo,
    btb: s.nativeBtb,
    isEven: engine.isEvenBoard,
    useS4W: false,
    viewNext: engine.viewNext,
    allowHold: s.canHold,
    depth: engine.depthLimit,
  };
}

export function syncFromSnapshot(s: GameSnapshot): SyncFields {
  return {
    lockId: s.lockId,
    lastAction: s.lastAction,
    lastAttack: s.lastAttack,
    opponentLockId: s.opponentLockId,
    opponentLastClearLines: s.opponentLastClearLines,
    opponentLastNativeBtb: s.opponentLastNativeBtb,
    opponentLastNativeCombo: s.opponentLastNativeCombo,
  };
}

function moveFromOut(s: GameSnapshot, out: RustOut): AiMove | null {
  const active = s.active;
  if (active === null) return null;
  const rotation = ((out.firstRRaw % 4) + 4) % 4;
  const garbageWait = out.garbageWait === 1;
  if (out.useHold === 1) {
    return { targetX: out.x, targetRotation: rotation, useHold: true, garbageWait };
  }
  const moveSteps = cosmeticSteps(active.rotation, active.posX, rotation, out.x);
  const placeStep = {
    kind: "placeAt",
    rotation,
    x: out.x,
    topRow: ROWS - 1 - out.y,
    lastSrs: out.lastSrs,
  } as const;
  const execution: AiExecutionPlan = {
    targetX: out.x,
    targetRotation: rotation,
    steps: [...moveSteps, placeStep],
    expectedBoard: [],
    expectedLinesCleared: 0,
    sourceActiveKind: active.kind,
    sourceRotation: active.rotation,
    sourceX: active.posX,
    sourceBoardFingerprint: boardFingerprint(s),
    sourceHold: s.hold,
    sourceCanHold: s.canHold,
  };
  return { targetX: out.x, targetRotation: rotation, useHold: false, garbageWait, execution };
}

export function makeRustHoiko(
  instance: WebAssembly.Instance,
  options: RustHoikoOptions = {},
): RustHoikoFighter {
  const engine = new RustHoikoEngine(instance, options);
  let debug: { score: number; depth: number; nodes: number; thinkMs: number } | null = null;

  const fighter: RustHoikoFighter = {
    name: "HOIKO-RUST",
    color: HOIKO_COLOR,
    engine,
    searchSnapshot(s: GameSnapshot): { out: RustOut; move: AiMove | null; req: RawSearchRequest } | null {
      if (s.active === null || s.gameOver) return null;
      const req = rawRequestFromSnapshot(s, engine);
      if (req === null) return null;
      const t0 = performance.now();
      const out = engine.search(req, syncFromSnapshot(s), s.pendingGarbage);
      debug = { score: out.score, depth: out.depth, nodes: out.node, thinkMs: performance.now() - t0 };
      return { out, move: moveFromOut(s, out), req };
    },
    findBestMove(s: GameSnapshot): AiMove | null {
      return fighter.searchSnapshot(s)?.move ?? null;
    },
    getDebug: (): AiDebug | null =>
      debug === null
        ? null
        : {
            score: debug.score,
            fireScore: 0,
            linesCleared: 0,
            isTspin: false,
            opener: null,
            topHoles: 0,
            topMaxHeight: 0,
            thinkMs: debug.thinkMs,
          },
  };
  return fighter;
}
