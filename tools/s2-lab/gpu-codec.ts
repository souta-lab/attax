/**
 * Codec between the S2 lab's shared search input / result shapes and the
 * GPU engine's binary formats (gpu/host/vkrunner_s26.c serve mode).
 *
 * Encoding: SearchInput -> the 108-word decision record. The reference
 * writer is m4-harness `genfull` (spike-side harness, cmd_genfull); this
 * encoder is verified byte-for-byte against its output over the full
 * 180-decision gate corpus (tools/s2-lab/gpu-gate.ts).
 *
 * Decoding: one serve response block -> SearchResult. The block is the
 * exact per-decision block the host's `run` mode writes into a results
 * file (host final selection included — the decoder never re-runs the
 * selection). Fields the wire format does not carry are NOT invented:
 * `line` contains only the root step (the format has no parent links),
 * and `lineStates` is never produced.
 */
import { BOARD_FEATURES, boardFeatures } from "./features.js";
import type { Placement } from "./board.js";
import type { SearchResult, Step } from "./search-types.js";
import type { SearchInput } from "./state.js";
import type { Weights } from "./weights.js";
import type { PieceKind } from "../../src/core/pieces.js";
import type { TspinKind } from "../../src/core/tspin.js";

export const DECISION_WORDS = 108;
export const DECISION_BYTES = DECISION_WORDS * 4;
export const WIRE_WORDS = 108;
export const WIRE_BYTES = WIRE_WORDS * 4;

/** Piece kind -> wire index (attax_search Kind discriminants). */
export const KIND_INDEX: Readonly<Record<PieceKind, number>> = {
  I: 0,
  O: 1,
  T: 2,
  S: 3,
  Z: 4,
  J: 5,
  L: 6,
};
const KIND_BY_INDEX: readonly PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];
/** Wire tspin (attax_search Tspin discriminants) -> TS TspinKind. */
const TSPIN_BY_INDEX: readonly TspinKind[] = ["none", "mini", "full"];

export function kindByIndex(index: number): PieceKind {
  const kind = KIND_BY_INDEX[index];
  if (kind === undefined) throw new Error(`gpu codec: unknown piece kind index ${index}`);
  return kind;
}

export function tspinByIndex(index: number): TspinKind {
  const tspin = TSPIN_BY_INDEX[index];
  if (tspin === undefined) throw new Error(`gpu codec: unknown tspin index ${index}`);
  return tspin;
}

/**
 * Encode one shared search input as a 108-word decision record, following
 * genfull's writer field for field. The record carries no weights, no
 * mechanism settings and no acceptRoot keys: the GPU engine's semantics
 * are the fixed config-O configuration (see gpu-player.ts, which refuses
 * any lab configuration that does not resolve to exactly that).
 */
export function encodeDecisionRecord(input: SearchInput): Uint32Array {
  if (input.board.length > 40) {
    throw new Error(`gpu codec: board has ${input.board.length} rows, the record holds 40`);
  }
  if (input.preview.length > 13) {
    throw new Error(`gpu codec: preview has ${input.preview.length} pieces, the record holds 13`);
  }
  const w = new Uint32Array(DECISION_WORDS);
  const view = new DataView(w.buffer);
  const i32 = (word: number, v: number) => view.setInt32(word * 4, v, true);
  for (let i = 0; i < 40; i++) w[i] = input.board[i] ?? 0;
  for (let i = 0; i < 40; i++) w[40 + i] = input.garbageRows?.[i] ?? 0;
  w[80] = input.board.length;
  w[81] = 1 + input.preview.length;
  w[82] = KIND_INDEX[input.active.kind];
  for (let i = 0; i < 13; i++) {
    const kind = input.preview[i];
    w[83 + i] = kind === undefined ? 0 : KIND_INDEX[kind];
  }
  i32(96, input.active.rotation);
  i32(97, input.active.x);
  i32(98, input.active.y);
  i32(99, input.hold === null ? -1 : KIND_INDEX[input.hold]);
  w[100] = input.canHold ? 1 : 0;
  i32(101, input.combo);
  i32(102, input.pending);
  // The exact chain when the input carries it (the lab always does);
  // otherwise the boolean collapses to 0/1, mirroring the search's root.
  i32(103, input.b2bChain ?? (input.b2b ? 1 : 0));
  i32(104, input.dueThisLock ?? 0);
  // Root T-slot of the untouched board, lift 0 — genfull's F_TSLOT word.
  i32(105, boardFeatures(input.board, 0).tSlot);
  const frame = input.frame ?? 0;
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error(`gpu codec: frame must be a non-negative safe integer, got ${frame}`);
  }
  view.setBigUint64(106 * 4, BigInt(frame), true);
  return w;
}

export function encodeDecisionRecordBytes(input: SearchInput): Uint8Array {
  return new Uint8Array(encodeDecisionRecord(input).buffer);
}

