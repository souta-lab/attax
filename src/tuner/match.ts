// Deterministic versus match runner + aggregation for the tuner and gate.
//
// Mirrors scripts/hoiko-gate.ts (TICK_MS=16, MAX_TICKS=12000, fresh fighters
// per seed) but lives in a new file so the reference gate stays untouched and
// can be imported by the worker without executing the gate's main().

import type { GameSnapshot } from "../ui/types.js";
import { resolveVersusConfig } from "../versus/config.js";
import {
  createVersusController,
  type SideState,
  VERSUS_DEFAULTS,
  type VersusFighter,
} from "../versus/controller.js";

export const TUNER_TICK_MS = 16;
export const TUNER_MAX_TICKS = 12000;

export type MatchWinner = "left" | "right" | "draw" | "cap";

export interface SideMetrics {
  readonly lines: number;
  readonly sent: number;
  readonly tsd: number;
  readonly tetris: number;
  readonly maxPending: number;
  readonly maxHeight: number;
  readonly holes: number;
  readonly executionSourceMismatches: number;
  readonly executionExpectedBoardFailures: number;
}

export interface MatchOutcome {
  readonly seed: number;
  readonly winner: MatchWinner;
  readonly reason: string;
  readonly ticks: number;
  readonly pieces: number;
  readonly left: SideMetrics;
  readonly right: SideMetrics;
}

interface MutableMetrics {
  lines: number;
  sent: number;
  tsd: number;
  tetris: number;
  maxPending: number;
  maxHeight: number;
  holes: number;
  executionSourceMismatches: number;
  executionExpectedBoardFailures: number;
  previousLines: number;
}

function freshMetrics(): MutableMetrics {
  return {
    lines: 0,
    sent: 0,
    tsd: 0,
    tetris: 0,
    maxPending: 0,
    maxHeight: 0,
    holes: 0,
    executionSourceMismatches: 0,
    executionExpectedBoardFailures: 0,
    previousLines: 0,
  };
}

function stackHeight(grid: GameSnapshot["board"]["grid"]): number {
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    if (grid[rowIndex]?.some((cell) => cell !== 0) === true) return grid.length - rowIndex;
  }
  return 0;
}

function countHoles(grid: GameSnapshot["board"]["grid"]): number {
  let holes = 0;
  for (let column = 0; column < 10; column += 1) {
    let blockSeen = false;
    for (const row of grid) {
      const filled = (row?.[column] ?? 0) !== 0;
      if (filled) blockSeen = true;
      else if (blockSeen) holes += 1;
    }
  }
  return holes;
}

function sampleSide(side: SideState, metrics: MutableMetrics): void {
  const snapshot = side.core.getSnapshot();
  const debug = side.fighter.getDebug?.() ?? null;
  metrics.lines = snapshot.lines;
  metrics.sent = side.sentTotal;
  metrics.maxPending = Math.max(metrics.maxPending, snapshot.pendingGarbage);
  metrics.maxHeight = Math.max(metrics.maxHeight, stackHeight(snapshot.board.grid));
  metrics.holes = Math.max(metrics.holes, countHoles(snapshot.board.grid));
  metrics.executionSourceMismatches = side.executionSourceMismatches;
  metrics.executionExpectedBoardFailures = side.executionExpectedBoardFailures;
  if (snapshot.lines > metrics.previousLines) {
    if (debug?.isTspin === true && debug.linesCleared === 2) metrics.tsd += 1;
    if (debug?.linesCleared === 4) metrics.tetris += 1;
  }
  metrics.previousLines = snapshot.lines;
}

function finishMetrics(side: SideState, metrics: MutableMetrics): SideMetrics {
  sampleSide(side, metrics);
  const snapshot = side.core.getSnapshot();
  return {
    lines: snapshot.lines,
    sent: side.sentTotal,
    tsd: metrics.tsd,
    tetris: metrics.tetris,
    maxPending: metrics.maxPending,
    maxHeight: metrics.maxHeight,
    holes: metrics.holes,
    executionSourceMismatches: side.executionSourceMismatches,
    executionExpectedBoardFailures: side.executionExpectedBoardFailures,
  };
}

