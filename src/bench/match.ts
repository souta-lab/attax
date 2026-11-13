/**
 * Headless versus match: the exact controller, rules and timing the browser uses, stepped
 * with a fixed 16 ms tick. Both sides draw pieces from the same seed.
 */
import type { LockAction } from "../core/types.js";
import { resolveVersusConfig } from "../versus/config.js";
import {
  createVersusController,
  type SideState,
  VERSUS_DEFAULTS,
  type VersusFighter,
} from "../versus/controller.js";

export const TICK_MS = 16;
export const MAX_TICKS = 12000;

export interface SideRecord {
  readonly fighter: string;
  readonly lines: number;
  readonly sent: number;
  readonly locks: number;
  readonly tspins: number;
  readonly quads: number;
  readonly perfectClears: number;
  readonly maxHeight: number;
  readonly thinkMs: number;
  readonly decisions: number;
}

export interface MatchRecord {
  readonly seed: number;
  readonly winner: "left" | "right" | "draw" | "cap";
  readonly ticks: number;
  readonly left: SideRecord;
  readonly right: SideRecord;
}

interface Tally {
  tspins: number;
  quads: number;
  perfectClears: number;
  maxHeight: number;
  lockId: number;
}

function stackHeight(side: SideState): number {
  const grid = side.core.getSnapshot().board.grid;
  for (let row = 0; row < grid.length; row += 1) {
    if (grid[row]?.some((cell) => cell !== 0) === true) return grid.length - row;
  }
  return 0;
}

const TSPIN_ACTIONS: ReadonlySet<LockAction> = new Set(["Tss", "Tsd", "Tst", "Tsm"]);

function observe(side: SideState, tally: Tally): void {
  const transition = side.core.getLastLockTransition();
  if (transition === null || transition.lockId === tally.lockId) return;
  tally.lockId = transition.lockId;
  if (TSPIN_ACTIONS.has(transition.action)) tally.tspins += 1;
  if (transition.action === "Quad") tally.quads += 1;
  if (transition.action === "Pc") tally.perfectClears += 1;
  tally.maxHeight = Math.max(tally.maxHeight, stackHeight(side));
}

function record(side: SideState, tally: Tally): SideRecord {
  const snapshot = side.core.getSnapshot();
  return {
    fighter: side.fighter.name,
    lines: snapshot.lines,
    sent: side.sentTotal,
    locks: snapshot.lockId,
    tspins: tally.tspins,
    quads: tally.quads,
    perfectClears: tally.perfectClears,
    maxHeight: tally.maxHeight,
    thinkMs: Math.round(side.thinkMs),
    decisions: side.thinkCount,
  };
}

export function runMatch(
  left: VersusFighter,
  right: VersusFighter,
  seed: number,
  maxTicks = MAX_TICKS,
): MatchRecord {
  const controller = createVersusController(left, right, seed, resolveVersusConfig());
  const tallies = [0, 1].map(() => ({ tspins: 0, quads: 0, perfectClears: 0, maxHeight: 0, lockId: 0 }));
  let ticks = 0;
  while (controller.result === null && ticks < maxTicks) {
    controller.tick(TICK_MS, VERSUS_DEFAULTS);
    ticks += 1;
    observe(controller.left, tallies[0] as Tally);
    observe(controller.right, tallies[1] as Tally);
  }
  return {
    seed,
    winner: controller.result?.winner ?? "cap",
    ticks,
    left: record(controller.left, tallies[0] as Tally),
    right: record(controller.right, tallies[1] as Tally),
  };
}