/** One wire node record (108 words), as written by the host's write_wire_record. */
export interface WireNode {
  readonly board: Uint16Array;
  readonly garbage: Uint8Array;
  readonly hold: PieceKind | null;
  readonly next: number;
  readonly b2bChain: number;
  readonly combo: number;
  readonly pending: number;
  readonly lift: number;
  readonly tslot: number;
  readonly rewardBits: bigint;
  readonly valueBits: bigint;
  readonly dead: boolean;
  readonly root: number;
  readonly depth: number;
  readonly step: {
    readonly placement: Placement;
    readonly usedHold: boolean;
    readonly lines: number;
    readonly attack: number;
    readonly rewardBits: bigint;
  } | null;
  readonly boardLen: number;
  readonly dueThisLock: number;
}

export interface ParsedBlock {
  readonly status: number;
  /** The chosen root step's placement fields, before step-stat reconstruction. */
  readonly best: {
    readonly placement: Placement;
    readonly usedHold: boolean;
    readonly valueBits: bigint;
  } | null;
  readonly valueBits: bigint;
  readonly nodes: bigint;
  readonly depth: number;
  readonly candidates: readonly {
    readonly placement: Placement;
    readonly usedHold: boolean;
    readonly valueBits: bigint;
  }[];
  readonly plies: readonly {
    readonly beam: readonly WireNode[];
    readonly finished: readonly WireNode[];
  }[];
  readonly wallMs: number;
  readonly gpuMs: number;
}

function parseWireNode(view: DataView, offset: number): WireNode {
  const u32 = (word: number) => view.getUint32(offset + word * 4, true);
  const i32 = (word: number) => view.getInt32(offset + word * 4, true);
  const board = new Uint16Array(40);
  for (let i = 0; i < 40; i++) board[i] = u32(i) & 0xffff;
  const garbage = new Uint8Array(40);
  for (let i = 0; i < 40; i++) garbage[i] = u32(40 + i) & 0xff;
  const holdRaw = i32(80);
  const stepPresent = u32(94) !== 0;
  return {
    board,
    garbage,
    hold: holdRaw < 0 ? null : kindByIndex(holdRaw),
    next: u32(81),
    b2bChain: i32(82),
    combo: i32(83),
    pending: i32(84),
    lift: i32(85),
    tslot: i32(86),
    rewardBits: view.getBigUint64(offset + 87 * 4, true),
    valueBits: view.getBigUint64(offset + 89 * 4, true),
    dead: u32(91) !== 0,
    root: i32(92),
    depth: u32(93),
    step: stepPresent
      ? {
          placement: {
            kind: kindByIndex(i32(95)),
            rotation: i32(96),
            x: i32(97),
            y: i32(98),
            lastSrs: i32(99),
            tspin: tspinByIndex(i32(100)),
          },
          usedHold: u32(101) !== 0,
          lines: u32(102),
          attack: i32(103),
          rewardBits: view.getBigUint64(offset + 104 * 4, true),
        }
      : null,
    boardLen: u32(106),
    dueThisLock: i32(107),
  };
}

function parseStepHead(
  view: DataView,
  offset: number,
): { placement: Placement; usedHold: boolean; valueBits: bigint } {
  const i32 = (word: number) => view.getInt32(offset + word * 4, true);
  return {
    placement: {
      kind: kindByIndex(i32(0)),
      rotation: i32(1),
      x: i32(2),
      y: i32(3),
      lastSrs: i32(4),
      tspin: tspinByIndex(i32(5)),
    },
    usedHold: view.getUint32(offset + 6 * 4, true) !== 0,
    valueBits: view.getBigUint64(offset + 7 * 4, true),
  };
}

/**
 * Parse one serve response block (the bytes after the serve header).
 * Throws on truncation or an unknown status; status 1 parses to a null
 * best (the host's zero-filled shape), status 2 throws here because a
 * kernel error must never be mistaken for a result.
 */