export function runTunerMatch(
  seed: number,
  left: VersusFighter,
  right: VersusFighter,
  maxTicks: number = TUNER_MAX_TICKS,
): MatchOutcome {
  const controller = createVersusController(left, right, seed, resolveVersusConfig());
  const leftMetrics = freshMetrics();
  const rightMetrics = freshMetrics();
  let ticks = 0;
  while (controller.result === null && ticks < maxTicks) {
    controller.tick(TUNER_TICK_MS, VERSUS_DEFAULTS);
    ticks += 1;
    sampleSide(controller.left, leftMetrics);
    sampleSide(controller.right, rightMetrics);
  }
  const result = controller.result;
  return {
    seed,
    winner: result?.winner ?? "cap",
    reason: result?.reason ?? "max-ticks",
    ticks,
    pieces: result?.pieces ?? controller.pieces,
    left: finishMetrics(controller.left, leftMetrics),
    right: finishMetrics(controller.right, rightMetrics),
  };
}

export interface GateSummary {
  readonly matches: number;
  readonly leftWins: number;
  readonly rightWins: number;
  readonly draws: number;
  readonly caps: number;
  /** Win rate over decisive matches only? No: over all matches, draws/caps count 0.5. */
  readonly winRate: number;
  readonly ticks: number;
  readonly pieces: number;
  readonly left: SideMetrics;
  readonly right: SideMetrics;
}

function sumSides(rows: readonly MatchOutcome[], key: "left" | "right"): SideMetrics {
  const total = freshMetrics();
  for (const row of rows) {
    const side = row[key];
    total.lines += side.lines;
    total.sent += side.sent;
    total.tsd += side.tsd;
    total.tetris += side.tetris;
    total.maxPending += side.maxPending;
    total.maxHeight += side.maxHeight;
    total.holes += side.holes;
    total.executionSourceMismatches += side.executionSourceMismatches;
    total.executionExpectedBoardFailures += side.executionExpectedBoardFailures;
  }
  return {
    lines: total.lines,
    sent: total.sent,
    tsd: total.tsd,
    tetris: total.tetris,
    maxPending: total.maxPending,
    maxHeight: total.maxHeight,
    holes: total.holes,
    executionSourceMismatches: total.executionSourceMismatches,
    executionExpectedBoardFailures: total.executionExpectedBoardFailures,
  };
}

export function summarize(rows: readonly MatchOutcome[]): GateSummary {
  let leftWins = 0;
  let rightWins = 0;
  let draws = 0;
  let caps = 0;
  for (const row of rows) {
    if (row.winner === "left") leftWins += 1;
    else if (row.winner === "right") rightWins += 1;
    else if (row.winner === "draw") draws += 1;
    else caps += 1;
  }
  const matches = rows.length;
  return {
    matches,
    leftWins,
    rightWins,
    draws,
    caps,
    winRate: matches === 0 ? 0 : (leftWins + 0.5 * (draws + caps)) / matches,
    ticks: rows.reduce((total, row) => total + row.ticks, 0),
    pieces: rows.reduce((total, row) => total + row.pieces, 0),
    left: sumSides(rows, "left"),
    right: sumSides(rows, "right"),
  };
}

/**
 * Scalar fitness for evolution. The decisive win count is the primary term, so a
 * single additional win always beats any amount of the attack-differential
 * tie-break (which only orders candidates whose win/loss record ties).
 */
export function fitnessOf(summary: GateSummary): number {
  const primary = summary.leftWins * 2 + summary.draws + summary.caps;
  const sentDiff = (summary.left.sent - summary.right.sent) / Math.max(1, summary.matches);
  const tiebreak = Math.min(0.9, Math.max(-0.9, sentDiff * 0.3));
  return primary + tiebreak;
}

export function winLossCap(summary: GateSummary): string {
  return `${summary.leftWins}-${summary.rightWins}-${summary.draws}/${summary.caps}`;
}
