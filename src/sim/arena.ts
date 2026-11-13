/**
 * The live arena: the bot and Hoiko on one seed, stepped with the benchmark's fixed 16 ms
 * tick so a game watched in the browser is move-for-move the game the benchmark recorded.
 * Pure — no DOM; the web worker drives it and posts `ArenaFrame`s to the page.
 */
import type { BotFighter } from "../ai/bot/fighter.js";
import type { Placement } from "../ai/bot/movegen.js";
import { cellsFor, type PieceKind } from "../core/pieces.js";
import type { CellValue, LockAction } from "../core/types.js";
import { resolveVersusConfig } from "../versus/config.js";
import {
  createVersusController,
  type SideState,
  VERSUS_DEFAULTS,
  type VersusController,
  type VersusFighter,
} from "../versus/controller.js";

export const TICK_MS = 16;

export type Side = "left" | "right";

export interface Ghost {
  readonly cells: readonly (readonly [number, number])[];
  readonly value: number;
}

export interface Thinking {
  /** Best first moves the bot considered, best first (cells in engine grid coordinates). */
  readonly candidates: readonly Ghost[];
  /** Weighted shape terms of the board after the chosen move. */
  readonly breakdown: Readonly<Record<string, number>>;
  readonly nodes: number;
  readonly depth: number;
}

export interface SideFrame {
  readonly name: string;
  readonly grid: readonly (readonly CellValue[])[];
  readonly active: {
    readonly kind: PieceKind;
    readonly cells: readonly (readonly [number, number])[];
  } | null;
  readonly hold: PieceKind | null;
  readonly next: readonly PieceKind[];
  readonly pieces: number;
  readonly lines: number;
  readonly sent: number;
  readonly pending: number;
  readonly combo: number;
  readonly b2b: boolean;
  readonly lastAction: LockAction;
  readonly lastAttack: number;
  readonly msPerMove: number;
  readonly gameOver: boolean;
  readonly thinking: Thinking | null;
}

export interface ArenaFrame {
  readonly seed: number;
  readonly ticks: number;
  readonly left: SideFrame;
  readonly right: SideFrame;
  readonly winner: Side | "draw" | null;
}

function placementCells(p: Placement): [number, number][] {
  return cellsFor(p.kind, p.rotation).map((c) => [p.x + c.x, p.y + c.y]);
}

function sideFrame(side: SideState, bot: BotFighter | null): SideFrame {
  const s = side.core.getSnapshot();
  const search = bot?.lastSearch() ?? null;
  const active = s.active;
  return {
    name: side.fighter.name,
    grid: s.board.grid,
    active:
      active === null
        ? null
        : {
            kind: active.kind,
            cells: active.cells.map((c) => [active.posX + c.x, active.posY + c.y] as const),
          },
    hold: s.hold,
    next: s.next.slice(0, 5),
    pieces: s.lockId,
    lines: s.lines,
    sent: side.sentTotal,
    pending: s.pendingGarbage,
    combo: Math.max(0, s.combo),
    b2b: s.b2b,
    lastAction: s.lastAction,
    lastAttack: s.lastRawAttack,
    msPerMove: side.thinkCount > 0 ? side.thinkMs / side.thinkCount : 0,
    gameOver: s.gameOver,
    thinking:
      search === null
        ? null
        : {
            candidates: search.candidates
              .slice(0, 3)
              .map((c) => ({ cells: placementCells(c.placement), value: c.value })),
            breakdown: search.breakdown,
            nodes: search.nodes,
            depth: search.depth,
          },
  };
}

export interface Arena {
  readonly seed: number;
  /** Advance by whole 16 ms ticks; returns false once the match is decided. */
  step(ticks: number): boolean;
  frame(): ArenaFrame;
}

/**
 * `botSide` chooses where the bot sits; the benchmark plays every seed from both sides,
 * and replaying a recorded game needs the same seating.
 */
export function createArena(
  bot: BotFighter,
  hoiko: VersusFighter,
  seed: number,
  botSide: Side = "left",
): Arena {
  const controller: VersusController =
    botSide === "left"
      ? createVersusController(bot, hoiko, seed, resolveVersusConfig())
      : createVersusController(hoiko, bot, seed, resolveVersusConfig());
  let ticks = 0;
  return {
    seed,
    step(n: number): boolean {
      for (let i = 0; i < n && controller.result === null; i += 1) {
        controller.tick(TICK_MS, VERSUS_DEFAULTS);
        ticks += 1;
      }
      return controller.result === null;
    },
    frame(): ArenaFrame {
      return {
        seed,
        ticks,
        left: sideFrame(controller.left, botSide === "left" ? bot : null),
        right: sideFrame(controller.right, botSide === "right" ? bot : null),
        winner: controller.result?.winner ?? null,
      };
    },
  };
}