export function parseServeBlock(block: Uint8Array): ParsedBlock {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  if (block.byteLength < 4) throw new Error("gpu codec: serve block shorter than a status word");
  const status = view.getUint32(0, true);
  if (status === 2) throw new Error("gpu engine: kernel error (serve status 2)");
  if (status !== 0 && status !== 1) {
    throw new Error(`gpu codec: unknown serve status ${status}`);
  }
  // Both shapes carry: status, best head (6 i32 + hold + value + nodes +
  // depth), candidate count, ply count, then the 4-f64 timing trailer.
  // Status 1 is the zero-filled shape with both counts 0.
  const head = parseStepHead(view, 4);
  const valueBits = view.getBigUint64(4 + 7 * 4, true);
  const nodes = view.getBigUint64(4 + 9 * 4, true);
  const depth = view.getUint32(4 + 11 * 4, true);
  let off = 4 + 12 * 4;
  const nCand = view.getUint32(off, true);
  off += 4;
  const candidates: ParsedBlock["candidates"][number][] = [];
  for (let i = 0; i < nCand; i++) {
    candidates.push(parseStepHead(view, off));
    off += 9 * 4; // candidate entry: 6 i32 + used_hold u32 + value u64 = 36 bytes
  }
  const nPlies = view.getUint32(off, true);
  off += 4;
  const plies: ParsedBlock["plies"][number][] = [];
  for (let p = 0; p < nPlies; p++) {
    const nBeam = view.getUint32(off, true);
    off += 4;
    const beam: WireNode[] = [];
    for (let i = 0; i < nBeam; i++) {
      beam.push(parseWireNode(view, off));
      off += WIRE_BYTES;
    }
    const nFin = view.getUint32(off, true);
    off += 4;
    const finished: WireNode[] = [];
    for (let i = 0; i < nFin; i++) {
      finished.push(parseWireNode(view, off));
      off += WIRE_BYTES;
    }
    plies.push({ beam, finished });
  }
  if (off + 32 > block.byteLength) {
    throw new Error(
      `gpu codec: serve block truncated (parsed to ${off}, need 32 more, have ${block.byteLength})`,
    );
  }
  const wallMs = view.getFloat64(off, true);
  const gpuMs = view.getFloat64(off + 8, true);
  if (off + 32 !== block.byteLength) {
    throw new Error(
      `gpu codec: serve block length mismatch (parsed ${off + 32} of ${block.byteLength} bytes)`,
    );
  }
  return {
    status,
    best: status === 0 ? head : null,
    valueBits,
    nodes,
    depth,
    candidates,
    plies,
    wallMs,
    gpuMs,
  };
}

function stepKey(placement: Placement, usedHold: boolean): string {
  return `${placement.kind}:${placement.rotation}:${placement.x}:${placement.y}:${placement.lastSrs}:${placement.tspin}:${usedHold}`;
}

/**
 * The depth-1 node created by a root step: it sits in ply 0's beam (it
 * was expanded) or in ply 0's finished list (it terminated immediately).
 * Every leaf's root ancestor is in exactly one of the two, so the best
 * line's first node is always findable. Throws when absent — by the
 * argument above that means the block is not a well-formed GPU result.
 */
export function firstNodeOf(
  parsed: ParsedBlock,
  placement: Placement,
  usedHold: boolean,
): WireNode {
  const ply0 = parsed.plies[0];
  if (!ply0) throw new Error("gpu codec: result block carries no plies");
  const key = stepKey(placement, usedHold);
  for (const node of [...ply0.beam, ...ply0.finished]) {
    if (node.depth === 1 && node.step && stepKey(node.step.placement, node.step.usedHold) === key) {
      return node;
    }
  }
  throw new Error(`gpu codec: no depth-1 node for root step ${key}`);
}

const bitsView = new DataView(new ArrayBuffer(8));
export function f64FromBits(bits: bigint): number {
  bitsView.setBigUint64(0, bits, true);
  return bitsView.getFloat64(0, true);
}

/**
 * Build the lab's SearchResult from a parsed block for the given root
 * step (normally the block's own best; the driver substitutes another
 * candidate when an acceptRoot witness filters the best out).
 * `line` is [best] only: the wire format carries no parent links, so
 * the deeper steps of the best line are not transmitted (the Rust/TS
 * results the lab historically consumed carried the full line — see
 * the lab-driver record for the consumer impact).
 */
export function resultForRootStep(
  parsed: ParsedBlock,
  placement: Placement,
  usedHold: boolean,
  valueBits: bigint,
  weights: Weights,
): SearchResult {
  const first = firstNodeOf(parsed, placement, usedHold);
  const step = first.step as NonNullable<WireNode["step"]>;
  const best: Step = {
    placement,
    usedHold,
    linesCleared: step.lines,
    attack: step.attack,
    reward: f64FromBits(step.rewardBits),
  };
  const boardLen = first.boardLen > 0 ? first.boardLen : 40;
  const features = boardFeatures(first.board.subarray(0, boardLen), first.lift);
  const breakdown = Object.fromEntries(
    BOARD_FEATURES.map((f) => [f, features[f] * weights.board[f]]),
  );
  return {
    best,
    line: [best],
    value: f64FromBits(valueBits),
    breakdown,
    candidates: parsed.candidates.map((c) => ({
      placement: c.placement,
      usedHold: c.usedHold,
      value: f64FromBits(c.valueBits),
    })),
    nodes: Number(parsed.nodes),
    depth: parsed.depth,
  };
}

/** Decode a whole serve block into a SearchResult (null when no move exists). */
export function decodeServeBlock(block: Uint8Array, weights: Weights): SearchResult | null {
  const parsed = parseServeBlock(block);
  if (parsed.status === 1 || !parsed.best) return null;
  return resultForRootStep(
    parsed,
    parsed.best.placement,
    parsed.best.usedHold,
    parsed.best.valueBits,
    weights,
  );
}
