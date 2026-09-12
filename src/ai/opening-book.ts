// A small, safe opening book for DeepSeek v2.
//
// The book only ever engages in the true opening: an empty board on the very
// first decision, no hold used yet, no pending garbage.  It looks up the exact
// seven first-bag pieces in `OPENING_BOOK_DATA` and, if present, replays a
// precomputed PCO (Perfect Clear Opener) assembly as faithful `placeAt`/hold
// moves.  Every step is validated against the live snapshot (board, active
// piece, hold, canHold); any deviation permanently disables the book for the
// match so the normal v2 search takes over.  A broken or unsupported line can
// therefore never make v2 play an illegal or off-plan move.
import { type Board, cloneBoard } from "../core/board.js";
import { bottomCellsOf, cellsFor, type PieceKind } from "../core/pieces.js";
import type { AiExecutionPlan, AiExecutionStep, AiMove, GameSnapshot } from "../ui/types.js";
import { OPENING_BOOK_DATA } from "./opening-book-data.js";
import { ROWS } from "./types.js";

const BOARD_ROWS = ROWS;
const PREFIX_PIECES = 7;
const MAX_BOOK_PIECES = 12;

interface PlaceAction {
  readonly kind: "place";
  readonly piece: PieceKind;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
}
interface HoldAction {
  readonly kind: "hold";
}
type BookAction = PlaceAction | HoldAction;

interface BookEntry {
  readonly name: string;
  readonly actions: readonly BookAction[];
}

const PIECE_KINDS: readonly PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

function isPieceKind(value: string | undefined): value is PieceKind {
  return value !== undefined && (PIECE_KINDS as readonly string[]).includes(value);
}

function decodeActions(encoded: string): readonly BookAction[] {
  const actions: BookAction[] = [];
  let index = 0;
  while (index < encoded.length) {
    const char = encoded[index];
    if (char === "h") {
      actions.push({ kind: "hold" });
      index += 1;
      continue;
    }
    const piece = encoded[index];
    const rotation = Number(encoded[index + 1]);
    const xCode = encoded[index + 2];
    const y = Number(encoded[index + 3]);
    if (
      !isPieceKind(piece) ||
      xCode === undefined ||
      !Number.isInteger(rotation) ||
      !Number.isInteger(y)
    ) {
      return [];
    }
    actions.push({
      kind: "place",
      piece,
      rotation,
      x: Number.parseInt(xCode, 36) - 2,
      y,
    });
    index += 4;
  }
  return actions;
}

function lookupEntry(key: string): BookEntry | null {
  const encoded = OPENING_BOOK_DATA[key];
  if (encoded === undefined) return null;
  const actions = decodeActions(encoded);
  if (actions.length === 0) return null;
  return { name: key, actions };
}

function maxNativeY(kind: PieceKind, rotation: number): number {
  let max = 0;
  for (const cell of cellsFor(kind, rotation)) if (cell.y > max) max = cell.y;
  return max;
}

export function bookBoardFingerprint(board: Board): string {
  let out = "";
  for (let y = 0; y < BOARD_ROWS; y += 1) {
    if (y > 0) out += ",";
    out += (board[y] ?? 0) & 0x3ff;
  }
  return out;
}

function isEmptyBoard(board: Board): boolean {
  for (let y = 0; y < BOARD_ROWS; y += 1) if ((board[y] ?? 0) !== 0) return false;
  return true;
}

function applyPlacement(board: Board, action: PlaceAction): number {
  const cells = bottomCellsOf(action.piece, action.rotation);
  let gained = 0;
  const temp = cloneBoard(board);
  // Mirror core/board.lockAndClear: set the cells, then collapse full rows.
  for (const cell of cells) {
    const x = action.x + cell.x;
    const y = action.y + cell.y;
    if (x < 0 || x >= 10 || y < 0 || y >= BOARD_ROWS) continue;
    temp[y] = (temp[y] ?? 0) | (1 << x);
  }
  const kept: number[] = [];
  for (let y = 0; y < BOARD_ROWS; y += 1) {
    const row = temp[y] ?? 0;
    if (row === 0x3ff) {
      gained += 1;
    } else {
      kept.push(row);
    }
  }
  for (let y = 0; y < BOARD_ROWS; y += 1) {
    temp[y] = kept[y] ?? 0;
  }
  for (let y = 0; y < BOARD_ROWS; y += 1) board[y] = temp[y] ?? 0;
  return gained;
}

interface Commitment {
  readonly name: string;
  readonly actions: readonly BookAction[];
  step: number;
  readonly board: Board;
  active: PieceKind | null;
  hold: PieceKind | null;
  canHold: boolean;
  readonly queue: readonly PieceKind[];
  head: number;
}

