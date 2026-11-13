/**
 * Adapter between a game snapshot and the bot's search: reads the board, queue, hold and
 * garbage state, searches, and answers with a single `placeAt` (rotation, x, row, lastSrs)
 * that the engine validates on lock — the same execution contract the Hoiko adapter uses.
 */

import type { AiMove, GameSnapshot } from "../../core/types.js";
import { boardFingerprint, type VersusFighter } from "../../versus/controller.js";
import { type BitBoard, ROWS } from "./movegen.js";
import { type SearchResult, search } from "./search.js";
import { DEFAULT_WEIGHTS, type Weights } from "./weights.js";

export interface BotOptions {
  /** Preview pieces the bot may look at (guideline display shows 5). */
  readonly preview?: number;
  /** Beam width. */
  readonly width?: number;
  readonly weights?: Weights;
  readonly name?: string;
}

export const BOT_DEFAULTS = { preview: 5, width: 48 } as const;

export interface BotFighter extends VersusFighter {
  /** The last completed search, for the "watch it think" view. */
  lastSearch(): SearchResult | null;
}

export function snapshotBoard(snapshot: GameSnapshot): BitBoard {
  const board = new Uint16Array(ROWS);
  for (let row = 0; row < ROWS; row += 1) {
    const cells = snapshot.board.grid[row];
    if (cells === undefined) continue;
    let bits = 0;
    for (let x = 0; x < cells.length; x += 1) if (cells[x] !== 0) bits |= 1 << x;
    board[row] = bits;
  }
  return board;
}

export function createBot(options: BotOptions = {}): BotFighter {
  const preview = options.preview ?? BOT_DEFAULTS.preview;
  const width = options.width ?? BOT_DEFAULTS.width;
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  let last: SearchResult | null = null;

  return {
    name: options.name ?? "bot",
    color: "#2f6fed",
    reset() {
      last = null;
    },
    lastSearch: () => last,
    findBestMove(snapshot: GameSnapshot): AiMove | null {
      const active = snapshot.active;
      if (active === null || snapshot.gameOver) return null;
      const result = search(
        {
          board: snapshotBoard(snapshot),
          active: { kind: active.kind, rotation: active.rotation, x: active.posX, y: active.posY },
          hold: snapshot.hold,
          canHold: snapshot.canHold,
          preview: snapshot.next.slice(0, preview),
          b2b: snapshot.b2b,
          combo: snapshot.combo,
          pending: snapshot.pendingGarbage,
        },
        { weights, width },
      );
      last = result;
      if (result === null) return null;
      const { placement, usedHold } = result.best;
      if (usedHold) {
        return { targetX: placement.x, targetRotation: placement.rotation, useHold: true };
      }
      return {
        targetX: placement.x,
        targetRotation: placement.rotation,
        useHold: false,
        execution: {
          targetX: placement.x,
          targetRotation: placement.rotation,
          steps: [
            {
              kind: "placeAt",
              rotation: placement.rotation,
              x: placement.x,
              topRow: placement.y,
              lastSrs: placement.lastSrs,
            },
          ],
          expectedBoard: [],
          expectedLinesCleared: result.best.linesCleared,
          sourceActiveKind: active.kind,
          sourceRotation: active.rotation,
          sourceX: active.posX,
          sourceBoardFingerprint: boardFingerprint(snapshot),
          sourceHold: snapshot.hold,
          sourceCanHold: snapshot.canHold,
        },
      };
    },
  };
}