export interface OpeningBook {
  /** Returns a book move when the opener applies, otherwise null (search takes over). */
  next(snapshot: GameSnapshot, board: Board): AiMove | null;
  /** Name of the opener that produced the most recent book move, or null. */
  lastOpener(): string | null;
  reset(): void;
}

export function createOpeningBook(): OpeningBook {
  let commitment: Commitment | null = null;
  let disabled = false;
  let openerName: string | null = null;

  const abort = (): void => {
    commitment = null;
    disabled = true;
  };

  const spawnNext = (state: Commitment): PieceKind | null => {
    const piece = state.queue[state.head];
    state.head += 1;
    return piece ?? null;
  };

  const buildExecution = (
    board: Board,
    action: PlaceAction,
    snapshot: GameSnapshot,
  ): AiExecutionPlan | null => {
    const after = cloneBoard(board);
    const cleared = applyPlacement(after, action);
    if (cleared !== 0) return null;
    const topRow = BOARD_ROWS - 1 - maxNativeY(action.piece, action.rotation) - action.y;
    if (topRow < 0 || topRow >= BOARD_ROWS) return null;
    const steps: readonly AiExecutionStep[] = [
      {
        kind: "placeAt",
        rotation: action.rotation,
        x: action.x,
        topRow,
        lastSrs: 0,
      },
    ];
    const active = snapshot.active;
    if (active === null) return null;
    return {
      targetX: action.x,
      targetRotation: action.rotation,
      steps,
      expectedBoard: Array.from(after),
      expectedLinesCleared: 0,
      sourceActiveKind: active.kind,
      sourceRotation: active.rotation,
      sourceX: active.posX,
      sourceBoardFingerprint: bookBoardFingerprint(board),
      sourceHold: snapshot.hold,
      sourceCanHold: snapshot.canHold,
    };
  };

  return {
    lastOpener: () => openerName,
    reset: () => {
      commitment = null;
      disabled = false;
      openerName = null;
    },
    next: (snapshot, board) => {
      if (disabled) return null;
      const active = snapshot.active;
      if (active === null || snapshot.gameOver) return null;
      if (snapshot.pendingGarbage > 0) {
        abort();
        return null;
      }
      if (commitment === null) {
        if (
          !isEmptyBoard(board) ||
          snapshot.lines !== 0 ||
          snapshot.hold !== null ||
          !snapshot.canHold ||
          snapshot.next.length < PREFIX_PIECES - 1
        ) {
          disabled = true;
          return null;
        }
        const key = [active.kind, ...snapshot.next.slice(0, PREFIX_PIECES - 1)].join("");
        const entry = lookupEntry(key);
        if (entry === null) {
          disabled = true;
          return null;
        }
        commitment = {
          name: entry.name,
          actions: entry.actions,
          step: 0,
          board: cloneBoard(board),
          active: active.kind,
          hold: null,
          canHold: true,
          queue: [active.kind, ...snapshot.next],
          head: 1,
        };
      }
      const state = commitment;
      if (state === null) return null;
      if (bookBoardFingerprint(state.board) !== bookBoardFingerprint(board)) {
        abort();
        return null;
      }
      if (
        active.kind !== state.active ||
        snapshot.hold !== state.hold ||
        snapshot.canHold !== state.canHold
      ) {
        abort();
        return null;
      }
      const action = state.actions[state.step];
      if (action === undefined) {
        disabled = true;
        return null;
      }
      if (action.kind === "hold") {
        if (!state.canHold) {
          abort();
          return null;
        }
        openerName = state.name;
        if (state.hold === null) {
          state.hold = state.active;
          state.active = spawnNext(state);
          state.canHold = false;
        } else {
          const previous = state.hold;
          state.hold = state.active;
          state.active = previous;
          state.canHold = false;
        }
        state.step += 1;
        if (state.step >= state.actions.length) disabled = true;
        return { targetX: active.posX, targetRotation: active.rotation, useHold: true };
      }
      if (state.active !== action.piece) {
        abort();
        return null;
      }
      const execution = buildExecution(board, action, snapshot);
      if (execution === null) {
        abort();
        return null;
      }
      openerName = state.name;
      applyPlacement(state.board, action);
      state.active = spawnNext(state);
      state.canHold = true;
      state.step += 1;
      if (state.step >= state.actions.length || state.step > MAX_BOOK_PIECES) disabled = true;
      return {
        targetX: action.x,
        targetRotation: action.rotation,
        useHold: false,
        execution,
      };
    },
  };
}
